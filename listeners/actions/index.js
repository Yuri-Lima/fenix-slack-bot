import { APPROVE_ACTION, DENY_ACTION } from '../views/mcp-oauth-approval-builder.js';
import { DISCARD_ACTION, SEND_ACTION } from '../views/mcp-send-approval-builder.js';
import { TRANSLATE_LANGUAGE_ACTION, TRANSLATE_STOP_ACTION } from '../views/translation-builder.js';
import { handleFeedbackButton } from './feedback-buttons.js';
import { handleMcpOAuthDecision } from './mcp-oauth-approval.js';
import { handleMcpSendDecision } from './mcp-send-approval.js';
import { handleTranslateLanguage, handleTranslateStop } from './translate-buttons.js';

/**
 * Register action listeners with the Bolt app.
 * @param {import('@slack/bolt').App} app
 * @returns {void}
 */
export function register(app) {
  app.action('feedback', handleFeedbackButton);
  app.action(APPROVE_ACTION, handleMcpOAuthDecision);
  app.action(DENY_ACTION, handleMcpOAuthDecision);
  app.action(SEND_ACTION, handleMcpSendDecision);
  app.action(DISCARD_ACTION, handleMcpSendDecision);
  app.action(TRANSLATE_LANGUAGE_ACTION, handleTranslateLanguage);
  app.action(TRANSLATE_STOP_ACTION, handleTranslateStop);
}
