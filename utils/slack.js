import { createReadStream } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { pipeline } from 'node:stream/promises';
import { maskSecrets } from '../integrations/host-health.js';
import { FETCH_TIMEOUT_MS } from '../integrations/http.js';
import { sniffFile, textChecker } from '../mcp/uploads.js';

/** Longest a file upload to Slack may stall without progress before it is abandoned. */
const UPLOAD_TIMEOUT_MS = 10 * 60_000;
/** How long a resolved display name is reused before asking Slack again. */
const USER_NAME_TTL_MS = 30 * 60_000;

/** @type {Map<string, { name: string, ts: number }>} one entry per Slack user seen */
const userNames = new Map();

/**
 * Display name for a Slack user (real name, then handle, then the ID itself).
 * Cached per process; lookups that fail fall back to the ID without caching.
 * @param {import('@slack/web-api').WebClient} client
 * @param {string | undefined} userId
 * @returns {Promise<string>}
 */
export async function resolveUserName(client, userId) {
  if (!userId) return 'unknown';
  const cached = userNames.get(userId);
  if (cached && Date.now() - cached.ts < USER_NAME_TTL_MS) return cached.name;
  try {
    const info = await client.users.info({ user: userId });
    const name = info.user?.real_name || info.user?.name || userId;
    userNames.set(userId, { name, ts: Date.now() });
    return name;
  } catch {
    return cached?.name || userId;
  }
}

/** Files read from one message; the rest are named as skipped. */
export const MAX_FILES_PER_MESSAGE = 4;
/** Largest image the Claude API accepts. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Largest PDF read: each page costs text plus a page image in tokens, so this keeps one reply affordable. */
const MAX_PDF_BYTES = 5 * 1024 * 1024;
/** Largest text file downloaded; only its end is read (see MAX_TEXT_CHARS). */
const MAX_TEXT_DOWNLOAD_BYTES = 10 * 1024 * 1024;
/** Characters of a text file the model reads (about 50k tokens): the end, where a log's latest lines are. */
export const MAX_TEXT_CHARS = 200_000;
/** Image types the Claude API reads. */
const READABLE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** Slack file types that are text even when the MIME type does not say so (snippets, code, logs, data). */
const TEXT_FILETYPES = new Set([
  'text',
  'log',
  'csv',
  'tsv',
  'json',
  'yaml',
  'xml',
  'markdown',
  'post',
  'diff',
  'shell',
]);
/** The bot token is only ever sent to Slack's own file host. */
const SLACK_FILE_URL = /^https:\/\/files\.slack\.com\//;
const MB = 1024 * 1024;

/**
 * A file from a Slack message, ready for the model: images and PDFs as base64, text as (masked) text.
 * @typedef {Object} SlackAttachment
 * @property {string} name
 * @property {'image' | 'pdf' | 'text'} kind
 * @property {string} mediaType
 * @property {string} data - base64 for images and PDFs, the text itself for text
 * @property {string} [note] - what was left out, e.g. the start of a long log
 */

/**
 * @typedef {{ id?: string, name?: string, title?: string, mimetype?: string, filetype?: string, size?: number, url_private?: string, url_private_download?: string }} SlackFileInfo
 */

/**
 * Download a file from Slack with the bot token (needs the files:read scope). The token is only ever sent to
 * Slack's own file host; anything else is refused before a request is made.
 * @param {string} token - the bot token
 * @param {string} url - the file's url_private or url_private_download
 * @returns {Promise<{ data: Buffer, contentType: string }>}
 */
export async function downloadSlackFile(token, url) {
  if (!SLACK_FILE_URL.test(url)) throw new Error('not a Slack file link');
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    // Files can be large, so downloads get longer than API calls
    signal: AbortSignal.timeout(2 * FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { data: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? '' };
}

/**
 * What a Slack file claims to be, from its metadata, before downloading it.
 * @param {SlackFileInfo} f
 * @returns {'image' | 'pdf' | 'text' | 'video' | null}
 */
function claimedKind(f) {
  const mime = f.mimetype ?? '';
  if (READABLE_IMAGE_TYPES.has(mime)) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('video/') || mime.startsWith('audio/')) return 'video';
  if (mime.startsWith('text/') || /^application\/(json|x-ndjson|x-yaml|yaml|xml)$/.test(mime)) return 'text';
  if (TEXT_FILETYPES.has(f.filetype ?? '')) return 'text';
  return null;
}

/**
 * Download the files attached to a Slack message that the model can read (needs the files:read scope):
 * images, PDFs, and text files such as logs. Each file's type is checked from its bytes, not trusted from Slack;
 * text must be valid UTF-8, has its secrets masked, and only its last MAX_TEXT_CHARS characters are read.
 * Videos, other files, oversized ones, those beyond the per-message limit and failed downloads are listed in
 * `skipped` with the reason.
 * @param {import('@slack/web-api').WebClient} client
 * @param {SlackFileInfo[]} [files]
 * @returns {Promise<{ attachments: SlackAttachment[], skipped: string[] }>}
 */
export async function readSlackFiles(client, files = []) {
  /** @type {SlackAttachment[]} */
  const attachments = [];
  /** @type {string[]} */
  const skipped = [];
  for (const f of files) {
    const name = f.name || f.title || f.id || 'file';
    const url = f.url_private_download || f.url_private || '';
    const kind = claimedKind(f);
    const size = f.size ?? 0;
    if (kind === 'video') {
      skipped.push(`${name} (${f.filetype || f.mimetype}: Fenix cannot watch videos or listen to audio)`);
    } else if (!kind) {
      skipped.push(`${name} (${f.filetype || f.mimetype || 'unknown type'}: not an image, PDF or text file)`);
    } else if (attachments.length >= MAX_FILES_PER_MESSAGE) {
      skipped.push(`${name} (only the first ${MAX_FILES_PER_MESSAGE} files are read)`);
    } else if (kind === 'image' && size > MAX_IMAGE_BYTES) {
      skipped.push(`${name} (images over ${MAX_IMAGE_BYTES / MB} MB are not read)`);
    } else if (kind === 'pdf' && size > MAX_PDF_BYTES) {
      skipped.push(`${name} (PDFs over ${MAX_PDF_BYTES / MB} MB are not read)`);
    } else if (kind === 'text' && size > MAX_TEXT_DOWNLOAD_BYTES) {
      skipped.push(`${name} (text files over ${MAX_TEXT_DOWNLOAD_BYTES / MB} MB are not read)`);
    } else if (!SLACK_FILE_URL.test(url)) {
      skipped.push(`${name} (no Slack download link)`);
    } else {
      try {
        const { data, contentType } = await downloadSlackFile(/** @type {string} */ (client.token), url);
        const read = toAttachment(name, kind, data, contentType, f.mimetype ?? '');
        if (read) attachments.push(read);
        else
          skipped.push(
            `${name} (could not be read as ${kind === 'image' ? 'an image' : kind === 'pdf' ? 'a PDF' : 'text'})`,
          );
      } catch (e) {
        skipped.push(`${name} (download failed: ${/** @type {Error} */ (e).message})`);
      }
    }
  }
  return { attachments, skipped };
}

/**
 * A downloaded file as an attachment for the model, or null when its bytes are not what Slack said.
 * A missing files:read scope returns Slack's HTML sign-in page, which is caught here too.
 * @param {string} name
 * @param {'image' | 'pdf' | 'text'} kind
 * @param {Buffer} data
 * @param {string} served - the download's content type
 * @param {string} claimed - the file's MIME type in Slack
 * @returns {SlackAttachment | null}
 */
function toAttachment(name, kind, data, served, claimed) {
  if (kind !== 'text') {
    const type = sniffFile(data);
    const limit = kind === 'image' ? MAX_IMAGE_BYTES : MAX_PDF_BYTES;
    if (type?.kind !== kind || data.length > limit) return null;
    return { name, kind, mediaType: type.mimeType, data: data.toString('base64') };
  }
  if (served.startsWith('text/html') && !claimed.startsWith('text/html')) return null; // the sign-in page
  const check = textChecker();
  if (!check.feed(data) || !check.end()) return null;
  const text = data.toString('utf-8');
  const cut = text.length > MAX_TEXT_CHARS;
  return {
    name,
    kind,
    mediaType: 'text/plain',
    data: maskSecrets(cut ? text.slice(-MAX_TEXT_CHARS) : text),
    ...(cut && {
      note: `only the last ${MAX_TEXT_CHARS.toLocaleString('en')} of ${text.length.toLocaleString('en')} characters`,
    }),
  };
}

/**
 * A file on disk to post in Slack.
 * @typedef {{ path: string, size: number, filename: string, mimeType: string, alt?: string }} SlackFile
 */

/**
 * Upload a file from disk to a conversation, streamed (never held in memory), with an optional
 * comment posted with it in one message. Uses Slack's external upload flow: get an upload URL,
 * send the bytes there, then complete the upload into the conversation.
 * @param {import('@slack/web-api').WebClient} client
 * @param {{ channel: string, threadTs?: string, comment?: string, file: SlackFile }} options - channel must be a conversation ID
 * @returns {Promise<string | null>} the file's link
 */
export async function uploadFileToSlack(client, { channel, threadTs, comment, file }) {
  const target = await client.files.getUploadURLExternal({
    filename: file.filename,
    length: file.size,
    ...(file.alt ? { alt_txt: file.alt } : {}),
  });
  await streamFile(/** @type {string} */ (target.upload_url), file);
  // Slack's types want thread_ts either set or absent, not undefined
  /** @type {any} */
  const args = {
    files: [{ id: target.file_id, title: file.filename }],
    channel_id: channel,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    ...(comment ? { initial_comment: comment } : {}),
  };
  /** @type {any} */
  const done = await client.files.completeUploadExternal(args);
  return done.files?.[0]?.permalink || null;
}

/**
 * POST a file's bytes to an upload URL, streamed from disk with its exact length.
 * @param {string} url
 * @param {SlackFile} file
 * @returns {Promise<void>}
 */
function streamFile(url, file) {
  const target = new URL(url);
  const send = target.protocol === 'http:' ? httpRequest : httpsRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      target,
      { method: 'POST', headers: { 'Content-Type': file.mimeType, 'Content-Length': file.size } },
      (res) => {
        res.resume();
        res.on('end', () =>
          res.statusCode && res.statusCode < 300
            ? resolve()
            : reject(new Error(`Slack file upload failed (HTTP ${res.statusCode})`)),
        );
      },
    );
    req.setTimeout(UPLOAD_TIMEOUT_MS, () => req.destroy(new Error('Slack file upload timed out')));
    req.on('error', reject);
    pipeline(createReadStream(file.path), req).catch(reject);
  });
}
