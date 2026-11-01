import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { baseUrl, config } from '../../config.js';
import { textResult } from '../../utils/helpers.js';
import { createTokenReader } from '../../utils/tokens.js';

export const TC_BASE = baseUrl(config.teamcity.url);

/** Example config ID for tool descriptions, from the deployment's key configs. */
export const EXAMPLE_CONFIG = config.teamcity.keyConfigs[0]?.id || 'Project_Build';

/** "Common configs: ..." sentence for tool descriptions, empty when none are configured. */
export const KEY_CONFIGS_HINT = config.teamcity.keyConfigs.length
  ? `Common configs: ${config.teamcity.keyConfigs.map((c) => `${c.id} (${c.description})`).join(', ')}. `
  : '';
const FETCH_TIMEOUT_MS = 15_000;
const MAX_CONCURRENT_TC = 4;

const getToken = createTokenReader('TEAMCITY_TOKEN', '.teamcity_token');

let _activeTcCalls = 0;
const _tcQueue = [];

function runNextTc() {
  while (_tcQueue.length > 0 && _activeTcCalls < MAX_CONCURRENT_TC) {
    const { run, resolve, reject } = _tcQueue.shift();
    _activeTcCalls++;
    run()
      .then(resolve, reject)
      .finally(() => {
        _activeTcCalls--;
        runNextTc();
      });
  }
}

export function tcApi(path) {
  const run = async () => {
    const token = getToken();
    if (!TC_BASE) throw new Error('TeamCity URL not configured (teamcity.url in fenix.config.json)');
    if (!token) throw new Error('TeamCity authentication not configured');

    const res = await fetch(`${TC_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) throw new Error(`TeamCity API error (HTTP ${res.status})`);
    return res.json();
  };

  if (_activeTcCalls < MAX_CONCURRENT_TC) {
    _activeTcCalls++;
    return run().finally(() => {
      _activeTcCalls--;
      runNextTc();
    });
  }

  return new Promise((resolve, reject) => {
    _tcQueue.push({ run, resolve, reject });
  });
}

export function tcFetchText(path) {
  const run = async () => {
    const token = getToken();
    if (!TC_BASE) throw new Error('TeamCity URL not configured (teamcity.url in fenix.config.json)');
    if (!token) throw new Error('TeamCity authentication not configured');
    const res = await fetch(`${TC_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/plain' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`TeamCity ${res.status}`);
    return res.text();
  };

  if (_activeTcCalls < MAX_CONCURRENT_TC) {
    _activeTcCalls++;
    return run().finally(() => {
      _activeTcCalls--;
      runNextTc();
    });
  }
  return new Promise((resolve, reject) => {
    _tcQueue.push({ run, resolve, reject });
  });
}

export const listRecentBuildsTool = tool(
  'teamcity_list_builds',
  'List recent builds for a TeamCity build configuration. ' +
    KEY_CONFIGS_HINT +
    'Use this to check recent CI status or find a specific build.',
  {
    config_id: z
      .string()
      .describe(`Build configuration ID, e.g. '${EXAMPLE_CONFIG}'. Omit for all configs.`)
      .optional(),
    count: z.number().describe('Number of builds to return (default 5).').optional(),
    status: z
      .enum(['SUCCESS', 'FAILURE', 'any'])
      .describe("Filter by status: 'SUCCESS', 'FAILURE', or 'any' (default 'any').")
      .optional(),
  },
  async ({ config_id, count = 5, status = 'any' }) => {
    try {
      let locator = `count:${count}`;
      if (config_id) locator += `,buildType:(id:${encodeURIComponent(config_id)})`;
      if (status !== 'any') locator += `,status:${status}`;

      const data = await tcApi(
        `/app/rest/builds?locator=${locator}&fields=build(id,number,status,statusText,buildType(id,name),triggered(date,user(name)),startDate,finishDate,state)`,
      );
      const builds = data.build || [];

      if (builds.length === 0) {
        return textResult('No builds found matching the criteria.');
      }

      const lines = builds.map((b) => {
        const emoji = b.status === 'SUCCESS' ? ':large_green_circle:' : ':red_circle:';
        const user = b.triggered?.user?.name || 'auto';
        const config = b.buildType?.name || b.buildType?.id || '';
        return `${emoji} **#${b.number}** (id:${b.id}) ${config} — ${b.statusText || b.status} — triggered by ${user}`;
      });

      return textResult(lines.join('\n'));
    } catch (e) {
      return textResult(`TeamCity error: ${e.message}`);
    }
  },
);

export const getBuildDetailsTool = tool(
  'teamcity_build_details',
  'Get detailed information about a specific TeamCity build, including status, duration, and trigger info.',
  {
    build_id: z.number().describe('The numeric build ID (e.g. 45628).'),
  },
  async ({ build_id }) => {
    try {
      const b = await tcApi(
        `/app/rest/builds/id:${build_id}?fields=id,number,status,statusText,state,buildType(id,name),triggered(date,user(name)),startDate,finishDate,agent(name),statistics(property(name,value))`,
      );

      const duration = b.statistics?.property?.find((p) => p.name === 'BuildDuration');
      const durationMin = duration ? (Number.parseInt(duration.value) / 60000).toFixed(1) : '?';
      const emoji = b.status === 'SUCCESS' ? ':large_green_circle:' : ':red_circle:';

      const text =
        `${emoji} **Build #${b.number}** (id:${b.id})\n` +
        `**Config:** ${b.buildType?.name || b.buildType?.id}\n` +
        `**Status:** ${b.statusText || b.status}\n` +
        `**State:** ${b.state}\n` +
        `**Triggered by:** ${b.triggered?.user?.name || 'auto'}\n` +
        `**Agent:** ${b.agent?.name || '?'}\n` +
        `**Duration:** ${durationMin} min\n` +
        `**Link:** ${TC_BASE}/buildConfiguration/${b.buildType?.id}/${b.id}`;

      return textResult(text);
    } catch (e) {
      return textResult(`TeamCity error: ${e.message}`);
    }
  },
);

export const getBuildFailuresTool = tool(
  'teamcity_build_failures',
  'Get the list of failed tests from a specific TeamCity build. Shows test names and whether each failure is new or pre-existing.',
  {
    build_id: z.number().describe('The numeric build ID (e.g. 45628).'),
    new_only: z.boolean().describe('If true, only return NEW failures (not pre-existing). Default false.').optional(),
  },
  async ({ build_id, new_only = false }) => {
    try {
      let locator = `build:(id:${build_id}),status:FAILURE`;
      if (new_only) locator += ',newFailure:true';

      const data = await tcApi(
        `/app/rest/testOccurrences?locator=${locator}&fields=count,testOccurrence(name,newFailure,duration,details)`,
      );
      const tests = data.testOccurrence || [];
      const total = data.count || 0;

      if (tests.length === 0) {
        return textResult(new_only ? 'No new failures in this build.' : 'No test failures in this build.');
      }

      const lines = tests.map((t) => {
        const tag = t.newFailure ? ':red_circle: NEW' : ':large_yellow_circle: PRE';
        const dur = t.duration ? ` (${(t.duration / 1000).toFixed(1)}s)` : '';
        return `${tag} — ${t.name}${dur}`;
      });

      const summary = `**${total} failed tests** (${tests.filter((t) => t.newFailure).length} new):\n\n`;
      return textResult(summary + lines.join('\n'));
    } catch (e) {
      return textResult(`TeamCity error: ${e.message}`);
    }
  },
);

export const getBuildChangesTool = tool(
  'teamcity_build_changes',
  'Get the list of code changes (commits) included in a specific TeamCity build. Shows who committed what.',
  {
    build_id: z.number().describe('The numeric build ID (e.g. 45628).'),
  },
  async ({ build_id }) => {
    try {
      const data = await tcApi(
        `/app/rest/changes?locator=build:(id:${build_id})&fields=change(id,version,username,user(name),date,comment,files(file(file)))`,
      );
      const changes = data.change || [];

      if (changes.length === 0) {
        return textResult('No changes found in this build.');
      }

      const lines = changes.map((c) => {
        const author = c.user?.name || c.username || 'unknown';
        const sha = (c.version || '').slice(0, 8);
        const comment = (c.comment || '').split('\n')[0].trim();
        const fileCount = c.files?.file?.length || 0;
        return `**${author}** \`${sha}\` — ${comment} (${fileCount} files)`;
      });

      return textResult(`**${changes.length} change(s):**\n\n` + lines.join('\n'));
    } catch (e) {
      return textResult(`TeamCity error: ${e.message}`);
    }
  },
);

export const getTestDetailTool = tool(
  'teamcity_test_detail',
  'Get the full error details for a specific failed test in a build. Useful for diagnosing why a test failed.',
  {
    build_id: z.number().describe('The numeric build ID.'),
    test_name: z.string().describe('Exact test name or a substring to search for.'),
  },
  async ({ build_id, test_name }) => {
    try {
      const data = await tcApi(
        `/app/rest/testOccurrences?locator=build:(id:${build_id}),status:FAILURE,test:(name:${encodeURIComponent(test_name)})&fields=testOccurrence(name,details,newFailure,duration)`,
      );

      let tests = data.testOccurrence || [];

      if (tests.length === 0) {
        const allData = await tcApi(
          `/app/rest/testOccurrences?locator=build:(id:${build_id}),status:FAILURE&fields=testOccurrence(name,details,newFailure,duration)`,
        );
        tests = (allData.testOccurrence || []).filter((t) => t.name.toLowerCase().includes(test_name.toLowerCase()));
      }

      if (tests.length === 0) {
        return textResult(`No failed test matching "${test_name}" found in build ${build_id}.`);
      }

      const lines = tests.map((t) => {
        const details = t.details ? t.details.slice(0, 1500) : 'No details available';
        return `**${t.name}**\nNew failure: ${t.newFailure ? 'Yes' : 'No'}\n\`\`\`\n${details}\n\`\`\``;
      });

      return textResult(lines.join('\n\n'));
    } catch (e) {
      return textResult(`TeamCity error: ${e.message}`);
    }
  },
);

export const listBuildConfigsTool = tool(
  'teamcity_list_configs',
  'List available TeamCity build configurations (projects/pipelines). Useful when you need to find the right config ID.',
  {
    query: z.string().describe("Optional filter text to search config names (e.g. 'e2e', 'front', 'back').").optional(),
  },
  async ({ query }) => {
    try {
      const data = await tcApi('/app/rest/buildTypes?fields=buildType(id,name,projectName)');
      let configs = data.buildType || [];

      if (query) {
        const q = query.toLowerCase();
        configs = configs.filter(
          (c) =>
            (c.name || '').toLowerCase().includes(q) ||
            (c.id || '').toLowerCase().includes(q) ||
            (c.projectName || '').toLowerCase().includes(q),
        );
      }

      if (configs.length === 0) {
        return textResult(query ? `No configs matching "${query}".` : 'No build configs found.');
      }

      const lines = configs.map((c) => `\`${c.id}\` — ${c.name} (${c.projectName})`);
      return textResult(lines.join('\n'));
    } catch (e) {
      return textResult(`TeamCity error: ${e.message}`);
    }
  },
);
