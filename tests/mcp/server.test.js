import assert from 'node:assert';
import { after, before, describe, it } from 'node:test';

process.env.FENIX_MCP_TOKEN = 'test-mcp-token';

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { config } = await import('../../config.js');
const { isAuthorized, startMcpServer } = await import('../../mcp/server.js');
const { flushUsage, readMonth } = await import('../../utils/usage-store.js');

const quietLogger = { info: () => {}, error: () => {} };

describe('MCP server', () => {
  /** @type {import('node:http').Server} */
  let http;
  let url;

  before(async () => {
    config.mcp = { enabled: true, host: '127.0.0.1', port: 0, path: '/mcp' };
    http = startMcpServer(quietLogger);
    await new Promise((resolve) => http.once('listening', resolve));
    url = `http://127.0.0.1:${http.address().port}`;
  });

  after(() => new Promise((resolve) => http.close(resolve)));

  /** @param {string} token */
  const connect = async (token) => {
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  };

  it("lists the read-only tools marked read-only, plus the owner's grafana_ignore_hosts", async () => {
    const client = await connect('test-mcp-token');
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('host_health'));
    assert.ok(names.includes('teamcity_build_failures'));
    assert.ok(names.includes('usage_report'));
    assert.ok(!names.includes('youtrack_create_issue'));
    assert.ok(!names.includes('youtrack_update_issue'));
    // The static token is the owner's Claude Code, which may change what Fenix analyses
    const ignore = tools.find((t) => t.name === 'grafana_ignore_hosts');
    assert.strictEqual(ignore?.annotations?.readOnlyHint, false);
    assert.ok(tools.filter((t) => t !== ignore).every((t) => t.annotations?.readOnlyHint === true));
    await client.close();
  });

  it('runs a tool and records the call in the usage log', async () => {
    const client = await connect('test-mcp-token');
    const result = await client.callTool({ name: 'usage_report', arguments: { period: '24h' } });
    assert.match(result.content[0].text, /^Usage last 24 hours:/);
    await client.close();
    await flushUsage();
    const calls = readMonth(new Date().toISOString().slice(0, 7)).filter(
      (r) => r.kind === 'mcp' && r.subject === 'usage_report',
    );
    assert.ok(calls.length >= 1);
    assert.strictEqual(calls.at(-1).outcome, 'ok');
  });

  it('rejects a missing or wrong token', async () => {
    const none = await fetch(`${url}/mcp`, { method: 'POST' });
    assert.strictEqual(none.status, 401);
    await assert.rejects(() => connect('wrong-token'));
  });

  it('only accepts POST on the MCP path, and answers a health check', async () => {
    const get = await fetch(`${url}/mcp`, { headers: { Authorization: 'Bearer test-mcp-token' } });
    assert.strictEqual(get.status, 405);
    assert.strictEqual((await fetch(`${url}/other`)).status, 404);
    assert.strictEqual(await (await fetch(`${url}/healthz`)).text(), 'ok');
  });
});

describe('isAuthorized', () => {
  it('accepts only the exact bearer token', () => {
    assert.ok(isAuthorized('Bearer abc', 'abc'));
    assert.ok(!isAuthorized('Bearer abd', 'abc'));
    assert.ok(!isAuthorized('abc', 'abc'));
    assert.ok(!isAuthorized(undefined, 'abc'));
  });
});

describe('MCP server start-up', () => {
  it('logs and retries instead of crashing when the address cannot be bound', async () => {
    const errors = [];
    const saved = config.mcp;
    config.mcp = { enabled: true, host: '203.0.113.1', port: 8787, path: '/mcp' }; // TEST-NET address, not local
    const http = startMcpServer({ info: () => {}, error: (m) => errors.push(m) });
    await new Promise((resolve) => setTimeout(resolve, 100));
    config.mcp = saved;
    assert.match(errors[0], /could not listen on 203\.0\.113\.1:8787 .*retrying in 30 s/);
    http.close();
  });
});
