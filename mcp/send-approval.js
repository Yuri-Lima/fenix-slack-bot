import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { conversationFor } from '../agent/tools/slack.js';
import { config, resolvePath } from '../config.js';
import { buildSendApprovalBlocks } from '../listeners/views/mcp-send-approval-builder.js';
import { textResult } from '../utils/helpers.js';
import { readJsonFile, writeJsonFile } from '../utils/json-file.js';
import { uploadFileToSlack } from '../utils/slack.js';
import { deleteUploadFile } from './uploads.js';

// Messages from MCP clients whose sends need approval (clients that may run tools
// without asking their user, like Grok in always-approve mode) wait here until an
// owner clicks Send or Discard in Slack. The tool call returns at once; the post
// happens on the click (listeners/actions/mcp-send-approval.js). Drafts are saved
// in data/ (an attachment's file stays in data/uploads/), so a restart or deploy
// keeps them and their buttons still work.

/** How long a draft waits for a decision. */
export const DRAFT_TTL_SEC = 30 * 60;
/** Most drafts waiting at once, so a runaway client cannot flood the owners. */
const MAX_DRAFTS = 20;

/**
 * @typedef {Object} Draft
 * @property {string} id
 * @property {string} caller - MCP client name
 * @property {import('../agent/tools/slack.js').SendTarget} target
 * @property {string} text
 * @property {import('../agent/tools/slack.js').SendAttachment} [attachment] - released when the draft is decided or expires
 * @property {boolean} [previewFailed] - the attachment could not be shown to every owner
 * @property {number} expiresAt - epoch seconds
 */

const DRAFTS_FILE = join(resolvePath(config.dataDir), 'mcp-send-drafts.json');
const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * A saved draft's attachment again, with its release (which deletes the file).
 * @param {Omit<import('../agent/tools/slack.js').SendAttachment, 'release'>} [saved]
 * @returns {import('../agent/tools/slack.js').SendAttachment | undefined}
 */
const revive = (saved) => saved && { ...saved, release: () => deleteUploadFile(saved.path) };

/** @type {Map<string, Draft>} drafts from before a restart included */
const drafts = new Map(
  /** @type {Draft[]} */ (readJsonFile(DRAFTS_FILE, { drafts: [] }).drafts || []).map((d) => [
    d.id,
    { ...d, attachment: revive(d.attachment) },
  ]),
);

function saveDrafts() {
  const saved = [...drafts.values()].map(({ attachment, ...d }) => {
    if (!attachment) return d;
    const { release, ...file } = attachment;
    return { ...d, attachment: file };
  });
  writeJsonFile(DRAFTS_FILE, { drafts: saved }, { mode: 0o600 });
}

function pruneExpired() {
  const now = nowSec();
  let changed = false;
  for (const [id, d] of drafts) {
    if (d.expiresAt <= now) {
      drafts.delete(id);
      d.attachment?.release();
      changed = true;
    }
  }
  if (changed) saveDrafts();
}

/**
 * Hold a message for approval and DM each owner the draft with Send / Discard buttons.
 * @param {any} slack - Slack WebClient
 * @param {string} caller - MCP client name, shown to the approver
 * @param {import('../agent/tools/slack.js').SendTarget} target
 * @param {string} text
 * @param {import('../agent/tools/slack.js').SendAttachment} [attachment] - the draft owns it from here
 * @returns {Promise<ReturnType<typeof textResult>>} what the client is told
 */
export async function requestSendApproval(slack, caller, target, text, attachment) {
  pruneExpired();
  if (drafts.size >= MAX_DRAFTS) {
    attachment?.release();
    return textResult('Not sent: too many messages are already waiting for approval in Slack.', true);
  }
  /** @type {Draft} */
  const draft = {
    id: randomBytes(12).toString('base64url'),
    caller,
    target,
    text,
    attachment,
    expiresAt: nowSec() + DRAFT_TTL_SEC,
  };
  drafts.set(draft.id, draft);
  saveDrafts();
  // Show an attachment itself first, so the owner can look at or play it before deciding
  if (attachment) {
    const previews = await Promise.allSettled(
      config.ownerIds.map(async (owner) =>
        uploadFileToSlack(slack, {
          channel: await conversationFor(slack, owner),
          comment: `:eyes: Preview: *${caller}* wants to post this to *${target.where}*. Send or discard it below.`,
          file: attachment,
        }),
      ),
    );
    draft.previewFailed = previews.some((p) => p.status === 'rejected');
    saveDrafts();
  }
  try {
    await Promise.all(
      config.ownerIds.map((owner) =>
        slack.chat.postMessage({
          channel: owner,
          text: `${caller} wants to post as Fenix to ${target.where}. Send or discard it in Slack.`,
          blocks: buildSendApprovalBlocks(draft),
          unfurl_links: false,
        }),
      ),
    );
  } catch (e) {
    drafts.delete(draft.id);
    saveDrafts();
    attachment?.release();
    return textResult(`Not sent: could not ask the owner for approval in Slack (${e}).`, true);
  }
  return textResult(
    `Not posted yet. Messages from ${caller} need the owner's approval: the draft is in their Slack DM with ` +
      `Send / Discard buttons, and it is posted to ${target.where} when they click Send ` +
      `(it expires in ${DRAFT_TTL_SEC / 60} minutes). Tell the user it is waiting for their approval in Slack.`,
  );
}

/**
 * Take a draft for a decision. Each draft can be decided once.
 * @param {string} id
 * @returns {Draft | null} null when unknown, expired or already decided
 */
export function takeDraft(id) {
  pruneExpired();
  const draft = drafts.get(id) || null;
  if (draft) {
    drafts.delete(id);
    saveDrafts();
  }
  return draft;
}
