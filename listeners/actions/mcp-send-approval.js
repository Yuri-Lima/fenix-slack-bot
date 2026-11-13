import { createSlackDirectory, deliverMessage } from '../../agent/tools/slack.js';
import { takeDraft } from '../../mcp/send-approval.js';
import { isWhitelisted } from '../../utils/input-guard.js';
import { recordUsage, ruleBasedRun } from '../../utils/usage-store.js';
import { buildSendDecisionBlocks, SEND_ACTION } from '../views/mcp-send-approval-builder.js';

/** @type {ReturnType<typeof createSlackDirectory> | null} for the recipient's status note */
let directory = null;

/**
 * Send or discard a message an MCP client drafted, from the DM buttons. Only owners can decide.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackActionMiddlewareArgs<import('@slack/bolt').BlockButtonAction>} args
 * @returns {Promise<void>}
 */
export async function handleMcpSendDecision({ ack, body, client, logger }) {
  await ack();
  const startedAt = Date.now();
  const userId = body.user.id;
  if (!isWhitelisted(userId)) return;

  const action = body.actions[0];
  const draft = takeDraft(action.value || '');
  /** @type {'sent' | 'failed' | 'discarded'} */
  let outcome = 'discarded';
  let result = '';
  if (draft && action.action_id === SEND_ACTION) {
    directory ??= createSlackDirectory(client);
    try {
      const posted = await deliverMessage(client, directory, draft.target, draft.text, draft.attachment);
      outcome = posted.isError ? 'failed' : 'sent';
      result = posted.content[0].text;
    } finally {
      draft.attachment?.release();
    }
  } else {
    draft?.attachment?.release();
  }
  if (draft) {
    // The client's tool call was logged when it drafted; this records the owner's decision
    void recordUsage({
      ...ruleBasedRun('mcp', `slack_send_message ${outcome}`, startedAt),
      outcome: outcome === 'failed' ? 'error' : 'ok',
      userId,
      userName: draft.caller,
    });
  }

  try {
    if (body.channel?.id && body.message?.ts) {
      await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        text: draft ? `MCP message ${outcome}` : 'MCP draft expired',
        blocks: buildSendDecisionBlocks(draft, outcome, userId, result),
      });
    }
  } catch (e) {
    logger.error(`Failed to update MCP send approval message: ${e}`);
  }
}
