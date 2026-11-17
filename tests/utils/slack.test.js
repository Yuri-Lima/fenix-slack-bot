import assert from 'node:assert';
import { describe, it, mock } from 'node:test';

import { MAX_IMAGES_PER_MESSAGE, readSlackImages, resolveUserName } from '../../utils/slack.js';

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

describe('readSlackImages', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const client = /** @type {any} */ ({ token: 'xoxb-test' });
  const file = (name, extra = {}) => ({
    name,
    mimetype: 'image/png',
    size: 100,
    url_private_download: `https://files.slack.com/files-pri/T1-F1/${name}`,
    ...extra,
  });

  it('downloads images with the bot token and checks their bytes', async (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(PNG));
    const { images, skipped } = await readSlackImages(client, [file('a.png')]);
    assert.deepStrictEqual(skipped, []);
    assert.strictEqual(images.length, 1);
    assert.strictEqual(images[0].mediaType, 'image/png');
    assert.strictEqual(Buffer.from(images[0].data, 'base64').toString('hex'), PNG.toString('hex'));
    assert.strictEqual(fetchMock.mock.calls[0].arguments[1].headers.Authorization, 'Bearer xoxb-test');
  });

  it('names what it skips, and never sends the token outside Slack', async (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('<html>sign in</html>'));
    const { images, skipped } = await readSlackImages(client, [
      file('report.pdf', { mimetype: 'application/pdf', filetype: 'pdf' }),
      file('huge.png', { size: 6 * 1024 * 1024 }),
      file('elsewhere.png', { url_private_download: 'https://evil.example.com/x.png' }),
      file('signin.png'),
    ]);
    assert.strictEqual(images.length, 0);
    assert.deepStrictEqual(skipped, [
      'report.pdf (pdf, not an image)',
      'huge.png (larger than 5 MB)',
      'elsewhere.png (no Slack download link)',
      'signin.png (could not be read as an image)',
    ]);
    assert.strictEqual(fetchMock.mock.callCount(), 1);
  });

  it(`reads at most ${MAX_IMAGES_PER_MESSAGE} images per message`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response(PNG));
    const files = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, (_, i) => file(`s${i}.png`));
    const { images, skipped } = await readSlackImages(client, files);
    assert.strictEqual(images.length, MAX_IMAGES_PER_MESSAGE);
    assert.match(skipped[0], /only the first 4 images are read/);
  });
});
