import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config, resolvePath } from '../config.js';
import { readJsonFile, writeJsonFile } from '../utils/json-file.js';

// Files MCP clients upload (POST or PUT /uploads) to attach to slack_send_message:
// images, videos, PDFs and plain-text files such as logs. The bytes stream from the
// client's shell to disk, never through the model: the client gets an upload_id and
// passes that to the tool. An upload belongs to the client that made it, can be
// attached once, and expires; only real images, videos and PDFs (checked by their
// first bytes) and valid UTF-8 text (checked as it streams) are kept.
// Whoever takes an upload owns its file and must delete it (deleteUploadFile)
// once it is posted or dropped; a sweep removes anything left behind.
// The list of waiting uploads is saved next to them, so a restart or deploy keeps them.

const UPLOAD_DIR = join(resolvePath(config.dataDir), 'uploads');
/** Waiting uploads, outside UPLOAD_DIR so the sweep never counts or removes it. */
const INDEX_FILE = join(resolvePath(config.dataDir), 'mcp-uploads.json');
/** How long an upload waits to be attached. */
export const UPLOAD_TTL_SEC = 60 * 60;
/** Files older than this are removed whatever holds them (upload TTL + the 30-minute approval window, with margin). */
const ORPHAN_AGE_MS = 2 * 60 * 60 * 1000;
/** Bytes needed to recognise a format. */
const SNIFF_BYTES = 64;

/** Per-file and total limits, from config (mcp.maxUploadMb, mcp.maxUploadTotalMb). */
export const maxUploadBytes = () => config.mcp.maxUploadMb * 1024 * 1024;
const maxTotalBytes = () => config.mcp.maxUploadTotalMb * 1024 * 1024;

/**
 * @typedef {Object} Upload
 * @property {string} id
 * @property {string} owner - MCP client name
 * @property {string} path - file on disk
 * @property {number} size - bytes
 * @property {string} filename
 * @property {string} mimeType
 * @property {FileKind} kind
 * @property {number} expiresAt - epoch seconds
 */

/** @typedef {'image' | 'video' | 'pdf' | 'text'} FileKind */
/** @typedef {{ mimeType: string, ext: string, kind: FileKind }} FileType */

const nowSec = () => Math.floor(Date.now() / 1000);

mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
/** @type {Map<string, Upload>} waiting uploads from before a restart, if their files are still there */
const uploads = new Map(
  /** @type {Upload[]} */ (readJsonFile(INDEX_FILE, { uploads: [] }).uploads || [])
    .filter((u) => u.expiresAt > nowSec() && existsSync(u.path))
    .map((u) => [u.id, u]),
);

function saveIndex() {
  writeJsonFile(INDEX_FILE, { uploads: [...uploads.values()] }, { mode: 0o600 });
}

/** Brands of ISO media files that are still images (AVIF, HEIC), not video. */
const IMAGE_BRANDS = new Set(['avif', 'avis', 'heic', 'heix', 'mif1', 'msf1']);

/**
 * The type of a binary file from its first bytes: a supported image, video or PDF, else null. Text files have
 * no signature; check them with textChecker().
 * @param {Buffer} data - at least the first SNIFF_BYTES bytes when available
 * @returns {FileType | null}
 */
export function sniffFile(data) {
  const hex = data.subarray(0, 12).toString('hex');
  if (data.subarray(0, 5).toString('latin1') === '%PDF-')
    return { mimeType: 'application/pdf', ext: 'pdf', kind: 'pdf' };
  if (hex.startsWith('89504e470d0a1a0a')) return { mimeType: 'image/png', ext: 'png', kind: 'image' };
  if (hex.startsWith('ffd8ff')) return { mimeType: 'image/jpeg', ext: 'jpg', kind: 'image' };
  if (hex.startsWith('474946383761') || hex.startsWith('474946383961')) {
    return { mimeType: 'image/gif', ext: 'gif', kind: 'image' };
  }
  if (hex.startsWith('52494646') && hex.slice(16, 24) === '57454250') {
    return { mimeType: 'image/webp', ext: 'webp', kind: 'image' };
  }
  // MP4 and QuickTime: an 'ftyp' box at offset 4, then the major brand
  if (data.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = data.subarray(8, 12).toString('latin1');
    if (IMAGE_BRANDS.has(brand)) return null;
    return brand === 'qt  '
      ? { mimeType: 'video/quicktime', ext: 'mov', kind: 'video' }
      : { mimeType: 'video/mp4', ext: 'mp4', kind: 'video' };
  }
  // WebM: an EBML header whose DocType is "webm" (Matroska .mkv is not played inline by Slack)
  if (hex.startsWith('1a45dfa3') && data.subarray(0, SNIFF_BYTES).includes('webm', 0, 'latin1')) {
    return { mimeType: 'video/webm', ext: 'webm', kind: 'video' };
  }
  return null;
}

/** Extensions a text file keeps; any other becomes .txt (so nothing arrives as .html or .svg). */
const TEXT_EXTS = new Set(['txt', 'log', 'csv', 'json', 'ndjson', 'md', 'yaml', 'yml']);

/**
 * The type for a text file named `filename`.
 * @param {string | null} filename
 * @returns {FileType}
 */
export function textType(filename) {
  const ext = /\.([A-Za-z0-9]+)$/.exec(filename || '')?.[1]?.toLowerCase() ?? '';
  return { mimeType: 'text/plain', ext: TEXT_EXTS.has(ext) ? ext : 'txt', kind: 'text' };
}

/**
 * Checks, chunk by chunk, that a file is plain text: valid UTF-8 (split characters across chunks are fine)
 * and no NUL bytes, which binary files have and text never does.
 * @returns {{ feed: (chunk: Buffer) => boolean, end: () => boolean }} each returns false once it is not text
 */
export function textChecker() {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let ok = true;
  /** @param {() => void} check */
  const run = (check) => {
    if (!ok) return false;
    try {
      check();
    } catch {
      ok = false;
    }
    return ok;
  };
  return {
    feed: (chunk) =>
      run(() => {
        if (chunk.includes(0)) throw new Error('NUL byte');
        decoder.decode(chunk, { stream: true });
      }),
    end: () => run(() => decoder.decode()),
  };
}

/** Remove expired uploads and their files, and any file older than ORPHAN_AGE_MS. */
function sweep() {
  const now = nowSec();
  let changed = false;
  for (const [id, u] of uploads) {
    if (u.expiresAt <= now) {
      uploads.delete(id);
      deleteUploadFile(u.path);
      changed = true;
    }
  }
  if (changed) saveIndex();
  for (const name of readdirSync(UPLOAD_DIR)) {
    const path = join(UPLOAD_DIR, name);
    try {
      if (Date.now() - statSync(path).mtimeMs > ORPHAN_AGE_MS) deleteUploadFile(path);
    } catch {
      // already gone
    }
  }
}

/**
 * Delete an upload's file (after it is posted, discarded or expired). Missing files are fine.
 * @param {string} path
 */
export function deleteUploadFile(path) {
  rmSync(path, { force: true });
}

/** Bytes held on disk right now. */
function bytesHeld() {
  let total = 0;
  for (const name of readdirSync(UPLOAD_DIR)) {
    try {
      total += statSync(join(UPLOAD_DIR, name)).size;
    } catch {
      // removed meanwhile
    }
  }
  return total;
}

/**
 * A safe file name for Slack: letters, digits, dots, dashes and underscores, with the media's real extension.
 * @param {string | null} name
 * @param {string} ext
 */
function safeFilename(name, ext) {
  const base = (name || 'upload')
    .replace(/\.[^.]*$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .slice(0, 80);
  return `${base || 'upload'}.${ext}`;
}

/**
 * Stream an uploaded file to disk for its owner, enforcing the size limits and checking its type: images,
 * videos and PDFs from the first bytes, text as it streams. Anything rejected is deleted.
 * @param {string} owner - MCP client name
 * @param {AsyncIterable<Buffer>} body - the request
 * @param {string | null} filename
 * @returns {Promise<{ ok: true, upload: Upload } | { ok: false, status: number, error: string }>}
 */
export async function storeUploadStream(owner, body, filename) {
  sweep();
  const limit = maxUploadBytes();
  const room = maxTotalBytes() - bytesHeld();
  const id = `up_${randomBytes(12).toString('base64url')}`;
  const path = join(UPLOAD_DIR, id);
  const file = createWriteStream(path, { mode: 0o600 });
  /** @type {{ status: number, error: string } | null} */
  let failure = null;
  /** @type {FileType | null} */
  let type = null;
  /** Set when the file is not a known binary format, to check it is text as the rest streams in. */
  const text = textChecker();
  /** @param {Buffer} start */
  const recognise = (start) => sniffFile(start) ?? (text.feed(start) ? textType(filename) : null);
  let size = 0;
  /** @type {Buffer[]} */
  let head = [];
  // After a failure the rest of the body is read and dropped, so the client still gets the error
  // reply (stopping early would reset the connection); past twice the limit the upload is cut off.
  let rejected = false;
  try {
    for await (const chunk of body) {
      size += chunk.length;
      if (rejected) {
        if (size > 2 * limit) break;
        continue;
      }
      if (size > limit) {
        failure = { status: 413, error: `File too large (max ${config.mcp.maxUploadMb} MB).` };
        rejected = true;
        continue;
      }
      if (size > room) {
        failure = { status: 507, error: 'Too many uploads are waiting; try again later.' };
        rejected = true;
        continue;
      }
      if (!type) {
        head.push(chunk);
        const start = Buffer.concat(head);
        if (start.length >= SNIFF_BYTES) {
          type = recognise(start);
          head = [];
          if (!type) {
            rejected = true; // reported as 415 below
            continue;
          }
        }
      } else if (type.kind === 'text' && !text.feed(chunk)) {
        type = null; // binary after all: reported as 415 below
        rejected = true;
        continue;
      }
      if (!file.write(chunk)) await once(file, 'drain');
    }
    if (!rejected && !type && head.length) type = recognise(Buffer.concat(head)); // short files
    if (type?.kind === 'text' && !text.end()) type = null; // ends inside a character
  } catch (e) {
    failure = { status: 400, error: `Upload interrupted (${e instanceof Error ? e.message : e}).` };
  }
  file.end();
  await once(file, 'close');

  if (!failure && size === 0) failure = { status: 400, error: 'Empty upload. Send the file as the request body.' };
  if (!failure && !type) {
    failure = {
      status: 415,
      error:
        'Only PNG, JPEG, GIF and WebP images, MP4, MOV and WebM videos, PDFs, and UTF-8 text files ' +
        '(logs, .txt, .csv, .json, .md, .yaml) are accepted.',
    };
  }
  if (failure || !type) {
    deleteUploadFile(path);
    return { ok: false, ...(failure || { status: 415, error: 'Unsupported file.' }) };
  }
  /** @type {Upload} */
  const upload = {
    id,
    owner,
    path,
    size,
    filename: safeFilename(filename, type.ext),
    mimeType: type.mimeType,
    kind: type.kind,
    expiresAt: nowSec() + UPLOAD_TTL_SEC,
  };
  uploads.set(id, upload);
  saveIndex();
  return { ok: true, upload };
}

/**
 * Take an upload to attach it. Only its owner can, and only once; the caller then owns the file
 * and must delete it with deleteUploadFile when done.
 * @param {string} id
 * @param {string} owner
 * @returns {Upload | null}
 */
export function takeUpload(id, owner) {
  sweep();
  const upload = uploads.get(id);
  if (!upload || upload.owner !== owner) return null;
  uploads.delete(id);
  saveIndex();
  return upload;
}
