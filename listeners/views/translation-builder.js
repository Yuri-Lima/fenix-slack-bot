import { LANGUAGES } from '../../utils/translate-prefs.js';

/** @typedef {import('@slack/types').KnownBlock} Block */
/** @typedef {import('../../utils/translate-prefs.js').TranslateLanguage} TranslateLanguage */

export const TRANSLATE_LANGUAGE_ACTION = 'translate_language';
export const TRANSLATE_STOP_ACTION = 'translate_stop';
export const TRANSLATE_SHORTCUT = 'translate_message';
export const TRANSLATE_MODAL_LANGUAGE_ACTION = 'translate_modal_language';
/** Characters of a message the shortcut's modal keeps (in its private_metadata, at most 3000) and translates. */
export const MODAL_TEXT_CHARS = 2500;
/** Slack's limit for a section's text, less room for the author's name. */
const SECTION_CHARS = 2900;

/**
 * What the buttons need to translate the same messages again: channel, thread, the messages' ts, and whose
 * translation it is.
 * @typedef {{ c: string, t: string, ts: string[], o: string }} TranslationRef
 */

/**
 * A translated message as it is shown: who wrote it and the translation.
 * @typedef {{ author: string, text: string }} TranslatedMessage
 */

/**
 * Text the model returned, made safe to post: it cannot mention or notify anyone (people's mentions were turned
 * into names before translating; this also catches any the model wrote itself).
 * @param {string} text
 * @returns {string}
 */
export function noMentions(text) {
  return text.replace(/<([@!])/g, '&lt;$1');
}

/** @param {TranslateLanguage} language @returns {TranslateLanguage} the one the buttons switch to */
const otherLanguage = (language) => (language === 'en' ? 'pt-BR' : 'en');

/**
 * Button that switches to a language.
 * @param {string} actionId
 * @param {TranslateLanguage} language
 * @param {string} value
 */
const languageButton = (actionId, language, value) => ({
  type: /** @type {const} */ ('button'),
  action_id: actionId,
  text: { type: /** @type {const} */ ('plain_text'), text: `${LANGUAGES[language].flag} ${LANGUAGES[language].name}` },
  value,
});

/**
 * Translation reply: a line that mentions the person, one section per translated message, and buttons to switch
 * the language or stop translations in the thread.
 * @param {TranslationRef} ref
 * @param {TranslateLanguage} language
 * @param {TranslatedMessage[]} messages
 * @returns {{ text: string, blocks: Block[] }}
 */
export function buildTranslation(ref, language, messages) {
  const { flag, label } = LANGUAGES[language];
  const other = otherLanguage(language);
  /** @type {Block[]} */
  const blocks = [
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${flag} <@${ref.o}> · translated into ${label}` }] },
    ...messages.map(
      (m) =>
        /** @type {Block} */ ({
          type: 'section',
          text: { type: 'mrkdwn', text: `*${m.author}:* ${noMentions(m.text).slice(0, SECTION_CHARS)}` },
        }),
    ),
    {
      type: 'actions',
      elements: [
        languageButton(TRANSLATE_LANGUAGE_ACTION, other, JSON.stringify({ ...ref, to: other })),
        {
          type: 'button',
          action_id: TRANSLATE_STOP_ACTION,
          text: { type: 'plain_text', text: 'Stop in this thread' },
          value: JSON.stringify(ref),
        },
      ],
    },
  ];
  return { text: `${flag} <@${ref.o}> translation into ${label}`, blocks };
}

/**
 * The same reply once translations are stopped in its thread: the buttons give way to how to resume.
 * @param {Block[]} blocks - the reply's current blocks
 * @returns {Block[]}
 */
export function stoppedTranslation(blocks) {
  return [
    ...blocks.filter((b) => b.type !== 'actions'),
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'Translations stopped in this thread. Mention Fenix here with `translate on` to resume.',
        },
      ],
    },
  ];
}

/**
 * The message a Translate message modal translates, kept in the modal itself (never stored by Fenix): its author's
 * Slack ID, its text (at most MODAL_TEXT_CHARS) and whether that is cut.
 * @typedef {{ u: string, t: string, cut?: boolean }} ModalSource
 */

/**
 * @param {Block[]} blocks
 * @param {string} [metadata]
 */
const modalView = (blocks, metadata = '') => ({
  type: /** @type {const} */ ('modal'),
  callback_id: 'translate_modal',
  title: { type: /** @type {const} */ ('plain_text'), text: 'Translate message' },
  close: { type: /** @type {const} */ ('plain_text'), text: 'Close' },
  private_metadata: metadata,
  blocks,
});

/**
 * A Translate message modal that only says something: translating, nothing to translate, or why it cannot.
 * @param {string} text - mrkdwn
 */
export function noticeModal(text) {
  return modalView([{ type: 'section', text: { type: 'mrkdwn', text } }]);
}

/**
 * The Translate message modal with a translation, or a note that the message is already in that language, and a
 * button to translate it into the other language.
 * @param {ModalSource} source
 * @param {string} author - display name
 * @param {TranslateLanguage} language
 * @param {string | null} translation
 */
export function translationModal(source, author, language, translation) {
  const { flag, label } = LANGUAGES[language];
  const note = source.cut ? ` · the first ${MODAL_TEXT_CHARS.toLocaleString('en')} characters` : '';
  const body = translation ? chunks(noMentions(translation)) : [`_This message is already in ${label}._`];
  /** @type {Block[]} */
  const blocks = [
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${flag} ${label} · ${author}'s message${note}` }] },
    ...body.map((text) => /** @type {Block} */ ({ type: 'section', text: { type: 'mrkdwn', text } })),
    {
      type: 'actions',
      elements: [languageButton(TRANSLATE_MODAL_LANGUAGE_ACTION, otherLanguage(language), otherLanguage(language))],
    },
  ];
  return modalView(blocks, JSON.stringify(source));
}

/**
 * Text split into pieces that fit a section.
 * @param {string} text
 * @returns {string[]}
 */
function chunks(text) {
  const parts = [];
  for (let i = 0; i < text.length; i += SECTION_CHARS) parts.push(text.slice(i, i + SECTION_CHARS));
  return parts;
}
