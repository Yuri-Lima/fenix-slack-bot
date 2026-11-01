import assert from 'node:assert';
import { describe, it, mock } from 'node:test';

import { resolveUserName } from '../../utils/slack.js';

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
