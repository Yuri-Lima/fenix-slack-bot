import { createSlackDirectory, deliverMessage } from '../../agent/tools/slack.js';
import { takeDraft } from '../../mcp/send-approval.js';
import { isWhitelisted } from '../../utils/input-guard.js';
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
  const userId = body.user.id;
  if (!isWhitelisted(userId)) return;

  const action = body.actions[0];
  const draft = takeDraft(action.value || '');
  /** @type {'sent' | 'failed' | 'discarded'} */
  let outcome = 'discarded';
  let result = '';
  if (draft && action.action_id === SEND_ACTION) {
    directory ??= createSlackDirectory(client);
    const posted = await deliverMessage(client, directory, draft.target, draft.text);
    outcome = posted.isError ? 'failed' : 'sent';
    result = posted.content[0].text;
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
