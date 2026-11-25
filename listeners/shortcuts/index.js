import { TRANSLATE_SHORTCUT } from '../views/translation-builder.js';
import { handleTranslateShortcut } from './translate-message.js';
import { handleYouTrackShortcut } from './youtrack-ticket.js';

/**
 * Register shortcut listeners with the Bolt app.
 * @param {import('@slack/bolt').App} app
 * @returns {void}
 */
export function register(app) {
  app.shortcut('create_youtrack_ticket', handleYouTrackShortcut);
  app.shortcut(TRANSLATE_SHORTCUT, handleTranslateShortcut);
}
