import { handleYouTrackTicketModal } from './youtrack-ticket-modal.js';

/**
 * Register view listeners with the Bolt app.
 * @param {import('@slack/bolt').App} app
 * @returns {void}
 */
export function register(app) {
  app.view('youtrack_ticket_modal', handleYouTrackTicketModal);
}
