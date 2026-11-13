import { randomBytes } from 'node:crypto';
import { conversationFor } from '../agent/tools/slack.js';
import { config } from '../config.js';
import { buildSendApprovalBlocks } from '../listeners/views/mcp-send-approval-builder.js';
import { textResult } from '../utils/helpers.js';
import { uploadFileToSlack } from '../utils/slack.js';

// Messages from MCP clients whose sends need approval (clients that may run tools
// without asking their user, like Grok in always-approve mode) wait here until an
// owner clicks Send or Discard in Slack. The tool call returns at once; the post
// happens on the click (listeners/actions/mcp-send-approval.js). Drafts live in
// memory only: a restart drops them, and their buttons then say so.

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

/** @type {Map<string, Draft>} */
const drafts = new Map();
const nowSec = () => Math.floor(Date.now() / 1000);

function pruneExpired() {
  const now = nowSec();
  for (const [id, d] of drafts) {
    if (d.expiresAt <= now) {
      drafts.delete(id);
      d.attachment?.release();
    }
  }
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
  drafts.delete(id);
  return draft;
}
