import { threadKey } from '../../thread-context/index.js';
import { setPrefs } from '../../utils/translate-prefs.js';
import { translateFor } from '../events/translate-watch.js';
import { buildTranslation, stoppedTranslation } from '../views/translation-builder.js';

// Buttons under a translation reply. Only the person it was translated for may use them: "Português" / "English"
// translates the same messages again into the other language (and keeps that language for the thread), and
// "Stop in this thread" stops translations there.

/** Pages of 200 replies read to find the translated messages again. */
const MAX_REPLY_PAGES = 5;

/**
 * @param {any} body
 * @returns {import('../views/translation-builder.js').TranslationRef & { to?: import('../../utils/translate-prefs.js').TranslateLanguage }}
 */
const refOf = (body) => JSON.parse(body.actions[0].value);

/**
 * True when the clicker is the person the translation is for; otherwise tells them so.
 * @param {import('@slack/web-api').WebClient} client
 * @param {any} body
 * @param {string} owner
 */
async function isTheirs(client, body, owner) {
  if (body.user.id === owner) return true;
  await client.chat.postEphemeral({
    channel: body.channel.id,
    user: body.user.id,
    thread_ts: body.message.thread_ts,
    text: `These buttons are for <@${owner}>'s translation.`,
  });
  return false;
}

/**
 * The translated messages, read again from the thread (their text is never stored).
 * @param {import('@slack/web-api').WebClient} client
 * @param {import('../views/translation-builder.js').TranslationRef} ref
 * @returns {Promise<import('../events/translate-watch.js').SourceMessage[]>}
 */
async function originals(client, ref) {
  const wanted = new Set(ref.ts);
  /** @type {import('../events/translate-watch.js').SourceMessage[]} */
  const found = [];
  /** @type {string | undefined} */
  let cursor;
  for (let page = 0; page < MAX_REPLY_PAGES && found.length < wanted.size; page++) {
    const res = await client.conversations.replies({ channel: ref.c, ts: ref.t, limit: 200, cursor });
    for (const m of res.messages || []) {
      if (m.ts && m.user && wanted.has(m.ts)) found.push({ ts: m.ts, user: m.user, text: m.text || '' });
    }
    cursor = res.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return found.sort((a, b) => Number(a.ts) - Number(b.ts));
}

/**
 * Translate the reply's messages again into the other language.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackActionMiddlewareArgs} args
 * @returns {Promise<void>}
 */
export async function handleTranslateLanguage({ ack, body, client, logger }) {
  await ack();
  try {
    const { to, ...ref } = refOf(body);
    if (!to || !(await isTheirs(client, body, ref.o))) return;
    setPrefs(ref.o, { language: to, on: true }, threadKey(ref.c, ref.t));
    const items = await originals(client, ref);
    const { shown, ts } = items.length ? await translateFor(client, items, to, ref.o) : { shown: [], ts: [] };
    const b = /** @type {any} */ (body);
    if (!shown.length) {
      await client.chat.postEphemeral({
        channel: ref.c,
        user: ref.o,
        thread_ts: ref.t,
        text: 'Those messages were deleted or are no longer German, so there is nothing to translate again.',
      });
      return;
    }
    await client.chat.update({
      channel: b.channel.id,
      ts: b.message.ts,
      ...buildTranslation({ ...ref, ts }, to, shown),
    });
  } catch (e) {
    logger.error(`Failed to translate again: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * Stop translations in the reply's thread.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackActionMiddlewareArgs} args
 * @returns {Promise<void>}
 */
export async function handleTranslateStop({ ack, body, client, logger }) {
  await ack();
  try {
    const ref = refOf(body);
    if (!(await isTheirs(client, body, ref.o))) return;
    setPrefs(ref.o, { on: false }, threadKey(ref.c, ref.t));
    const b = /** @type {any} */ (body);
    await client.chat.update({
      channel: b.channel.id,
      ts: b.message.ts,
      text: b.message.text,
      blocks: stoppedTranslation(b.message.blocks),
    });
  } catch (e) {
    logger.error(`Failed to stop translations: ${e instanceof Error ? e.message : e}`);
  }
}
