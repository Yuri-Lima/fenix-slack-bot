import { mightBeGerman, TRANSLATE_MODEL, translateMessages } from '../../agent/translate.js';
import { config } from '../../config.js';
import { threadKey } from '../../thread-context/index.js';
import { resolveUserName } from '../../utils/slack.js';
import { languageFor, translateUserIds } from '../../utils/translate-prefs.js';
import { recordUsage } from '../../utils/usage-store.js';
import { buildTranslation } from '../views/translation-builder.js';
import { isUserMessage } from './message.js';

// Translates German messages for owners who do not read German (config.translate.userIds). In the channels Fenix
// is in, a message is translated for such a person when it is in a thread they wrote in or were mentioned in, or is
// a top-level message that mentions them. Messages arriving close together in a thread are translated in one reply
// (config.translate.batchSeconds), posted in the thread with a mention of the person. Message text is held only
// until its batch is translated and never stored.

/** How long a thread's participants are trusted before Slack is asked again. */
const PARTICIPANTS_TTL_MS = 24 * 3600_000;
/** Threads whose participants are remembered; the oldest are forgotten first. */
const MAX_THREADS = 2000;
/** Pages of 200 replies read to find participants in a long thread. */
const MAX_REPLY_PAGES = 5;
/** Messages in one translation reply; a fuller batch is translated at once. */
export const MAX_BATCH = 10;

/** @type {Map<string, { ids: Set<string>, at: number }>} threadKey -> people to translate for who are in it */
const participants = new Map();

/**
 * @typedef {{ ts: string, user: string, text: string }} SourceMessage
 * @typedef {{ channel: string, threadTs: string, personId: string, items: SourceMessage[], timer?: NodeJS.Timeout }} Batch
 */

/** @type {Map<string, Batch>} threadKey:person -> messages waiting to be translated */
const pending = new Map();

/**
 * Remember that people take part in a thread. Without `create`, only a thread already looked up is updated (one
 * not looked up yet is read from Slack when needed, which finds them too).
 * @param {string} key
 * @param {string[]} ids
 * @param {boolean} [create]
 */
function noteParticipants(key, ids, create = false) {
  if (!ids.length) return;
  const known = participants.get(key);
  if (known) for (const id of ids) known.ids.add(id);
  else if (create) remember(key, new Set(ids));
}

/** @param {string} key @param {Set<string>} ids */
function remember(key, ids) {
  participants.delete(key);
  participants.set(key, { ids, at: Date.now() });
  if (participants.size > MAX_THREADS) participants.delete(/** @type {string} */ (participants.keys().next().value));
}

/**
 * The people to translate for who wrote in a thread or were mentioned in it.
 * @param {import('@slack/web-api').WebClient} client
 * @param {string} channel
 * @param {string} threadTs
 * @returns {Promise<Set<string>>}
 */
async function threadParticipants(client, channel, threadTs) {
  const key = threadKey(channel, threadTs);
  const cached = participants.get(key);
  if (cached && Date.now() - cached.at < PARTICIPANTS_TTL_MS) return cached.ids;
  const people = translateUserIds();
  /** @type {Set<string>} */
  const ids = new Set();
  /** @type {string | undefined} */
  let cursor;
  for (let page = 0; page < MAX_REPLY_PAGES && ids.size < people.length; page++) {
    const res = await client.conversations.replies({ channel, ts: threadTs, limit: 200, cursor });
    for (const m of res.messages || []) {
      for (const id of people) if (m.user === id || m.text?.includes(`<@${id}>`)) ids.add(id);
    }
    cursor = res.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  remember(key, ids);
  return ids;
}

/**
 * Slack mentions as plain names, so a translation never notifies anyone and the model never sees user IDs:
 * people become "@Name", groups their handle, and @here / @channel / @everyone plain text.
 * @param {import('@slack/web-api').WebClient} client
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function plainMentions(client, text) {
  const ids = [...new Set([...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]))];
  const names = new Map(
    await Promise.all(ids.map(async (id) => /** @type {[string, string]} */ ([id, await resolveUserName(client, id)]))),
  );
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id) => `@${names.get(id)}`)
    .replace(/<!subteam\^[A-Z0-9]+\|([^>]+)>/g, '$1')
    .replace(/<!subteam\^[A-Z0-9]+>/g, '@group')
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1');
}

/**
 * Text for the language check: without links, mentions, code and emoji codes.
 * @param {string} text
 * @returns {string}
 */
const checkable = (text) =>
  text
    .replace(/```[\s\S]*?```|`[^`]*`/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/:[a-z0-9_+-]+:/g, ' ');

/**
 * Translate messages for a person and record the run in the usage log (as their agent usage, so it shows in
 * reports and counts toward their spend).
 * @param {import('@slack/web-api').WebClient} client
 * @param {SourceMessage[]} items
 * @param {import('../../utils/translate-prefs.js').TranslateLanguage} language
 * @param {string} personId
 * @param {{ anyLanguage?: boolean }} [options] - see translateMessages
 * @returns {Promise<{ shown: import('../views/translation-builder.js').TranslatedMessage[], ts: string[] }>} the
 *   messages that needed translating, translated, and their ts
 */
export async function translateFor(client, items, language, personId, options = {}) {
  const userName = await resolveUserName(client, personId);
  const base = {
    kind: /** @type {const} */ ('agent'),
    userId: personId,
    userName,
    where: /** @type {const} */ ('channel'),
  };
  const started = Date.now();
  try {
    const messages = await Promise.all(
      items.map(async (m) => ({
        author: await resolveUserName(client, m.user),
        text: await plainMentions(client, m.text),
      })),
    );
    const result = await translateMessages(messages, language, options);
    await recordUsage({
      ...base,
      outcome: 'ok',
      subject: 'translate',
      models: { [TRANSLATE_MODEL]: result.tokens },
      costUsd: result.tokens.costUsd,
      turns: 1,
      durationMs: result.durationMs,
      tools: { translate: items.length },
    });
    /** @type {import('../views/translation-builder.js').TranslatedMessage[]} */
    const shown = [];
    /** @type {string[]} */
    const ts = [];
    result.translations.forEach((t, i) => {
      if (!t) return;
      shown.push({ author: messages[i].author, text: t });
      ts.push(items[i].ts);
    });
    return { shown, ts };
  } catch (e) {
    await recordUsage({
      ...base,
      outcome: 'error',
      subject: 'translate',
      error: 'translate_failed',
      models: {},
      costUsd: 0,
      turns: 0,
      durationMs: Date.now() - started,
      tools: {},
    });
    throw e;
  }
}

/**
 * Translate a waiting batch and post the reply in its thread.
 * @param {import('@slack/web-api').WebClient} client
 * @param {{ error: Function }} logger
 * @param {Batch} batch
 */
async function flush(client, logger, batch) {
  const { channel, threadTs, personId, items } = batch;
  const language = languageFor(personId, threadKey(channel, threadTs));
  if (!language) return; // stopped while the batch waited
  try {
    const { shown, ts } = await translateFor(client, items, language, personId);
    if (!shown.length) return;
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      unfurl_links: false,
      unfurl_media: false,
      ...buildTranslation({ c: channel, t: threadTs, ts, o: personId }, language, shown),
    });
  } catch (e) {
    logger.error(`Translation failed in ${channel}/${threadTs}: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * Add a message to the person's batch in the thread; the batch is translated batchSeconds after its first
 * message, or at once when full.
 * @param {import('@slack/web-api').WebClient} client
 * @param {{ error: Function }} logger
 * @param {Omit<Batch, 'items' | 'timer'>} target
 * @param {SourceMessage} message
 */
function enqueue(client, logger, target, message) {
  const key = `${threadKey(target.channel, target.threadTs)}:${target.personId}`;
  let batch = pending.get(key);
  if (!batch) {
    const created = /** @type {Batch} */ ({ ...target, items: [] });
    created.timer = setTimeout(() => {
      pending.delete(key);
      void flush(client, logger, created);
    }, config.translate.batchSeconds * 1000);
    created.timer.unref?.();
    pending.set(key, created);
    batch = created;
  }
  batch.items.push(message);
  if (batch.items.length >= MAX_BATCH) {
    clearTimeout(batch.timer);
    pending.delete(key);
    void flush(client, logger, batch);
  }
}

/**
 * Watch channel messages for German text to translate for the people in config.translate.userIds.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'message'>} args
 * @returns {Promise<void>}
 */
export async function handleTranslateWatch({ client, event, logger }) {
  const people = translateUserIds();
  if (!people.length) return;
  const broadcast = 'subtype' in event && event.subtype === 'thread_broadcast';
  if (!(isUserMessage(event) || broadcast)) return;
  const e = /** @type {import('@slack/types').GenericMessageEvent} */ (event);
  if (e.bot_id || e.channel_type === 'im' || !e.user) return;
  const text = e.text || '';
  const threadTs = e.thread_ts || e.ts;
  const key = threadKey(e.channel, threadTs);
  const mentioned = people.filter((id) => text.includes(`<@${id}>`));
  noteParticipants(key, [...(people.includes(e.user) ? [e.user] : []), ...mentioned], !e.thread_ts);
  if (!mightBeGerman(checkable(text))) return;

  try {
    const inThread = e.thread_ts ? [...(await threadParticipants(client, e.channel, threadTs))] : [];
    const forIds = [...new Set([...inThread, ...mentioned])].filter((id) => id !== e.user && languageFor(id, key));
    for (const personId of forIds) {
      enqueue(client, logger, { channel: e.channel, threadTs, personId }, { ts: e.ts, user: e.user, text });
    }
  } catch (err) {
    logger.error(`Translation check failed in ${e.channel}: ${err instanceof Error ? err.message : err}`);
  }
}

/** Forget remembered threads and drop waiting batches (tests). */
export function resetTranslateWatch() {
  participants.clear();
  for (const b of pending.values()) clearTimeout(b.timer);
  pending.clear();
}
