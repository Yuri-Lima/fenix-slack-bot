import { LANGUAGES } from '../../utils/translate-prefs.js';

/** @typedef {import('@slack/types').KnownBlock} Block */
/** @typedef {import('../../utils/translate-prefs.js').TranslateLanguage} TranslateLanguage */

export const TRANSLATE_LANGUAGE_ACTION = 'translate_language';
export const TRANSLATE_STOP_ACTION = 'translate_stop';
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
  const other = /** @type {TranslateLanguage} */ (language === 'en' ? 'pt-BR' : 'en');
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
        {
          type: 'button',
          action_id: TRANSLATE_LANGUAGE_ACTION,
          text: { type: 'plain_text', text: `${LANGUAGES[other].flag} ${LANGUAGES[other].name}` },
          value: JSON.stringify({ ...ref, to: other }),
        },
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
