import assert from 'node:assert';
import { describe, it } from 'node:test';
import { hostHealthTool, hostLogsTool } from '../../../agent/tools/grafana.js';

describe('Grafana tools with excluded hosts (grafana.ignoreHosts: ["test"])', () => {
  it('decline a test server in one line, before any Grafana call', async () => {
    for (const t of [hostLogsTool, hostHealthTool]) {
      const r = await t.handler({ host: 'Shop-Test' }, {});
      assert.match(r.content[0].text, /^Shop-Test is not analysed: server names containing "test" are excluded/);
      assert.ok(!r.isError);
    }
  });
});
