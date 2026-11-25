import assert from 'node:assert';
import { describe, it } from 'node:test';

import { mightBeGerman } from '../../agent/translate.js';

describe('mightBeGerman', () => {
  it('keeps German messages, including short ones without common words', () => {
    assert.ok(mightBeGerman('Das habe ich auch gerade gesehen, der Artikel kann nicht reserviert werden'));
    assert.ok(mightBeGerman('Frage wer fixt das?'));
    assert.ok(mightBeGerman('Wichtiger Punkt!'), 'no common words: the model decides');
    assert.ok(mightBeGerman('Größe prüfen'), 'umlauts');
  });

  it('skips clearly English text and text without words', () => {
    assert.strictEqual(mightBeGerman('I think this is the fix for the build'), false);
    assert.strictEqual(mightBeGerman('Thanks, can you check it?'), false);
    assert.strictEqual(mightBeGerman('   '), false);
    assert.strictEqual(mightBeGerman('123 + 456'), false);
  });

  it('does not count words both languages use ("was", "will", "in") as English', () => {
    assert.ok(mightBeGerman('Was ist in Ordnung?'));
  });
});
