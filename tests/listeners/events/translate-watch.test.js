import assert from 'node:assert';
import { beforeEach, describe, it, mock } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

// The model call is faked: every message counts as German unless its text starts with "EN:"
const translateMessages = mock.fn(async (/** @type {any[]} */ messages, /** @type {string} */ language) => ({
  translations: messages.map((m) => (m.text.startsWith('EN:') ? null : `[${language}] ${m.text}`)),
  tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, costUsd: 0.000035 },
  durationMs: 5,
}));
mock.module('../../../agent/translate.js', {
  namedExports: {
    TRANSLATE_MODEL: 'claude-haiku-5-5',
    translateMessages,
    mightBeGerman: (/** @type {string} */ t) => !/^\s*english only/i.test(t),
  },
});

const { handleTranslateWatch, resetTranslateWatch } = await import('../../../listeners/events/translate-watch.js');
const { handleTranslateLanguage, handleTranslateStop } = await import(
  '../../../listeners/actions/translate-buttons.js'
);
const { threadKey } = await import('../../../thread-context/index.js');
const { languageFor, resetTranslatePrefs, setPrefs } = await import('../../../utils/translate-prefs.js');

const OWNER = 'U0OWNER';
const BATCH_WAIT_MS = 150; // fixture batchSeconds is 0.05

/** @param {any[]} thread - messages conversations.replies returns */
function fakeClient(thread = []) {
  return {
    users: { info: mock.fn(async ({ user }) => ({ user: { real_name: `Name-${user}` } })) },
    conversations: { replies: mock.fn(async () => ({ messages: thread })) },
    chat: {
      postMessage: mock.fn(async () => ({ ok: true })),
      postEphemeral: mock.fn(async () => ({ ok: true })),
      update: mock.fn(async () => ({ ok: true })),
    },
  };
}
const logger = { error: mock.fn() };
const msg = (/** @type {Record<string, any>} */ fields) => ({ channel: 'C1', channel_type: 'channel', ...fields });

describe('handleTranslateWatch', () => {
  beforeEach(() => {
    resetTranslateWatch();
    resetTranslatePrefs();
    translateMessages.mock.resetCalls();
  });

  it('translates German replies in a thread the owner wrote in, in one reply that mentions them', async () => {
    const client = fakeClient([
      { ts: '1.0', user: 'U0ANNA', text: 'Frage' },
      { ts: '1.5', user: OWNER, text: 'hi' },
    ]);
    await handleTranslateWatch({
      client,
      logger,
      event: msg({ ts: '2.0', thread_ts: '1.0', user: 'U0ANNA', text: 'Wer fixt das?' }),
    });
    await handleTranslateWatch({
      client,
      logger,
      event: msg({ ts: '3.0', thread_ts: '1.0', user: 'U0BEN', text: 'Wichtig, <@U0CARL>!' }),
    });
    await sleep(BATCH_WAIT_MS);

    assert.strictEqual(client.conversations.replies.mock.callCount(), 1, 'participants are looked up once');
    assert.strictEqual(translateMessages.mock.callCount(), 1, 'one model call for the batch');
    const [sent, language] = translateMessages.mock.calls[0].arguments;
    assert.strictEqual(language, 'en');
    assert.deepStrictEqual(sent, [
      { author: 'Name-U0ANNA', text: 'Wer fixt das?' },
      { author: 'Name-U0BEN', text: 'Wichtig, @Name-U0CARL!' },
    ]);
    assert.strictEqual(client.chat.postMessage.mock.callCount(), 1);
    const post = client.chat.postMessage.mock.calls[0].arguments[0];
    assert.strictEqual(post.thread_ts, '1.0');
    assert.match(post.text, /<@U0OWNER>/);
    assert.strictEqual(post.blocks[2].text.text, '*Name-U0BEN:* [en] Wichtig, @Name-U0CARL!');
    assert.deepStrictEqual(JSON.parse(post.blocks.at(-1).elements[1].value).ts, ['2.0', '3.0']);
  });

  it("stays silent in threads the owner is not in, and on the owner's own messages", async () => {
    const client = fakeClient([{ ts: '1.0', user: 'U0ANNA', text: 'Frage' }]);
    await handleTranslateWatch({
      client,
      logger,
      event: msg({ ts: '2.0', thread_ts: '1.0', user: 'U0BEN', text: 'Ja' }),
    });
    await handleTranslateWatch({ client, logger, event: msg({ ts: '5.0', user: OWNER, text: 'Hallo <@U0X>' }) });
    await sleep(BATCH_WAIT_MS);
    assert.strictEqual(translateMessages.mock.callCount(), 0);
    assert.strictEqual(client.chat.postMessage.mock.callCount(), 0);
  });

  it('answers a top-level message that mentions the owner in its own thread, without reading the thread', async () => {
    const client = fakeClient();
    await handleTranslateWatch({
      client,
      logger,
      event: msg({ ts: '7.0', user: 'U0ANNA', text: '<@U0OWNER> kannst du schauen?' }),
    });
    await sleep(BATCH_WAIT_MS);
    assert.strictEqual(client.conversations.replies.mock.callCount(), 0);
    assert.strictEqual(client.chat.postMessage.mock.calls[0].arguments[0].thread_ts, '7.0');
    assert.deepStrictEqual(translateMessages.mock.calls[0].arguments[0][0].text, '@Name-U0OWNER kannst du schauen?');
  });

  it('remembers that the owner joined a thread, and follows their language and stops', async () => {
    const client = fakeClient([]); // looked up before the owner wrote: nobody
    await handleTranslateWatch({
      client,
      logger,
      event: msg({ ts: '2.0', thread_ts: '1.0', user: 'U0ANNA', text: 'Erste' }),
    });
    await handleTranslateWatch({
      client,
      logger,
      event: msg({ ts: '3.0', thread_ts: '1.0', user: OWNER, text: 'ok' }),
    });
    setPrefs(OWNER, { language: 'pt-BR' });
    await handleTranslateWatch({
      client,
      logger,
      event: msg({ ts: '4.0', thread_ts: '1.0', user: 'U0ANNA', text: 'Zweite' }),
    });
    await sleep(BATCH_WAIT_MS);
    assert.strictEqual(translateMessages.mock.callCount(), 1);
    assert.deepStrictEqual(translateMessages.mock.calls[0].arguments, [
      [{ author: 'Name-U0ANNA', text: 'Zweite' }],
      'pt-BR',
    ]);

    setPrefs(OWNER, { on: false }, threadKey('C1', '1.0'));
    await handleTranslateWatch({
      client,
      logger,
      event: msg({ ts: '5.0', thread_ts: '1.0', user: 'U0ANNA', text: 'Dritte' }),
    });
    await sleep(BATCH_WAIT_MS);
    assert.strictEqual(translateMessages.mock.callCount(), 1, 'stopped in this thread');
  });

  it('posts nothing when the model finds no German, and skips text that is clearly not German', async () => {
    const client = fakeClient([{ ts: '1.0', user: OWNER, text: 'start' }]);
    await handleTranslateWatch({
      client,
      logger,
      event: msg({ ts: '2.0', thread_ts: '1.0', user: 'U0A', text: 'EN: all good' }),
    });
    await handleTranslateWatch({
      client,
      logger,
      event: msg({ ts: '3.0', thread_ts: '1.0', user: 'U0A', text: 'english only' }),
    });
    await sleep(BATCH_WAIT_MS);
    assert.strictEqual(translateMessages.mock.callCount(), 1);
    assert.strictEqual(translateMessages.mock.calls[0].arguments[0].length, 1);
    assert.strictEqual(client.chat.postMessage.mock.callCount(), 0);
  });

  it('ignores bots, DMs and edits', async () => {
    const client = fakeClient([{ ts: '1.0', user: OWNER, text: 'start' }]);
    for (const extra of [{ bot_id: 'B1' }, { channel_type: 'im' }, { subtype: 'message_changed' }]) {
      await handleTranslateWatch({
        client,
        logger,
        event: msg({ ts: '2.0', thread_ts: '1.0', user: 'U0A', text: 'Hallo', ...extra }),
      });
    }
    await sleep(BATCH_WAIT_MS);
    assert.strictEqual(translateMessages.mock.callCount(), 0);
  });
});

describe('translation buttons', () => {
  const ref = { c: 'C1', t: '1.0', ts: ['2.0'], o: OWNER };
  const body = (/** @type {string} */ user, /** @type {object} */ value) => ({
    user: { id: user },
    channel: { id: 'C1' },
    message: { ts: '9.0', thread_ts: '1.0', text: 'old', blocks: [{ type: 'section' }, { type: 'actions' }] },
    actions: [{ value: JSON.stringify(value) }],
  });

  beforeEach(() => {
    resetTranslatePrefs();
    translateMessages.mock.resetCalls();
  });

  it('translates the same messages again into the other language and keeps it for the thread', async () => {
    const client = fakeClient([
      { ts: '1.0', user: OWNER, text: 'x' },
      { ts: '2.0', user: 'U0A', text: 'Wer fixt das?' },
    ]);
    await handleTranslateLanguage({ ack: mock.fn(), client, logger, body: body(OWNER, { ...ref, to: 'pt-BR' }) });
    assert.deepStrictEqual(translateMessages.mock.calls[0].arguments, [
      [{ author: 'Name-U0A', text: 'Wer fixt das?' }],
      'pt-BR',
    ]);
    const update = client.chat.update.mock.calls[0].arguments[0];
    assert.strictEqual(update.ts, '9.0');
    assert.strictEqual(update.blocks[1].text.text, '*Name-U0A:* [pt-BR] Wer fixt das?');
    assert.strictEqual(languageFor(OWNER, threadKey('C1', '1.0')), 'pt-BR');
  });

  it('only the person the translation is for can use the buttons', async () => {
    const client = fakeClient();
    await handleTranslateStop({ ack: mock.fn(), client, logger, body: body('U0OTHER', ref) });
    assert.strictEqual(client.chat.update.mock.callCount(), 0);
    assert.match(client.chat.postEphemeral.mock.calls[0].arguments[0].text, /<@U0OWNER>'s translation/);
    assert.strictEqual(languageFor(OWNER, threadKey('C1', '1.0')), 'en');
  });

  it('stop turns the thread off and removes the buttons', async () => {
    const client = fakeClient();
    await handleTranslateStop({ ack: mock.fn(), client, logger, body: body(OWNER, ref) });
    assert.strictEqual(languageFor(OWNER, threadKey('C1', '1.0')), null);
    const { blocks } = client.chat.update.mock.calls[0].arguments[0];
    assert.ok(!blocks.some((/** @type {any} */ b) => b.type === 'actions'));
  });
});
