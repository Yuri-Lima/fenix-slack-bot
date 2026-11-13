import { createReadStream } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { pipeline } from 'node:stream/promises';

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
