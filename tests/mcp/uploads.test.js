import assert from 'node:assert';
import { describe, it } from 'node:test';

import { MAX_UPLOAD_BYTES, sniffImage, storeUpload, takeUpload } from '../../mcp/uploads.js';
import { PNG } from '../fixtures/png.js';

describe('sniffImage', () => {
  it('recognises PNG, JPEG, GIF and WebP by their first bytes', () => {
    assert.strictEqual(sniffImage(PNG)?.mimeType, 'image/png');
    assert.strictEqual(sniffImage(Buffer.from('ffd8ffe000104a464946', 'hex'))?.ext, 'jpg');
    assert.strictEqual(sniffImage(Buffer.from('GIF89a....'))?.ext, 'gif');
    assert.strictEqual(sniffImage(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1'))?.ext, 'webp');
  });

  it('rejects anything else, whatever it is called', () => {
    assert.strictEqual(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
    assert.strictEqual(sniffImage(Buffer.from('%PDF-1.7')), null);
  });
});

describe('storeUpload / takeUpload', () => {
  it('keeps an image for its owner only, once, with a safe name and its real extension', () => {
    const r = storeUpload('grok', PNG, '../../etc/My Banner!.jpg');
    assert.ok(r.ok);
    assert.strictEqual(r.upload.filename, '..-..-etc-My-Banner-.png');
    assert.strictEqual(takeUpload(r.upload.id, 'cursor'), null, 'another client cannot take it');
    assert.strictEqual(takeUpload(r.upload.id, 'grok')?.data.length, PNG.length);
    assert.strictEqual(takeUpload(r.upload.id, 'grok'), null, 'it can be used once');
  });

  it('refuses empty, oversized and non-image uploads with the right status', () => {
    assert.deepStrictEqual(
      [storeUpload('grok', Buffer.alloc(0), null), storeUpload('grok', Buffer.from('hello'), 'x.png')].map(
        (r) => !r.ok && r.status,
      ),
      [400, 415],
    );
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_UPLOAD_BYTES)]);
    const r = storeUpload('grok', big, 'big.png');
    assert.strictEqual(!r.ok && r.status, 413);
  });
});
