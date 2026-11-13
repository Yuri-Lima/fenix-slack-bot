import { formatBytes } from '../../utils/helpers.js';

/** @typedef {import('@slack/types').KnownBlock} Block */

export const SEND_ACTION = 'mcp_send_approve';
export const DISCARD_ACTION = 'mcp_send_discard';
/** Slack's limit for a section's text. */
const SECTION_CHARS = 3000;

/**
 * Text as a Slack quote, split into section blocks that fit Slack's limit.
 * @param {string} text
 * @returns {Block[]}
 */
function quotedSections(text) {
  const quoted = text
    .split('\n')
    .map((line) => `>${line}`)
    .join('\n');
  /** @type {Block[]} */
  const blocks = [];
  for (let i = 0; i < quoted.length; i += SECTION_CHARS) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: quoted.slice(i, i + SECTION_CHARS) } });
  }
  return blocks;
}

/**
 * The draft's body: its text quoted, and its image or video named (the file itself is previewed just above).
 * @param {import('../../mcp/send-approval.js').Draft} draft
 * @returns {Block[]}
 */
function draftBody(draft) {
  /** @type {Block[]} */
  const blocks = draft.text ? quotedSections(draft.text) : [];
  if (draft.attachment) {
    const { kind, filename, size } = draft.attachment;
    const icon = kind === 'video' ? ':film_frames:' : ':frame_with_picture:';
    const preview = draft.previewFailed ? 'the preview could not be shown' : 'preview above';
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `${icon} With ${kind} \`${filename}\` (${formatBytes(size)}) · ${preview}` }],
    });
  }
  return blocks;
}

/**
 * DM asking an owner to send or discard a message an MCP client drafted.
 * @param {import('../../mcp/send-approval.js').Draft} draft
 * @returns {Block[]}
 */
export function buildSendApprovalBlocks(draft) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:outbox_tray: *${draft.caller}* wants to post as Fenix to *${draft.target.where}*:`,
      },
    },
    ...draftBody(draft),
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Nothing is posted until you click Send · expires <!date^${draft.expiresAt}^{time}|in 30 minutes>`,
        },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          action_id: SEND_ACTION,
          value: draft.id,
          text: { type: 'plain_text', text: 'Send' },
        },
        {
          type: 'button',
          style: 'danger',
          action_id: DISCARD_ACTION,
          value: draft.id,
          text: { type: 'plain_text', text: 'Discard' },
        },
      ],
    },
  ];
}

/**
 * The DM after a decision (buttons removed, draft kept for the record).
 * @param {import('../../mcp/send-approval.js').Draft | null} draft - null when expired or already decided
 * @param {'sent' | 'failed' | 'discarded'} outcome
 * @param {string} userId - who decided
 * @param {string} [result] - the post's outcome (link, or why it failed)
 * @returns {Block[]}
 */
export function buildSendDecisionBlocks(draft, outcome, userId, result = '') {
  if (!draft) {
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ':hourglass: This draft expired, was already decided, or Fenix restarted since. Nothing was posted.',
        },
      },
    ];
  }
  const head =
    outcome === 'sent'
      ? `:white_check_mark: <@${userId}> sent *${draft.caller}*'s message to *${draft.target.where}*.`
      : outcome === 'failed'
        ? `:warning: <@${userId}> approved *${draft.caller}*'s message, but it could not be posted.`
        : `:wastebasket: <@${userId}> discarded *${draft.caller}*'s message to *${draft.target.where}*.`;
  /** @type {Block[]} */
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: head } }, ...draftBody(draft)];
  if (result) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: result }] });
  return blocks;
}
