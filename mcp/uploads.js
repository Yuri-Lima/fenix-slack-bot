import { randomBytes } from 'node:crypto';

// Images MCP clients upload (POST /uploads) to attach to slack_send_message.
// The bytes go straight from the client's shell to Fenix, never through the
// model: the client gets an upload_id and passes that to the tool. Uploads live
// in memory, belong to the client that uploaded them, can be used once, and
// expire; only real images (checked by their first bytes) are accepted.

/** Largest image accepted (Slack shows bigger ones only as downloads anyway). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Total kept in memory at once. */
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
/** How long an upload waits to be attached. */
export const UPLOAD_TTL_SEC = 60 * 60;

/**
 * @typedef {Object} Upload
 * @property {string} id
 * @property {string} owner - MCP client name
 * @property {Buffer} data
 * @property {string} filename
 * @property {string} mimeType
 * @property {number} expiresAt - epoch seconds
 */

/** @type {Map<string, Upload>} */
const uploads = new Map();
const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * The image type from a file's first bytes, or null if it is not a supported image.
 * @param {Buffer} data
 * @returns {{ mimeType: string, ext: string } | null}
 */
export function sniffImage(data) {
  const hex = data.subarray(0, 12).toString('hex');
  if (hex.startsWith('89504e470d0a1a0a')) return { mimeType: 'image/png', ext: 'png' };
  if (hex.startsWith('ffd8ff')) return { mimeType: 'image/jpeg', ext: 'jpg' };
  if (hex.startsWith('474946383761') || hex.startsWith('474946383961')) return { mimeType: 'image/gif', ext: 'gif' };
  if (hex.startsWith('52494646') && hex.slice(16, 24) === '57454250') return { mimeType: 'image/webp', ext: 'webp' };
  return null;
}

function pruneExpired() {
  const now = nowSec();
  for (const [id, u] of uploads) if (u.expiresAt <= now) uploads.delete(id);
}

/**
 * A safe file name for Slack: letters, digits, dots, dashes and underscores, with the image's real extension.
 * @param {string | null} name
 * @param {string} ext
 */
function safeFilename(name, ext) {
  const base = (name || 'image')
    .replace(/\.[^.]*$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .slice(0, 80);
  return `${base || 'image'}.${ext}`;
}

/**
 * Keep an uploaded image for its owner.
 * @param {string} owner - MCP client name
 * @param {Buffer} data
 * @param {string | null} filename
 * @returns {{ ok: true, upload: Upload } | { ok: false, status: number, error: string }}
 */
export function storeUpload(owner, data, filename) {
  pruneExpired();
  if (!data.length) return { ok: false, status: 400, error: 'Empty upload. Send the image bytes as the request body.' };
  if (data.length > MAX_UPLOAD_BYTES) {
    return { ok: false, status: 413, error: `Image too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).` };
  }
  const type = sniffImage(data);
  if (!type) return { ok: false, status: 415, error: 'Only PNG, JPEG, GIF and WebP images are accepted.' };
  const held = [...uploads.values()].reduce((sum, u) => sum + u.data.length, 0);
  if (held + data.length > MAX_TOTAL_BYTES) {
    return { ok: false, status: 503, error: 'Too many uploads are waiting; try again later.' };
  }
  /** @type {Upload} */
  const upload = {
    id: `img_${randomBytes(12).toString('base64url')}`,
    owner,
    data,
    filename: safeFilename(filename, type.ext),
    mimeType: type.mimeType,
    expiresAt: nowSec() + UPLOAD_TTL_SEC,
  };
  uploads.set(upload.id, upload);
  return { ok: true, upload };
}

/**
 * Take an upload to attach it. Only its owner can, and only once.
 * @param {string} id
 * @param {string} owner
 * @returns {Upload | null}
 */
export function takeUpload(id, owner) {
  pruneExpired();
  const upload = uploads.get(id);
  if (!upload || upload.owner !== owner) return null;
  uploads.delete(id);
  return upload;
}
