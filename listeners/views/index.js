import { handleIssueSubmission } from './issue-modal.js';
import { handleYouTrackTicketModal } from './youtrack-ticket-modal.js';

/**
 * Register view listeners with the Bolt app.
 * @param {import('@slack/bolt').App} app
 * @returns {void}
 */
export function register(app) {
  app.view('issue_submission', handleIssueSubmission);
  app.view('youtrack_ticket_modal', handleYouTrackTicketModal);
}
