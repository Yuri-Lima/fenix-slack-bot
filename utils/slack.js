import { createReadStream } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { pipeline } from 'node:stream/promises';
import { FETCH_TIMEOUT_MS } from '../integrations/http.js';
import { sniffMedia } from '../mcp/uploads.js';

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

/** Images read from one message; the rest are named as skipped. */
export const MAX_IMAGES_PER_MESSAGE = 4;
/** Largest image the Claude API accepts. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Image types the Claude API reads. */
const READABLE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** The bot token is only ever sent to Slack's own file host. */
const SLACK_FILE_URL = /^https:\/\/files\.slack\.com\//;

/**
 * An image from a Slack message, ready for the model.
 * @typedef {{ name: string, mediaType: string, data: string }} SlackImage - data is base64
 */

/**
 * Download the images attached to a Slack message (needs the files:read scope). The type is
 * checked from the bytes, not trusted from Slack. Files that are not readable images, too large,
 * beyond the per-message limit, or fail to download are listed in `skipped` with the reason.
 * @param {import('@slack/web-api').WebClient} client
 * @param {Array<{ id?: string, name?: string, title?: string, mimetype?: string, filetype?: string, size?: number, url_private?: string, url_private_download?: string }>} [files]
 * @returns {Promise<{ images: SlackImage[], skipped: string[] }>}
 */
export async function readSlackImages(client, files = []) {
  /** @type {SlackImage[]} */
  const images = [];
  /** @type {string[]} */
  const skipped = [];
  for (const f of files) {
    const name = f.name || f.title || f.id || 'file';
    const url = f.url_private_download || f.url_private || '';
    if (!READABLE_IMAGE_TYPES.has(f.mimetype ?? '')) {
      skipped.push(`${name} (${f.filetype || f.mimetype || 'unknown type'}, not an image)`);
    } else if (images.length >= MAX_IMAGES_PER_MESSAGE) {
      skipped.push(`${name} (only the first ${MAX_IMAGES_PER_MESSAGE} images are read)`);
    } else if ((f.size ?? 0) > MAX_IMAGE_BYTES) {
      skipped.push(`${name} (larger than 5 MB)`);
    } else if (!SLACK_FILE_URL.test(url)) {
      skipped.push(`${name} (no Slack download link)`);
    } else {
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${client.token}` },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = Buffer.from(await res.arrayBuffer());
        const type = sniffMedia(data);
        // A missing files:read scope returns an HTML sign-in page, which this also catches
        if (type?.kind !== 'image' || data.length > MAX_IMAGE_BYTES) {
          skipped.push(`${name} (could not be read as an image)`);
        } else {
          images.push({ name, mediaType: type.mimeType, data: data.toString('base64') });
        }
      } catch (e) {
        skipped.push(`${name} (download failed: ${/** @type {Error} */ (e).message})`);
      }
    }
  }
  return { images, skipped };
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
