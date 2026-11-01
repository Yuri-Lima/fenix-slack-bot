import assert from 'node:assert';
import { describe, it } from 'node:test';

import { buildAppHomeView } from '../../../listeners/views/app-home-builder.js';

describe('buildAppHomeView', () => {
  it('returns a home view with blocks', () => {
    const view = buildAppHomeView();
    assert.strictEqual(view.type, 'home');
    assert.ok(view.blocks.length > 0);
  });

  it('describes the DevOps capabilities, not the old IT-helpdesk template', () => {
    const text = JSON.stringify(buildAppHomeView());
    for (const topic of ['TeamCity', 'Flaky tests', 'YouTrack', 'Codebase']) assert.ok(text.includes(topic), topic);
    for (const leftover of ['Password Reset', 'MCP Server', 'IT support'])
      assert.ok(!text.includes(leftover), leftover);
  });

  it('has no buttons, so every rendered element has a handler', () => {
    const view = buildAppHomeView();
    assert.ok(!view.blocks.some((b) => b.type === 'actions'));
  });

  it('includes the bot mention in the context when botUserId is provided', () => {
    const contextBlock = buildAppHomeView('U0BOT').blocks.find((b) => b.type === 'context');
    assert.ok(contextBlock.elements[0].text.includes('<@U0BOT>'));
  });

  it('omits the bot mention when botUserId is not provided', () => {
    const contextBlock = buildAppHomeView().blocks.find((b) => b.type === 'context');
    assert.ok(!contextBlock.elements[0].text.includes('<@'));
  });
});
