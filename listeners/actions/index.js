import { APPROVE_ACTION, DENY_ACTION } from '../views/mcp-oauth-approval-builder.js';
import { handleFeedbackButton } from './feedback-buttons.js';
import { handleMcpOAuthDecision } from './mcp-oauth-approval.js';

/**
 * Register action listeners with the Bolt app.
 * @param {import('@slack/bolt').App} app
 * @returns {void}
 */
export function register(app) {
  app.action('feedback', handleFeedbackButton);
  app.action(APPROVE_ACTION, handleMcpOAuthDecision);
  app.action(DENY_ACTION, handleMcpOAuthDecision);
}
