import { join } from 'node:path';
import { config, resolvePath } from '../config.js';
import { isOwner } from './input-guard.js';
import { readJsonFile, writeJsonFile } from './json-file.js';

// What each person chose for translations (listeners/events/translate-watch.js): their language and whether
// translations are on, plus per-thread choices made in a thread (its language, or off). Kept in data/ so a
// restart keeps them; thread choices are forgotten after THREAD_KEEP_DAYS.

const STORE_FILE = join(resolvePath(config.dataDir), 'translate-prefs.json');
const THREAD_KEEP_DAYS = 60;
const DAY_MS = 24 * 3600_000;

/** @typedef {'en' | 'pt-BR'} TranslateLanguage */

/** Languages Fenix translates into: label for the model, flag and name for Slack. */
export const LANGUAGES = /** @type {const} */ ({
  en: { label: 'English', flag: '🇬🇧', name: 'English' },
  'pt-BR': { label: 'Brazilian Portuguese', flag: '🇧🇷', name: 'Português' },
});

/**
 * @typedef {Object} ThreadChoice
 * @property {TranslateLanguage} [language]
 * @property {boolean} [off]
 * @property {string} at - ISO time it was chosen
 */

/**
 * @typedef {Object} PersonPrefs
 * @property {TranslateLanguage} [language] - Absent: config.translate.defaultLanguage
 * @property {boolean} [off] - Translations stopped everywhere
 * @property {Record<string, ThreadChoice>} [threads] - threadKey -> choice made in that thread
 */

/** @type {Record<string, PersonPrefs> | null} */
let cache = null;

/** @returns {Record<string, PersonPrefs>} */
function all() {
  cache ??= readJsonFile(STORE_FILE, {});
  return /** @type {Record<string, PersonPrefs>} */ (cache);
}

/** Save, dropping thread choices older than THREAD_KEEP_DAYS. */
function save() {
  const oldest = new Date(Date.now() - THREAD_KEEP_DAYS * DAY_MS).toISOString();
  for (const p of Object.values(all())) {
    if (!p.threads) continue;
    for (const [key, t] of Object.entries(p.threads)) if (t.at < oldest) delete p.threads[key];
  }
  writeJsonFile(STORE_FILE, all());
}

/** @param {string} userId @returns {PersonPrefs} */
function person(userId) {
  const prefs = all();
  prefs[userId] ??= {};
  return prefs[userId];
}

/**
 * People Fenix translates for: owners listed in config.translate.userIds.
 * @returns {string[]}
 */
export function translateUserIds() {
  return config.translate.userIds.filter(isOwner);
}

/**
 * The language for a person in a thread, or null when translations are off there.
 * @param {string} userId
 * @param {string} [key] - threadKey of the thread
 * @returns {TranslateLanguage | null}
 */
export function languageFor(userId, key) {
  const p = all()[userId] || {};
  const thread = key ? p.threads?.[key] : undefined;
  if (thread?.off) return null;
  if (thread?.language) return thread.language;
  if (p.off) return null;
  return p.language || config.translate.defaultLanguage;
}

/**
 * A person's settings: their language, whether translations are on, and how many threads have their own choice.
 * @param {string} userId
 * @returns {{ language: TranslateLanguage, on: boolean, threadChoices: number }}
 */
export function settingsOf(userId) {
  const p = all()[userId] || {};
  return {
    language: p.language || config.translate.defaultLanguage,
    on: !p.off,
    threadChoices: Object.keys(p.threads || {}).length,
  };
}

/**
 * Change a person's settings, everywhere or in one thread. Turning translations on everywhere also clears
 * the threads they were stopped in.
 * @param {string} userId
 * @param {{ language?: TranslateLanguage, on?: boolean }} change
 * @param {string} [key] - threadKey: change only that thread
 */
export function setPrefs(userId, change, key) {
  const p = person(userId);
  if (key) {
    p.threads ??= {};
    const t = { ...p.threads[key], at: new Date().toISOString() };
    if (change.language) t.language = change.language;
    if (change.on !== undefined) {
      if (change.on) delete t.off;
      else t.off = true;
    }
    p.threads[key] = t;
  } else {
    if (change.language) p.language = change.language;
    if (change.on !== undefined) {
      if (change.on) {
        delete p.off;
        for (const t of Object.values(p.threads || {})) delete t.off;
      } else p.off = true;
    }
  }
  save();
}

/** Forget every choice (tests). */
export function resetTranslatePrefs() {
  cache = {};
  save();
}
