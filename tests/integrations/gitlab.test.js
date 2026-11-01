import assert from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { listFilesTool, readFileTool, searchCodeTool } from '../../agent/tools/gitlab.js';
import { BLOCKED_PATHS_DESCRIPTION, isBlockedPath } from '../../integrations/gitlab.js';

describe('isBlockedPath', () => {
  it('blocks sensitive files and anything inside sensitive directories', () => {
    for (const p of [
      '.env',
      'apps/api/.env.local',
      'prod.env',
      'config/secrets/app.yml',
      'certs/server.pem',
      '.gitlab-ci.yml',
      'keys/id_ed25519.pub',
      'home/.npmrc',
    ]) {
      assert.ok(isBlockedPath(p), p);
    }
  });

  it('allows ordinary source files', () => {
    for (const p of ['packages/core/src/invoice.service.ts', 'packages/env-utils/index.ts', 'docs/environment.md']) {
      assert.ok(!isBlockedPath(p), p);
    }
  });

  it('feeds the system prompt from the same list', () => {
    assert.match(BLOCKED_PATHS_DESCRIPTION, /\.env files/);
    assert.match(BLOCKED_PATHS_DESCRIPTION, /SSH keys/);
  });
});

describe('codebase tools', () => {
  const originalFetch = globalThis.fetch;
  const respond = (json) => {
    globalThis.fetch = mock.fn(async () => ({ ok: true, status: 200, json: async () => json }));
  };
  const call = (t, args) => t.handler(args, {});

  beforeEach(() => {
    process.env.GITLAB_TOKEN = 'test-token';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('drops search hits from restricted files, snippet included', async () => {
    respond([
      { filename: '.env', path: 'apps/api/.env', startline: 1, data: 'DB_PASSWORD=hunter2' },
      {
        filename: 'invoice.service.ts',
        path: 'packages/api/invoice.service.ts',
        startline: 10,
        data: 'class InvoiceService {}',
      },
    ]);
    const res = await call(searchCodeTool, { query: 'password' });
    const text = res.content[0].text;
    assert.ok(!text.includes('hunter2'));
    assert.ok(text.includes('invoice.service.ts'));
    assert.match(text, /1 restricted result\(s\) hidden/);
  });

  it('hides restricted entries from directory listings and refuses restricted paths', async () => {
    respond([
      { name: '.env.production', path: 'apps/api/.env.production', type: 'blob' },
      { name: 'main.ts', path: 'apps/api/main.ts', type: 'blob' },
    ]);
    const listing = (await call(listFilesTool, { path: 'apps/api' })).content[0].text;
    assert.ok(!listing.includes('.env.production'));
    assert.ok(listing.includes('main.ts'));

    const read = await call(readFileTool, { path: 'config/secrets/app.yml' });
    assert.strictEqual(read.isError, true);
  });
});
