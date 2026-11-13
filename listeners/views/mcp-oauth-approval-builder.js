/** @typedef {import('@slack/types').KnownBlock} Block */

export const APPROVE_ACTION = 'mcp_oauth_approve';
export const DENY_ACTION = 'mcp_oauth_deny';

/**
 * DM asking an owner to approve an MCP sign-in.
 * @param {import('../../mcp/oauth.js').PendingRequest} request
 * @returns {Block[]}
 */
export function buildApprovalBlocks(request) {
  const callback = new URL(request.redirectUri).host;
  // For CIMD clients the client_id URL's origin is verified; the name is self-asserted
  const who = request.clientOrigin
    ? `*${request.clientName}* (verified identity: \`${new URL(request.clientOrigin).host}\`)`
    : `*${request.clientName}*`;
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:key: ${who} wants to connect to Fenix's tools (read-only).\nApprove only if you just started this connection yourself.`,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Sign-in returns to \`${callback}\` · expires <!date^${request.expiresAt}^{time}|in 5 minutes>`,
        },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          action_id: APPROVE_ACTION,
          value: request.id,
          text: { type: 'plain_text', text: 'Approve' },
        },
        {
          type: 'button',
          style: 'danger',
          action_id: DENY_ACTION,
          value: request.id,
          text: { type: 'plain_text', text: 'Deny' },
        },
      ],
    },
  ];
}

/**
 * The DM after a decision (buttons removed).
 * @param {string} clientName
 * @param {'approved' | 'denied' | 'expired'} outcome
 * @param {string} userId
 * @returns {Block[]}
 */
export function buildDecisionBlocks(clientName, outcome, userId) {
  const text =
    outcome === 'approved'
      ? `:white_check_mark: <@${userId}> approved *${clientName}*. It can now use Fenix's read-only tools.`
      : outcome === 'denied'
        ? `:no_entry: <@${userId}> denied *${clientName}*.`
        : ':hourglass: This sign-in request expired or was already decided. Start the connection again if needed.';
  return [{ type: 'section', text: { type: 'mrkdwn', text } }];
}
