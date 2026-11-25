import assert from 'node:assert';
import { beforeEach, describe, it, mock } from 'node:test';

// The model call is faked: text starting with "EN:" is already English
const translateMessages = mock.fn(async (/** @type {any[]} */ messages, /** @type {string} */ language) => ({
  translations: messages.map((m) => (m.text.startsWith('EN:') ? null : `[${language}] ${m.text}`)),
  tokens: { input: 80, output: 20, cacheRead: 0, cacheWrite: 0, costUsd: 0.000018 },
  durationMs: 5,
}));
mock.module('../../../agent/translate.js', {
  namedExports: { TRANSLATE_MODEL: 'claude-haiku-5-5', translateMessages, mightBeGerman: () => true },
});

const { handleTranslateModalLanguage, handleTranslateShortcut, modalSource } = await import(
  '../../../listeners/shortcuts/translate-message.js'
);
const { resetTranslatePrefs, setPrefs } = await import('../../../utils/translate-prefs.js');
const { MODAL_TEXT_CHARS, TRANSLATE_MODAL_LANGUAGE_ACTION } = await import(
  '../../../listeners/views/translation-builder.js'
);

const OWNER = 'U0OWNER';
const logger = { error: mock.fn() };

function fakeClient() {
  return {
    users: { info: mock.fn(async ({ user }) => ({ user: { real_name: `Name-${user}` } })) },
    views: {
      open: mock.fn(async () => ({ view: { id: 'V1' } })),
      update: mock.fn(async () => ({ ok: true })),
    },
  };
}
const shortcut = (/** @type {string} */ user, /** @type {string} */ text) => ({
  trigger_id: 'T1',
  user: { id: user },
  channel: { id: 'C1' },
  message: { ts: '1.0', user: 'U0ANNA', text },
});
/** @param {any} client */
const lastView = (client) => client.views.update.mock.calls.at(-1).arguments[0].view;

describe('Translate message shortcut', () => {
  beforeEach(() => {
    resetTranslatePrefs();
    translateMessages.mock.resetCalls();
  });

  it('opens a modal at once, then shows the translation from any language with a button for the other one', async () => {
    const client = fakeClient();
    await handleTranslateShortcut({
      ack: mock.fn(),
      client,
      logger,
      shortcut: shortcut(OWNER, 'Frage wer fixt das <@U0BEN>?'),
    });
    assert.match(JSON.stringify(client.views.open.mock.calls[0].arguments[0].view), /Translating/);
    const [sent, language, options] = translateMessages.mock.calls[0].arguments;
    assert.deepStrictEqual(
      [sent, language, options],
      [[{ author: 'Name-U0ANNA', text: 'Frage wer fixt das @Name-U0BEN?' }], 'en', { anyLanguage: true }],
    );
    const view = lastView(client);
    assert.strictEqual(client.views.update.mock.calls[0].arguments[0].view_id, 'V1');
    assert.match(JSON.stringify(view.blocks[0]), /English · Name-U0ANNA's message/);
    assert.strictEqual(view.blocks[1].text.text, '[en] Frage wer fixt das @Name-U0BEN?');
    const button = view.blocks.at(-1).elements[0];
    assert.deepStrictEqual([button.action_id, button.value], [TRANSLATE_MODAL_LANGUAGE_ACTION, 'pt-BR']);
    assert.deepStrictEqual(JSON.parse(view.private_metadata), { u: 'U0ANNA', t: 'Frage wer fixt das <@U0BEN>?' });
  });

  it('uses the language the owner chose, and says when the message is already in it', async () => {
    setPrefs(OWNER, { language: 'pt-BR' });
    const client = fakeClient();
    await handleTranslateShortcut({ ack: mock.fn(), client, logger, shortcut: shortcut(OWNER, 'EN: all good') });
    assert.strictEqual(translateMessages.mock.calls[0].arguments[1], 'pt-BR');
    assert.match(JSON.stringify(lastView(client)), /already in Brazilian Portuguese/);
  });

  it('the button translates the same message into the other language', async () => {
    const client = fakeClient();
    const view = { id: 'V9', private_metadata: JSON.stringify({ u: 'U0ANNA', t: 'Wer fixt das?' }) };
    await handleTranslateModalLanguage({
      ack: mock.fn(),
      client,
      logger,
      body: { user: { id: OWNER }, view, actions: [{ value: 'pt-BR' }] },
    });
    assert.deepStrictEqual(translateMessages.mock.calls[0].arguments[1], 'pt-BR');
    assert.strictEqual(lastView(client).blocks[1].text.text, '[pt-BR] Wer fixt das?');
    assert.strictEqual(client.views.update.mock.calls.at(-1).arguments[0].view_id, 'V9');
  });

  it('refuses people translations are not set up for, and messages without text, without a model call', async () => {
    const client = fakeClient();
    await handleTranslateShortcut({ ack: mock.fn(), client, logger, shortcut: shortcut('U0ALLOWED', 'Hallo') });
    await handleTranslateShortcut({ ack: mock.fn(), client, logger, shortcut: shortcut(OWNER, '  ') });
    const texts = client.views.open.mock.calls.map((c) => JSON.stringify(c.arguments[0].view));
    assert.match(texts[0], /not set up for you/);
    assert.match(texts[1], /no text to translate/);
    assert.strictEqual(translateMessages.mock.callCount(), 0);
  });

  it('shows a failure in the modal when the model call fails', async () => {
    translateMessages.mock.mockImplementationOnce(async () => {
      throw new Error('overloaded');
    });
    const client = fakeClient();
    await handleTranslateShortcut({ ack: mock.fn(), client, logger, shortcut: shortcut(OWNER, 'Hallo zusammen') });
    assert.match(JSON.stringify(lastView(client)), /translation failed/);
  });
});

describe('modalSource', () => {
  it("keeps long messages within Slack's 3000-character private_metadata, marked as cut", () => {
    const s = modalSource('U0A', '"\n'.repeat(3000));
    assert.ok(JSON.stringify(s).length <= 3000);
    assert.strictEqual(s.cut, true);
    assert.deepStrictEqual(modalSource('U0A', 'kurz'), { u: 'U0A', t: 'kurz' });
    assert.strictEqual(modalSource('U0A', 'x'.repeat(MODAL_TEXT_CHARS + 1)).t.length, MODAL_TEXT_CHARS);
  });
});
