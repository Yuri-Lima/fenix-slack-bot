import assert from 'node:assert';
import { existsSync, statSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';

import { config } from '../../config.js';
import { deleteUploadFile, sniffMedia, storeUploadStream, takeUpload } from '../../mcp/uploads.js';
import { MP4, PNG, WEBM } from '../fixtures/media.js';

/** A request-like body that yields the buffer in chunks. */
async function* chunks(/** @type {Buffer} */ data, size = 16) {
  for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size);
}

describe('sniffMedia', () => {
  it('recognises images and videos by their first bytes', () => {
    assert.strictEqual(sniffMedia(PNG)?.mimeType, 'image/png');
    assert.strictEqual(sniffMedia(Buffer.from('ffd8ffe000104a464946', 'hex'))?.ext, 'jpg');
    assert.strictEqual(sniffMedia(Buffer.from('GIF89a....'))?.ext, 'gif');
    assert.strictEqual(sniffMedia(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1'))?.ext, 'webp');
    assert.deepStrictEqual(sniffMedia(MP4), { mimeType: 'video/mp4', ext: 'mp4', kind: 'video' });
    assert.strictEqual(sniffMedia(Buffer.from('\x00\x00\x00\x14ftypqt  ', 'latin1'))?.mimeType, 'video/quicktime');
    assert.deepStrictEqual(sniffMedia(WEBM), { mimeType: 'video/webm', ext: 'webm', kind: 'video' });
  });

  it('rejects everything else, including AVIF/HEIC stills and Matroska', () => {
    assert.strictEqual(sniffMedia(Buffer.from('\x00\x00\x00\x1cftypavif', 'latin1')), null);
    assert.strictEqual(sniffMedia(Buffer.from('\x00\x00\x00\x1cftypheic', 'latin1')), null);
    assert.strictEqual(sniffMedia(Buffer.concat([Buffer.from('1a45dfa3', 'hex'), Buffer.from('....matroska')])), null);
    assert.strictEqual(sniffMedia(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
    assert.strictEqual(sniffMedia(Buffer.from('%PDF-1.7')), null);
  });
});

describe('storeUploadStream / takeUpload', () => {
  const limits = { ...config.mcp };
  before(() => {
    config.mcp = { ...config.mcp, maxUploadMb: 1, maxUploadTotalMb: 2 };
  });
  after(() => {
    config.mcp = limits;
  });

  it('streams a video to a private file, for its owner only, once', async () => {
    const r = await storeUploadStream('grok', chunks(MP4), '../../etc/My Demo!.mov');
    assert.ok(r.ok, !r.ok ? r.error : '');
    assert.deepStrictEqual(
      [r.upload.kind, r.upload.size, r.upload.filename],
      ['video', MP4.length, '..-..-etc-My-Demo-.mp4'],
    );
    assert.strictEqual(statSync(r.upload.path).mode & 0o777, 0o600);
    assert.strictEqual(takeUpload(r.upload.id, 'cursor'), null, 'another client cannot take it');
    const taken = takeUpload(r.upload.id, 'grok');
    assert.strictEqual(taken?.path, r.upload.path);
    assert.strictEqual(takeUpload(r.upload.id, 'grok'), null, 'it can be used once');
    deleteUploadFile(r.upload.path);
    assert.ok(!existsSync(r.upload.path));
  });

  it('accepts files shorter than the sniffing window', async () => {
    const r = await storeUploadStream('grok', chunks(Buffer.from('89504e470d0a1a0a00', 'hex')), 'tiny.png');
    assert.ok(r.ok);
  });

  it('refuses empty, oversized, over-total and non-media uploads, leaving no file behind', async () => {
    const statuses = [];
    for (const body of [Buffer.alloc(0), Buffer.from('hello, not a video at all, just some plain text'.repeat(3))]) {
      const r = await storeUploadStream('grok', chunks(body), 'x.mp4');
      statuses.push(!r.ok && r.status);
    }
    const big = Buffer.concat([MP4, Buffer.alloc(1024 * 1024)]);
    const tooBig = await storeUploadStream('grok', chunks(big, 64 * 1024), 'big.mp4');
    statuses.push(!tooBig.ok && tooBig.status);
    assert.deepStrictEqual(statuses, [400, 415, 413]);

    // Two files near the 1 MB limit fit; a third would pass the 2 MB total
    const near = Buffer.concat([MP4, Buffer.alloc(900 * 1024)]);
    const kept = [];
    for (let i = 0; i < 2; i++) {
      const r = await storeUploadStream('grok', chunks(near, 64 * 1024), `n${i}.mp4`);
      assert.ok(r.ok);
      kept.push(r.upload);
    }
    const third = await storeUploadStream('grok', chunks(near, 64 * 1024), 'n2.mp4');
    assert.strictEqual(!third.ok && third.status, 507);
    for (const u of kept) deleteUploadFile(takeUpload(u.id, 'grok')?.path || u.path);
  });
});
