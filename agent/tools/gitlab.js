import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { DEFAULT_BRANCH, glProjectApi, glRawFile, isBlockedPath } from '../../integrations/gitlab.js';
import { andMore, textResult } from '../../utils/helpers.js';

const MAX_FILE_CHARS = 25_000;
const RESTRICTED = 'This path is restricted for security reasons.';

export const searchCodeTool = tool(
  'repo_search_code',
  'Search for code patterns in the team GitLab repository. ' +
    'Use this to find where something is defined, locate usages, or discover relevant files. ' +
    'Returns matching file paths and code snippets with line numbers.',
  {
    query: z.string().describe('Search query (e.g. "OrderService", "createInvoice", "price calculation")'),
    ref: z.string().optional().describe(`Branch or tag to search (default: ${DEFAULT_BRANCH})`),
  },
  async ({ query, ref }) => {
    try {
      /** @type {Array<{ filename: string, path: string, startline: number, data?: string }>} */
      const found = await glProjectApi('/search', {
        scope: 'blobs',
        search: query,
        ref: ref || DEFAULT_BRANCH,
        per_page: 15,
      });
      // Snippets are file content, so restricted files are dropped entirely
      const results = found.filter((r) => !isBlockedPath(r.path));
      const hidden = found.length - results.length;
      const hiddenNote = hidden > 0 ? ` (${hidden} restricted result(s) hidden)` : '';

      if (!results.length) return textResult(`No results found for "${query}"${hiddenNote}`);

      const lines = results.map((r) => {
        const snippet = (r.data || '').trim();
        const truncated = snippet.length > 300 ? `${snippet.slice(0, 300)}...` : snippet;
        return `**${r.filename}** (line ${r.startline})\n\`${r.path}\`\n\`\`\`\n${truncated}\n\`\`\``;
      });

      return textResult(`Found ${results.length} results for "${query}"${hiddenNote}:\n\n${lines.join('\n\n')}`);
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
    ref: z.string().optional().describe(`Branch or tag (default: ${DEFAULT_BRANCH})`),
    start_line: z.number().optional().describe('Start reading from this line (1-based, for focused reads)'),
    end_line: z.number().optional().describe('Stop reading at this line (inclusive)'),
  },
  async ({ path, ref, start_line, end_line }) => {
    try {
      if (isBlockedPath(path)) return textResult(RESTRICTED, true);
      let content = await glRawFile(path, ref || DEFAULT_BRANCH);

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
    ref: z.string().optional().describe(`Branch or tag (default: ${DEFAULT_BRANCH})`),
    recursive: z
      .boolean()
      .optional()
      .describe('List recursively (default: false). Use sparingly on large directories.'),
  },
  async ({ path, ref, recursive }) => {
    try {
      if (path && isBlockedPath(path)) return textResult(RESTRICTED, true);
      /** @type {Array<{ name: string, path: string, type: string }>} */
      const listed = await glProjectApi('/repository/tree', {
        path: path || '',
        ref: ref || DEFAULT_BRANCH,
        recursive: recursive ? 'true' : 'false',
        per_page: 100,
      });

      const items = listed.filter((i) => !isBlockedPath(i.path));
      if (!items.length) return textResult(`No files found at "${path || '/'}"`);

      const dirs = items.filter((i) => i.type === 'tree').map((i) => `  ${i.name}/`);
      const files = items.filter((i) => i.type === 'blob').map((i) => `  ${i.name}`);

      const parts = [`**${path || '/'}** (${items.length} items)\n`];
      if (dirs.length) parts.push(`Directories:\n${dirs.join('\n')}`);
      if (files.length) parts.push(`Files:\n${files.join('\n')}`);

      const more = andMore(listed.length, 100, '');
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
    ref: z.string().optional().describe(`Branch name (default: ${DEFAULT_BRANCH})`),
    count: z.number().min(1).max(25).optional().describe('Number of commits to return (default: 10, max: 25)'),
  },
  async ({ path, ref, count }) => {
    try {
      if (path && isBlockedPath(path)) return textResult(RESTRICTED, true);
      /** @type {Record<string, string | number>} */
      const params = {
        ref_name: ref || DEFAULT_BRANCH,
        per_page: count || 10,
      };
      if (path) params.path = path;

      const commits = await glProjectApi('/repository/commits', params);

      if (!commits.length) return textResult(`No commits found${path ? ` for "${path}"` : ''}`);

      const lines = commits.map((c) => {
        const date = new Date(c.created_at).toISOString().slice(0, 10);
        const msg = c.title.length > 100 ? `${c.title.slice(0, 100)}...` : c.title;
        return `- \`${c.short_id}\` ${date} **${c.author_name}**: ${msg}`;
      });

      const header = path ? `Recent commits for **${path}**:` : 'Recent commits:';
      return textResult(`${header}\n\n${lines.join('\n')}`);
    } catch (e) {
      return textResult(`Failed to get commits: ${e.message}`, true);
    }
  },
);
