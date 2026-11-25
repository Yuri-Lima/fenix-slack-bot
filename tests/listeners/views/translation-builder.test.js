import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  buildTranslation,
  noMentions,
  stoppedTranslation,
  TRANSLATE_LANGUAGE_ACTION,
  TRANSLATE_STOP_ACTION,
} from '../../../listeners/views/translation-builder.js';

const REF = { c: 'C1', t: '1.0', ts: ['1.0', '2.0'], o: 'U0OWNER' };

describe('buildTranslation', () => {
  it('mentions the person, shows each message and offers the other language and stop', () => {
    const { text, blocks } = buildTranslation(REF, 'en', [
      { author: 'Anna', text: 'Who fixes this?' },
      { author: 'Ben', text: 'Important point <@U0X> <!here>' },
    ]);
    assert.match(text, /<@U0OWNER>/);
    assert.match(JSON.stringify(blocks[0]), /<@U0OWNER> · translated into English/);
    assert.strictEqual(blocks[1].text.text, '*Anna:* Who fixes this?');
    assert.strictEqual(blocks[2].text.text, '*Ben:* Important point &lt;@U0X> &lt;!here>', 'no notifications');
    const [lang, stop] = blocks[3].elements;
    assert.strictEqual(lang.action_id, TRANSLATE_LANGUAGE_ACTION);
    assert.match(lang.text.text, /Português/);
    assert.deepStrictEqual(JSON.parse(lang.value), { ...REF, to: 'pt-BR' });
    assert.strictEqual(stop.action_id, TRANSLATE_STOP_ACTION);
    assert.deepStrictEqual(JSON.parse(stop.value), REF);
  });

  it('offers English under a Portuguese translation', () => {
    const { blocks } = buildTranslation(REF, 'pt-BR', [{ author: 'Anna', text: 'Quem corrige isso?' }]);
    assert.match(JSON.stringify(blocks[0]), /Brazilian Portuguese/);
    assert.deepStrictEqual(JSON.parse(blocks.at(-1).elements[0].value).to, 'en');
  });
});

describe('stoppedTranslation / noMentions', () => {
  it('replaces the buttons with how to resume', () => {
    const { blocks } = buildTranslation(REF, 'en', [{ author: 'A', text: 'x' }]);
    const stopped = stoppedTranslation(blocks);
    assert.ok(!stopped.some((b) => b.type === 'actions'));
    assert.match(JSON.stringify(stopped.at(-1)), /translate on/);
  });

  it('leaves links and channels alone', () => {
    assert.strictEqual(
      noMentions('see <https://x.example|docs> in <#C1|dev>'),
      'see <https://x.example|docs> in <#C1|dev>',
    );
  });
});
