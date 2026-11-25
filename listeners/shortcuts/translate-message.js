import { resolveUserName } from '../../utils/slack.js';
import { settingsOf, translateUserIds } from '../../utils/translate-prefs.js';
import { translateFor } from '../events/translate-watch.js';
import { MODAL_TEXT_CHARS, noticeModal, translationModal } from '../views/translation-builder.js';

// The "Translate message" message shortcut: translates one message from any language into the clicker's language
// (English unless they chose Brazilian Portuguese), in a modal only they see, with a button for the other
// language. It works in any conversation, even ones Fenix is not in, because Slack sends the message's text with
// the shortcut. For the owners in config.translate.userIds only.

/**
 * What the modal keeps of the message: its author and text, cut so the JSON fits Slack's private_metadata.
 * @param {string} user
 * @param {string} text
 * @returns {import('../views/translation-builder.js').ModalSource}
 */
export function modalSource(user, text) {
  let t = text.slice(0, MODAL_TEXT_CHARS);
  // Escaped quotes and line breaks make the JSON longer than the text; Slack allows 3000 characters
  while (JSON.stringify({ u: user, t, cut: true }).length > 3000) t = t.slice(0, -100);
  return { u: user, t, ...(t.length < text.length && { cut: true }) };
}

/**
 * Translate a modal's message and show the result in it.
 * @param {import('@slack/web-api').WebClient} client
 * @param {string} viewId
 * @param {import('../views/translation-builder.js').ModalSource} source
 * @param {import('../../utils/translate-prefs.js').TranslateLanguage} language
 * @param {string} personId - who asked (the usage is theirs)
 */
async function showTranslation(client, viewId, source, language, personId) {
  try {
    const { shown } = await translateFor(client, [{ ts: '', user: source.u, text: source.t }], language, personId, {
      anyLanguage: true,
    });
    const author = await resolveUserName(client, source.u);
    await client.views.update({
      view_id: viewId,
      view: translationModal(source, author, language, shown[0]?.text ?? null),
    });
  } catch (e) {
    await client.views.update({
      view_id: viewId,
      view: noticeModal(':warning: The translation failed. Please try again in a moment.'),
    });
    throw e;
  }
}

/**
 * Handle the "Translate message" shortcut.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackShortcutMiddlewareArgs} args
 * @returns {Promise<void>}
 */
export async function handleTranslateShortcut({ ack, shortcut, client, logger }) {
  await ack();
  try {
    const sc = /** @type {any} */ (shortcut);
    const userId = sc.user.id;
    if (!translateUserIds().includes(userId)) {
      await client.views.open({
        trigger_id: sc.trigger_id,
        view: noticeModal('Translation is not set up for you. Ask the Fenix owner to add you.'),
      });
      return;
    }
    const text = sc.message?.text?.trim() || '';
    if (!text) {
      await client.views.open({
        trigger_id: sc.trigger_id,
        view: noticeModal('This message has no text to translate.'),
      });
      return;
    }
    // Open the modal at once: the trigger expires after 3 seconds, and translating can take longer
    const opened = await client.views.open({
      trigger_id: sc.trigger_id,
      view: noticeModal(':hourglass_flowing_sand: Translating…'),
    });
    const source = modalSource(sc.message.user || sc.message.bot_id || 'unknown', text);
    await showTranslation(client, /** @type {string} */ (opened.view?.id), source, settingsOf(userId).language, userId);
  } catch (e) {
    logger.error(`Translate shortcut failed: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * The modal's language button: translate the same message into the other language.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackActionMiddlewareArgs} args
 * @returns {Promise<void>}
 */
export async function handleTranslateModalLanguage({ ack, body, client, logger }) {
  await ack();
  try {
    const b = /** @type {any} */ (body);
    if (!translateUserIds().includes(b.user.id)) return;
    const language = b.actions[0].value;
    await client.views.update({ view_id: b.view.id, view: noticeModal(':hourglass_flowing_sand: Translating…') });
    await showTranslation(client, b.view.id, JSON.parse(b.view.private_metadata), language, b.user.id);
  } catch (e) {
    logger.error(`Translating the modal again failed: ${e instanceof Error ? e.message : e}`);
  }
}
