import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';

import { parseTranslateCommand, runTranslateCommand } from '../../../listeners/events/translate-command.js';
import { threadKey } from '../../../thread-context/index.js';
import { languageFor, resetTranslatePrefs } from '../../../utils/translate-prefs.js';

const OWNER = 'U0OWNER';

describe('parseTranslateCommand', () => {
  it('reads status, on/off and the languages', () => {
    assert.deepStrictEqual(parseTranslateCommand('translate'), { action: 'status' });
    assert.deepStrictEqual(parseTranslateCommand('Translate status.'), { action: 'status' });
    assert.deepStrictEqual(parseTranslateCommand('translate off'), { action: 'set', on: false });
    assert.deepStrictEqual(parseTranslateCommand('translate on'), { action: 'set', on: true });
    assert.deepStrictEqual(parseTranslateCommand('translate pt'), { action: 'set', language: 'pt-BR', on: true });
    assert.deepStrictEqual(parseTranslateCommand('translate Português'), {
      action: 'set',
      language: 'pt-BR',
      on: true,
    });
    assert.deepStrictEqual(parseTranslateCommand('translate english!'), { action: 'set', language: 'en', on: true });
  });

  it('leaves anything else to the agent', () => {
    assert.strictEqual(parseTranslateCommand('translate this message to Portuguese'), null);
    assert.strictEqual(parseTranslateCommand('translate fr'), null);
    assert.strictEqual(parseTranslateCommand('please translate'), null);
  });
});

describe('runTranslateCommand', () => {
  beforeEach(() => resetTranslatePrefs());

  it('changes the default in a DM and only the thread when sent in a thread', () => {
    assert.strictEqual(languageFor(OWNER), 'en', 'config default');
    runTranslateCommand(OWNER, { action: 'set', language: 'pt-BR', on: true }, null);
    assert.strictEqual(languageFor(OWNER), 'pt-BR');

    const thread = { channel: 'C1', threadTs: '1.0' };
    const reply = runTranslateCommand(OWNER, { action: 'set', on: false }, thread);
    assert.match(reply, /this thread: \*off\*/);
    assert.strictEqual(languageFor(OWNER, threadKey('C1', '1.0')), null);
    assert.strictEqual(languageFor(OWNER, threadKey('C1', '2.0')), 'pt-BR', 'other threads keep the default');
  });

  it('turning translations on everywhere also resumes stopped threads', () => {
    runTranslateCommand(OWNER, { action: 'set', on: false }, { channel: 'C1', threadTs: '1.0' });
    runTranslateCommand(OWNER, { action: 'set', on: false }, null);
    assert.strictEqual(languageFor(OWNER, threadKey('C9', '9.0')), null);
    const status = runTranslateCommand(OWNER, { action: 'set', on: true }, null);
    assert.match(status, /Translations: \*on\*, into 🇬🇧 English/);
    assert.strictEqual(languageFor(OWNER, threadKey('C1', '1.0')), 'en');
  });

  it('refuses people not set up for translations, even when listed but not owners', () => {
    assert.match(runTranslateCommand('U0ALLOWED', { action: 'status' }, null), /not set up for you/);
  });
});
