import assert from 'node:assert';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { config, resolvePath } from '../../config.js';
import {
  deleteUploadFile,
  sniffFile,
  storeUploadStream,
  takeUpload,
  textChecker,
  textType,
} from '../../mcp/uploads.js';
import { MP4, PNG, WEBM, ZIP } from '../fixtures/media.js';

/** A request-like body that yields the buffer in chunks. */
async function* chunks(/** @type {Buffer} */ data, size = 16) {
  for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size);
}

describe('sniffFile', () => {
  it('recognises images and videos by their first bytes', () => {
    assert.strictEqual(sniffFile(PNG)?.mimeType, 'image/png');
    assert.strictEqual(sniffFile(Buffer.from('ffd8ffe000104a464946', 'hex'))?.ext, 'jpg');
    assert.strictEqual(sniffFile(Buffer.from('GIF89a....'))?.ext, 'gif');
    assert.strictEqual(sniffFile(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1'))?.ext, 'webp');
    assert.deepStrictEqual(sniffFile(MP4), { mimeType: 'video/mp4', ext: 'mp4', kind: 'video' });
    assert.strictEqual(sniffFile(Buffer.from('\x00\x00\x00\x14ftypqt  ', 'latin1'))?.mimeType, 'video/quicktime');
    assert.deepStrictEqual(sniffFile(WEBM), { mimeType: 'video/webm', ext: 'webm', kind: 'video' });
    assert.deepStrictEqual(sniffFile(Buffer.from('%PDF-1.7\n')), {
      mimeType: 'application/pdf',
      ext: 'pdf',
      kind: 'pdf',
    });
  });

  it('rejects everything else, including AVIF/HEIC stills and Matroska', () => {
    assert.strictEqual(sniffFile(Buffer.from('\x00\x00\x00\x1cftypavif', 'latin1')), null);
    assert.strictEqual(sniffFile(Buffer.from('\x00\x00\x00\x1cftypheic', 'latin1')), null);
    assert.strictEqual(sniffFile(Buffer.concat([Buffer.from('1a45dfa3', 'hex'), Buffer.from('....matroska')])), null);
    assert.strictEqual(sniffFile(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
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
    for (const body of [Buffer.alloc(0), ZIP]) {
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

describe('text uploads', () => {
  it('keeps UTF-8 logs, with characters split across chunks, under an allowed extension', async () => {
    const log = Buffer.from('2026-11-23 10:00:01 ERROR db pool exhausted — retrying ✓\n'.repeat(20));
    const r = await storeUploadStream('grok', chunks(log, 7), 'app.LOG');
    assert.ok(r.ok, !r.ok ? r.error : '');
    assert.deepStrictEqual([r.upload.kind, r.upload.mimeType, r.upload.filename], ['text', 'text/plain', 'app.log']);
    deleteUploadFile(r.upload.path);
  });

  it('names unknown text types .txt, so nothing arrives as HTML or SVG', () => {
    assert.strictEqual(textType('page.html').ext, 'txt');
    assert.strictEqual(textType('data.csv').ext, 'csv');
    assert.strictEqual(textType(null).ext, 'txt');
  });

  it('refuses binary data that starts like text, and text cut inside a character', async () => {
    const sneaky = Buffer.concat([Buffer.from('a'.repeat(100)), Buffer.from([0, 1, 2, 3])]);
    const r = await storeUploadStream('grok', chunks(sneaky), 'x.log');
    assert.ok(!r.ok && r.status === 415, 'NUL after the first bytes');
    const cut = await storeUploadStream('grok', chunks(Buffer.from([0x61, 0xe2, 0x82])), 'x.txt');
    assert.ok(!cut.ok && cut.status === 415, 'ends inside a character');
    const check = textChecker();
    assert.ok(
      check.feed(Buffer.from([0xe2, 0x82])) && check.feed(Buffer.from([0xac])) && check.end(),
      '€ split in two',
    );
  });

  it('keeps a PDF by its signature', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(100, 0x20)]);
    const r = await storeUploadStream('grok', chunks(pdf), 'report');
    assert.ok(r.ok && r.upload.kind === 'pdf' && r.upload.filename === 'report.pdf');
    deleteUploadFile(r.upload.path);
  });

  it('saves waiting uploads, so a restart keeps them', async () => {
    const r = await storeUploadStream('grok', chunks(PNG), 'shot.png');
    assert.ok(r.ok);
    const saved = JSON.parse(readFileSync(join(resolvePath(config.dataDir), 'mcp-uploads.json'), 'utf-8'));
    assert.ok(saved.uploads.some((/** @type {any} */ u) => u.id === r.upload.id && u.owner === 'grok'));
    takeUpload(r.upload.id, 'grok');
    const after = JSON.parse(readFileSync(join(resolvePath(config.dataDir), 'mcp-uploads.json'), 'utf-8'));
    assert.ok(!after.uploads.some((/** @type {any} */ u) => u.id === r.upload.id), 'taken uploads leave the list');
    deleteUploadFile(r.upload.path);
  });
});
