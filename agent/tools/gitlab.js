import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { baseUrl, config } from '../../config.js';
import { andMore, textResult } from '../../utils/helpers.js';
import { createTokenReader } from '../../utils/tokens.js';

export const GL_BASE = baseUrl(config.gitlab.url);
const PROJECT_PATH = config.gitlab.project ? encodeURIComponent(config.gitlab.project) : null;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_FILE_CHARS = 25_000;

const BLOCKED_PATH_PATTERNS = [
  /\.env($|\.)/i,
  /\.gitlab-ci/i,
  /docker-compose/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /secret/i,
  /credential/i,
  /\.netrc$/i,
  /\.npmrc$/i,
  /\.pypirc$/i,
  /id_rsa/i,
  /id_ed25519/i,
];

function isBlockedPath(filePath) {
  const name = filePath.split('/').pop() || filePath;
  return BLOCKED_PATH_PATTERNS.some((p) => p.test(name));
}

const getToken = createTokenReader('GITLAB_TOKEN', '.gitlab_token');

async function glApi(path, params = {}) {
  const token = getToken();
  if (!GL_BASE || !PROJECT_PATH)
    throw new Error('GitLab not configured (gitlab.url and gitlab.project in fenix.config.json)');
  if (!token) throw new Error('GitLab authentication not configured');

  const url = new URL(`${GL_BASE}/api/v4${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    headers: { 'PRIVATE-TOKEN': token, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`GitLab API error (HTTP ${res.status})`);
  }
  return res.json();
}

async function glRaw(filePath, ref = 'main') {
  const token = getToken();
  if (!GL_BASE || !PROJECT_PATH)
    throw new Error('GitLab not configured (gitlab.url and gitlab.project in fenix.config.json)');
  if (!token) throw new Error('GitLab authentication not configured');

  const encoded = encodeURIComponent(filePath);
  const url = new URL(`${GL_BASE}/api/v4/projects/${PROJECT_PATH}/repository/files/${encoded}/raw`);
  url.searchParams.set('ref', ref);

  const res = await fetch(url, {
    headers: { 'PRIVATE-TOKEN': token },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    if (res.status === 404) throw new Error(`File not found: ${filePath} (ref: ${ref})`);
    throw new Error(`GitLab API error (HTTP ${res.status})`);
  }
  return res.text();
}

export const searchCodeTool = tool(
  'repo_search_code',
  'Search for code patterns in the team GitLab repository. ' +
    'Use this to find where something is defined, locate usages, or discover relevant files. ' +
    'Returns matching file paths and code snippets with line numbers.',
  {
    query: z.string().describe('Search query (e.g. "OrderService", "createInvoice", "price calculation")'),
    ref: z.string().optional().describe('Branch or tag to search (default: main)'),
  },
  async ({ query, ref }) => {
    try {
      const results = await glApi(`/projects/${PROJECT_PATH}/search`, {
        scope: 'blobs',
        search: query,
        ref: ref || 'main',
        per_page: 15,
      });

      if (!results.length) return textResult(`No results found for "${query}"`);

      const lines = results.map((r) => {
        const snippet = (r.data || '').trim();
        const truncated = snippet.length > 300 ? snippet.slice(0, 300) + '...' : snippet;
        return `**${r.filename}** (line ${r.startline})\n\`${r.path}\`\n\`\`\`\n${truncated}\n\`\`\``;
      });

      return textResult(`Found ${results.length} results for "${query}":\n\n${lines.join('\n\n')}`);
    } catch (e) {
      return textResult(`Search failed: ${e.message}`, true);
    }
  },
);

export const readFileTool = tool(
  'repo_read_file',
  'Read a specific file from the team GitLab repository. ' +
    'Use this to examine source code, configuration, or documentation. ' +
    'Large files are truncated at 25k characters.',
  {
    path: z.string().describe('File path relative to repo root (e.g. "packages/core/src/models/order.entity.ts")'),
    ref: z.string().optional().describe('Branch or tag (default: main)'),
    start_line: z.number().optional().describe('Start reading from this line (1-based, for focused reads)'),
    end_line: z.number().optional().describe('Stop reading at this line (inclusive)'),
  },
  async ({ path, ref, start_line, end_line }) => {
    try {
      if (isBlockedPath(path)) {
        return textResult('This file type is restricted for security reasons.', true);
      }
      let content = await glRaw(path, ref || 'main');

      if (start_line || end_line) {
        const lines = content.split('\n');
        const start = Math.max(1, start_line || 1) - 1;
        const end = Math.min(lines.length, end_line || lines.length);
        content = lines
          .slice(start, end)
          .map((l, i) => `${start + i + 1}: ${l}`)
          .join('\n');
      }

      let truncated = false;
      if (content.length > MAX_FILE_CHARS) {
        content = content.slice(0, MAX_FILE_CHARS);
        truncated = true;
      }

      const suffix = truncated ? '\n\n--- truncated ---' : '';
      const ext = path.split('.').pop() || '';
      return textResult(`**${path}**\n\`\`\`${ext}\n${content}\n\`\`\`${suffix}`);
    } catch (e) {
      return textResult(`Failed to read file: ${e.message}`, true);
    }
  },
);

export const listFilesTool = tool(
  'repo_list_files',
  'List files and directories in a path of the team GitLab repository. ' +
    'Use this to browse the project structure or find files in a specific module.',
  {
    path: z.string().optional().describe('Directory path (default: repo root). Example: "packages/core/src/models"'),
    ref: z.string().optional().describe('Branch or tag (default: main)'),
    recursive: z
      .boolean()
      .optional()
      .describe('List recursively (default: false). Use sparingly on large directories.'),
  },
  async ({ path, ref, recursive }) => {
    try {
      const items = await glApi(`/projects/${PROJECT_PATH}/repository/tree`, {
        path: path || '',
        ref: ref || 'main',
        recursive: recursive ? 'true' : 'false',
        per_page: 100,
      });

      if (!items.length) return textResult(`No files found at "${path || '/'}"`);

      const dirs = items.filter((i) => i.type === 'tree').map((i) => `  ${i.name}/`);
      const files = items.filter((i) => i.type === 'blob').map((i) => `  ${i.name}`);

      const parts = [`**${path || '/'}** (${items.length} items)\n`];
      if (dirs.length) parts.push('Directories:\n' + dirs.join('\n'));
      if (files.length) parts.push('Files:\n' + files.join('\n'));

      const more = andMore(items.length, 100, '');
      if (more) parts.push(more);

      return textResult(parts.join('\n\n'));
    } catch (e) {
      return textResult(`Failed to list files: ${e.message}`, true);
    }
  },
);

export const recentCommitsTool = tool(
  'repo_recent_commits',
  'Show recent commits in the team GitLab repository. ' +
    'Optionally filter by file path to see the history of a specific file or directory. ' +
    'Use this to understand recent changes or find who modified something.',
  {
    path: z.string().optional().describe('Filter commits to a specific file or directory path'),
    ref: z.string().optional().describe('Branch name (default: main)'),
    count: z.number().min(1).max(25).optional().describe('Number of commits to return (default: 10, max: 25)'),
  },
  async ({ path, ref, count }) => {
    try {
      const params = {
        ref_name: ref || 'main',
        per_page: count || 10,
      };
      if (path) params.path = path;

      const commits = await glApi(`/projects/${PROJECT_PATH}/repository/commits`, params);

      if (!commits.length) return textResult(`No commits found${path ? ` for "${path}"` : ''}`);

      const lines = commits.map((c) => {
        const date = new Date(c.created_at).toISOString().slice(0, 10);
        const msg = c.title.length > 100 ? c.title.slice(0, 100) + '...' : c.title;
        return `- \`${c.short_id}\` ${date} **${c.author_name}**: ${msg}`;
      });

      const header = path ? `Recent commits for **${path}**:` : 'Recent commits:';
      return textResult(`${header}\n\n${lines.join('\n')}`);
    } catch (e) {
      return textResult(`Failed to get commits: ${e.message}`, true);
    }
  },
);
