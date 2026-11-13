import { decideAuthorization } from '../../mcp/oauth.js';
import { isWhitelisted } from '../../utils/input-guard.js';
import { APPROVE_ACTION, buildDecisionBlocks } from '../views/mcp-oauth-approval-builder.js';

/**
 * Approve or deny an MCP sign-in from the DM buttons. Only owners can decide.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackActionMiddlewareArgs<import('@slack/bolt').BlockButtonAction>} args
 * @returns {Promise<void>}
 */
export async function handleMcpOAuthDecision({ ack, body, client, logger }) {
  await ack();
  const userId = body.user.id;
  if (!isWhitelisted(userId)) return;

  const action = body.actions[0];
  const decision = action.action_id === APPROVE_ACTION ? 'approved' : 'denied';
  const request = decideAuthorization(action.value || '', decision, userId);

  try {
    if (body.channel?.id && body.message?.ts) {
      const outcome = request ? decision : 'expired';
      await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        text: `MCP sign-in ${outcome}`,
        blocks: buildDecisionBlocks(request?.clientName || 'The client', outcome, userId),
      });
    }
  } catch (e) {
    logger.error(`Failed to update MCP sign-in message: ${e}`);
  }
}
