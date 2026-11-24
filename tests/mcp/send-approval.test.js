import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';

import { config, resolvePath } from '../../config.js';
import { requestSendApproval, takeDraft } from '../../mcp/send-approval.js';

const DRAFTS = join(resolvePath(config.dataDir), 'mcp-send-drafts.json');
const saved = () => JSON.parse(readFileSync(DRAFTS, 'utf-8')).drafts;

describe('send approval drafts', () => {
  it('saves a waiting draft (without functions), so its buttons survive a restart, and drops it once decided', async () => {
    const postMessage = mock.fn(async () => ({ ok: true }));
    const target = { channel: 'C0TEAM', where: '#team' };
    const r = await requestSendApproval({ chat: { postMessage } }, 'grok', target, 'deploy done');
    assert.ok(!r.isError, r.content[0].text);
    const blocks = JSON.stringify(/** @type {any} */ (postMessage.mock.calls[0].arguments[0]).blocks);
    const id = /"value":"([A-Za-z0-9_-]+)"/.exec(blocks)?.[1];
    assert.ok(id, 'the Send button carries the draft id');

    const draft = saved().find((/** @type {any} */ d) => d.id === id);
    assert.deepStrictEqual([draft.caller, draft.text, draft.target], ['grok', 'deploy done', target]);

    assert.strictEqual(takeDraft(/** @type {string} */ (id))?.text, 'deploy done');
    assert.ok(!saved().some((/** @type {any} */ d) => d.id === id));
    assert.strictEqual(takeDraft(/** @type {string} */ (id)), null, 'decided once');
  });
});
