import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config, resolvePath } from '../config.js';

// Images and videos MCP clients upload (POST or PUT /uploads) to attach to
// slack_send_message. The bytes stream from the client's shell to disk, never
// through the model: the client gets an upload_id and passes that to the tool.
// An upload belongs to the client that made it, can be attached once, and
// expires; only real images and videos (checked by their first bytes) are kept.
// Whoever takes an upload owns its file and must delete it (deleteUploadFile)
// once it is posted or dropped; a sweep removes anything left behind.

const UPLOAD_DIR = join(resolvePath(config.dataDir), 'uploads');
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
 * @property {'image' | 'video'} kind
 * @property {number} expiresAt - epoch seconds
 */

/** @type {Map<string, Upload>} */
const uploads = new Map();
const nowSec = () => Math.floor(Date.now() / 1000);

// Uploads live in memory, so files from before a restart can never be attached: start clean
rmSync(UPLOAD_DIR, { recursive: true, force: true });
mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });

/** Brands of ISO media files that are still images (AVIF, HEIC), not video. */
const IMAGE_BRANDS = new Set(['avif', 'avis', 'heic', 'heix', 'mif1', 'msf1']);

/**
 * The media type from a file's first bytes, or null if it is not a supported image or video.
 * @param {Buffer} data - at least the first SNIFF_BYTES bytes when available
 * @returns {{ mimeType: string, ext: string, kind: 'image' | 'video' } | null}
 */
export function sniffMedia(data) {
  const hex = data.subarray(0, 12).toString('hex');
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

/** Remove expired uploads and their files, and any file older than ORPHAN_AGE_MS. */
function sweep() {
  const now = nowSec();
  for (const [id, u] of uploads) {
    if (u.expiresAt <= now) {
      uploads.delete(id);
      deleteUploadFile(u.path);
    }
  }
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
 * Stream an uploaded image or video to disk for its owner, enforcing the size limits and checking
 * its type from the first bytes. Anything rejected is deleted.
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
  /** @type {ReturnType<typeof sniffMedia>} */
  let type = null;
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
          type = sniffMedia(start);
          head = [];
          if (!type) {
            rejected = true; // reported as 415 below
            continue;
          }
        }
      }
      if (!file.write(chunk)) await once(file, 'drain');
    }
    if (!rejected && !type && head.length) type = sniffMedia(Buffer.concat(head)); // short files
  } catch (e) {
    failure = { status: 400, error: `Upload interrupted (${e instanceof Error ? e.message : e}).` };
  }
  file.end();
  await once(file, 'close');

  if (!failure && size === 0) failure = { status: 400, error: 'Empty upload. Send the file as the request body.' };
  if (!failure && !type) {
    failure = { status: 415, error: 'Only PNG, JPEG, GIF and WebP images and MP4, MOV and WebM videos are accepted.' };
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
  return upload;
}
