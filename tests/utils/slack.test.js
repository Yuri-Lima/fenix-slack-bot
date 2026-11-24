import assert from 'node:assert';
import { describe, it, mock } from 'node:test';

import { MAX_FILES_PER_MESSAGE, MAX_TEXT_CHARS, readSlackFiles, resolveUserName } from '../../utils/slack.js';

describe('resolveUserName', () => {
  it('prefers the real name and caches it', async () => {
    const client = { users: { info: mock.fn(async () => ({ user: { real_name: 'Jane Doe', name: 'jane' } })) } };
    assert.strictEqual(await resolveUserName(client, 'U1'), 'Jane Doe');
    assert.strictEqual(await resolveUserName(client, 'U1'), 'Jane Doe');
    assert.strictEqual(client.users.info.mock.callCount(), 1);
  });

  it('falls back to the handle, then the ID', async () => {
    const handleOnly = { users: { info: mock.fn(async () => ({ user: { name: 'bob' } })) } };
    assert.strictEqual(await resolveUserName(handleOnly, 'U2'), 'bob');

    const failing = { users: { info: mock.fn(async () => Promise.reject(new Error('user_not_found'))) } };
    assert.strictEqual(await resolveUserName(failing, 'U3'), 'U3');
  });
});

describe('readSlackFiles', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n');
  const client = /** @type {any} */ ({ token: 'xoxb-test' });
  const file = (/** @type {string} */ name, extra = {}) => ({
    name,
    mimetype: 'image/png',
    size: 100,
    url_private_download: `https://files.slack.com/files-pri/T1-F1/${name}`,
    ...extra,
  });
  /** A fetch that serves each file by name. @param {Record<string, Buffer | string>} byName */
  const serve =
    (byName, type = 'application/octet-stream') =>
    async (/** @type {string} */ url) =>
      new Response(byName[url.split('/').pop() ?? ''] ?? '', { headers: { 'content-type': type } });

  it('downloads images with the bot token and checks their bytes', async (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch', serve({ 'a.png': PNG }));
    const { attachments, skipped } = await readSlackFiles(client, [file('a.png')]);
    assert.deepStrictEqual(skipped, []);
    assert.deepStrictEqual(
      attachments.map((a) => [a.kind, a.mediaType]),
      [['image', 'image/png']],
    );
    assert.strictEqual(Buffer.from(attachments[0].data, 'base64').toString('hex'), PNG.toString('hex'));
    assert.strictEqual(fetchMock.mock.calls[0].arguments[1].headers.Authorization, 'Bearer xoxb-test');
  });

  it('reads PDFs by their signature and text files as masked text', async (t) => {
    const log = 'INFO start\nERROR login failed password=hunter2 for db://app:s3cret@db:5432\n';
    t.mock.method(globalThis, 'fetch', serve({ 'r.pdf': PDF, 'app.log': log }));
    const { attachments, skipped } = await readSlackFiles(client, [
      file('r.pdf', { mimetype: 'application/pdf', filetype: 'pdf' }),
      file('app.log', { mimetype: 'text/plain', filetype: 'text' }),
    ]);
    assert.deepStrictEqual(skipped, []);
    assert.deepStrictEqual(
      attachments.map((a) => [a.name, a.kind, a.mediaType]),
      [
        ['r.pdf', 'pdf', 'application/pdf'],
        ['app.log', 'text', 'text/plain'],
      ],
    );
    assert.strictEqual(
      attachments[1].data,
      'INFO start\nERROR login failed password=[redacted] for db://app:[redacted]@db:5432\n',
    );
  });

  it('reads only the end of a long text file, and says so', async (t) => {
    const long = `${'old line\n'.repeat(30_000)}LAST LINE`;
    t.mock.method(globalThis, 'fetch', serve({ 'big.log': long }));
    const { attachments } = await readSlackFiles(client, [file('big.log', { mimetype: 'text/plain' })]);
    assert.strictEqual(attachments[0].data.length, MAX_TEXT_CHARS);
    assert.ok(attachments[0].data.endsWith('LAST LINE'));
    assert.match(attachments[0].note ?? '', /only the last 200,000 of 270,009 characters/);
  });

  it('names what it skips, and never sends the token outside Slack', async (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch', serve({}, 'text/html'));
    const { attachments, skipped } = await readSlackFiles(client, [
      file('demo.mp4', { mimetype: 'video/mp4', filetype: 'mp4' }),
      file('backup.zip', { mimetype: 'application/zip', filetype: 'zip' }),
      file('huge.png', { size: 6 * 1024 * 1024 }),
      file('elsewhere.png', { url_private_download: 'https://evil.example.com/x.png' }),
      file('signin.png'),
      file('signin.log', { mimetype: 'text/plain' }),
    ]);
    assert.strictEqual(attachments.length, 0);
    assert.deepStrictEqual(skipped, [
      'demo.mp4 (mp4: Fenix cannot watch videos or listen to audio)',
      'backup.zip (zip: not an image, PDF or text file)',
      'huge.png (images over 5 MB are not read)',
      'elsewhere.png (no Slack download link)',
      'signin.png (could not be read as an image)',
      'signin.log (could not be read as text)',
    ]);
    assert.strictEqual(fetchMock.mock.callCount(), 2);
  });

  it(`reads at most ${MAX_FILES_PER_MESSAGE} files per message`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response(PNG));
    const files = Array.from({ length: MAX_FILES_PER_MESSAGE + 1 }, (_, i) => file(`s${i}.png`));
    const { attachments, skipped } = await readSlackFiles(client, files);
    assert.strictEqual(attachments.length, MAX_FILES_PER_MESSAGE);
    assert.match(skipped[0], /only the first 4 files are read/);
  });
});
