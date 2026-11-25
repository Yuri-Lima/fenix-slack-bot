import { threadKey } from '../../thread-context/index.js';
import { LANGUAGES, languageFor, setPrefs, settingsOf, translateUserIds } from '../../utils/translate-prefs.js';

// Owner commands for translations, run in code (no AI tokens):
//   translate                      the current settings
//   translate pt | translate en    the language translations are in
//   translate off | translate on   stop or resume translations
// In a DM they change the person's settings; mentioning Fenix in a thread with them changes only that thread.

const LANGUAGE_WORDS = /** @type {const} */ ({
  en: ['en', 'english', 'inglês', 'ingles'],
  'pt-BR': ['pt', 'pt-br', 'br', 'portuguese', 'português', 'portugues'],
});

/**
 * @typedef {{ action: 'status' } | { action: 'set', language?: import('../../utils/translate-prefs.js').TranslateLanguage, on?: boolean }} TranslateCommand
 */

/**
 * The command when the text is a well-formed `translate …` command, else null (anything else, such as
 * "translate this", goes to the agent as usual).
 * @param {string} text - Message text with Fenix's mention removed
 * @returns {TranslateCommand | null}
 */
export function parseTranslateCommand(text) {
  const m = /^translate(?:\s+(\S+))?$/i.exec(text.trim().replace(/[.!]$/, ''));
  if (!m) return null;
  const word = (m[1] || 'status').toLowerCase();
  if (word === 'status') return { action: 'status' };
  if (word === 'on' || word === 'off') return { action: 'set', on: word === 'on' };
  for (const [language, words] of Object.entries(LANGUAGE_WORDS)) {
    if (/** @type {readonly string[]} */ (words).includes(word)) {
      return {
        action: 'set',
        language: /** @type {import('../../utils/translate-prefs.js').TranslateLanguage} */ (language),
        on: true,
      };
    }
  }
  return null;
}

const HELP =
  'Commands: `translate pt`, `translate en`, `translate off`, `translate on`. In a DM they change your settings; ' +
  'mention Fenix with them in a thread to change only that thread.';

/** @param {import('../../utils/translate-prefs.js').TranslateLanguage} language */
const languageLabel = (language) => `${LANGUAGES[language].flag} ${LANGUAGES[language].label}`;

/**
 * Run a translate command and return the answer. Only people in config.translate.userIds have settings.
 * @param {string} userId
 * @param {TranslateCommand} command
 * @param {{ channel: string, threadTs: string } | null} thread - the thread when sent by mentioning Fenix there
 * @returns {string}
 */
export function runTranslateCommand(userId, command, thread) {
  if (!translateUserIds().includes(userId)) {
    return 'Translations are not set up for you. Add your Slack ID to `translate.userIds` in fenix.config.json.';
  }
  const key = thread ? threadKey(thread.channel, thread.threadTs) : undefined;
  if (command.action === 'set') setPrefs(userId, command, key);
  const language = languageFor(userId, key);
  if (thread) {
    return language
      ? `Translations in this thread: *on*, into ${languageLabel(language)}.`
      : 'Translations in this thread: *off*. Mention me here with `translate on` to resume.';
  }
  const s = settingsOf(userId);
  const own = s.threadChoices ? ` ${s.threadChoices} thread(s) have their own choice.` : '';
  return (
    `Translations: *${s.on ? 'on' : 'off'}*, into ${languageLabel(s.language)}. German messages are translated in ` +
    `threads you write in or are mentioned in, in the channels I am in.${own}\n${HELP}`
  );
}
