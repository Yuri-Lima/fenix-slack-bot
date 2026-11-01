import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { baseUrl, config } from '../../config.js';
import { textResult, ytField } from '../../utils/helpers.js';
import { createTokenReader } from '../../utils/tokens.js';

export const YT_BASE = baseUrl(config.youtrack.url);
const YT_PROJECT = config.youtrack.project;
const FETCH_TIMEOUT_MS = 15_000;
const ISSUE_ID_RE = /^[A-Z]+-\d+$/;

const getToken = createTokenReader('YOUTRACK_API_TOKEN', '.youtrack_token');

function validateIssueId(id) {
  if (!ISSUE_ID_RE.test(id)) throw new Error(`Invalid issue ID format: "${id}"`);
  return encodeURIComponent(id);
}

async function ytApi(path, { method = 'GET', body } = {}) {
  const token = getToken();
  if (!YT_BASE) throw new Error('YouTrack URL not configured (youtrack.url in fenix.config.json)');
  if (!token) throw new Error('YouTrack authentication not configured');

  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${YT_BASE}${path}`, opts);
  if (!res.ok) {
    throw new Error(`YouTrack API error (HTTP ${res.status})`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export const searchIssuesTool = tool(
  'youtrack_search',
  'Search YouTrack issues using query syntax. ' +
    `Common queries: "project: ${YT_PROJECT} for: me #Unresolved", "project: ${YT_PROJECT} State: {In Progress}", ` +
    `"project: ${YT_PROJECT} created: {This week}", "project: ${YT_PROJECT} tag: Reminder".`,
  {
    query: z.string().describe(`YouTrack search query (e.g. "project: ${YT_PROJECT} for: me #Unresolved").`),
    limit: z.number().describe('Max results (default 10).').optional(),
  },
  async ({ query, limit = 10 }) => {
    try {
      const params = new URLSearchParams({
        query,
        fields:
          'idReadable,summary,resolved,created,updated,reporter(login,fullName),customFields(name,value(name,login,fullName,text))',
        $top: String(limit),
      });

      const issues = await ytApi(`/api/issues?${params}`);

      if (!issues || issues.length === 0) {
        return textResult(`No issues found for query: ${query}`);
      }

      const lines = issues.map((issue) => {
        const state = ytField(issue, 'State')?.name || '?';
        const assignee = ytField(issue, 'Assignee')?.fullName || 'Unassigned';
        const type = ytField(issue, 'Type')?.name || '?';
        const resolved = issue.resolved ? ' :white_check_mark:' : '';
        return `**${issue.idReadable}** ${issue.summary}${resolved}\n  _${type} | ${state} | ${assignee}_`;
      });

      return textResult(`**${issues.length} issue(s):**\n\n` + lines.join('\n\n'));
    } catch (e) {
      return textResult(`YouTrack error: ${e.message}`);
    }
  },
);

export const getIssueTool = tool(
  'youtrack_get_issue',
  `Get full details of a YouTrack issue by its ID (e.g. ${YT_PROJECT}-123).`,
  {
    issue_id: z.string().describe(`The issue ID (e.g. "${YT_PROJECT}-123").`),
  },
  async ({ issue_id }) => {
    try {
      const safeId = validateIssueId(issue_id);
      const issue = await ytApi(
        `/api/issues/${safeId}?fields=idReadable,summary,description,resolved,created,updated,reporter(fullName),comments(author(fullName),text,created),tags(name),customFields(name,value(name,login,fullName,text)),links(direction,linkType(name),issues(idReadable,summary))`,
      );

      const state = ytField(issue, 'State')?.name || '?';
      const assignee = ytField(issue, 'Assignee')?.fullName || 'Unassigned';
      const type = ytField(issue, 'Type')?.name || '?';
      const priority = ytField(issue, 'Priority')?.name || '?';
      const tags = (issue.tags || []).map((t) => t.name).join(', ') || 'none';
      const desc = issue.description ? issue.description.slice(0, 1000) : 'No description';

      const comments = (issue.comments || []).slice(-3).map((c) => {
        const author = c.author?.fullName || '?';
        const text = (c.text || '').slice(0, 200);
        return `> **${author}:** ${text}`;
      });

      const links = (issue.links || []).flatMap((link) =>
        (link.issues || []).map((i) => `  ${link.linkType?.name} ${link.direction}: ${i.idReadable} ${i.summary}`),
      );

      let text =
        `**${issue.idReadable}: ${issue.summary}**\n` +
        `**Type:** ${type} | **State:** ${state} | **Priority:** ${priority}\n` +
        `**Assignee:** ${assignee} | **Tags:** ${tags}\n` +
        `**Reporter:** ${issue.reporter?.fullName || '?'}\n` +
        `**Link:** ${YT_BASE}/issue/${issue.idReadable}\n\n` +
        `**Description:**\n${desc}`;

      if (links.length > 0) text += `\n\n**Links:**\n${links.join('\n')}`;
      if (comments.length > 0) text += `\n\n**Recent comments:**\n${comments.join('\n')}`;

      return textResult(text);
    } catch (e) {
      return textResult(`YouTrack error: ${e.message}`);
    }
  },
);

export const createIssueTool = tool(
  'youtrack_create_issue',
  `Create a new YouTrack issue. Default project is ${YT_PROJECT}.`,
  {
    summary: z.string().describe('Issue title/summary.'),
    description: z.string().describe('Issue description (Markdown supported).').optional(),
    project: z.string().describe(`Project key (default "${YT_PROJECT}").`).optional(),
    type: z.string().describe('Issue type: Task, Bug, Feature, etc. (default "Task").').optional(),
    priority: z.string().describe('Priority: Critical, Major, Normal, Minor (default "Normal").').optional(),
    assignee: z.string().describe('Assignee login (e.g. "jane.doe"). Omit for unassigned.').optional(),
  },
  async ({ summary, description, project = YT_PROJECT, type = 'Task', priority = 'Normal', assignee }) => {
    try {
      const customFields = [
        { name: 'Type', $type: 'SingleEnumIssueCustomField', value: { name: type, $type: 'EnumBundleElement' } },
        {
          name: 'Priority',
          $type: 'SingleEnumIssueCustomField',
          value: { name: priority, $type: 'EnumBundleElement' },
        },
      ];

      if (assignee) {
        customFields.push({
          name: 'Assignee',
          $type: 'SingleUserIssueCustomField',
          value: { login: assignee, $type: 'User' },
        });
      }

      const body = {
        summary,
        description: description || '',
        project: { shortName: project, $type: 'Project' },
        customFields,
      };

      const issue = await ytApi('/api/issues?fields=idReadable,summary', { method: 'POST', body });

      return textResult(
        `Issue created: **${issue.idReadable}** — ${issue.summary}\n${YT_BASE}/issue/${issue.idReadable}`,
      );
    } catch (e) {
      return textResult(`YouTrack error: ${e.message}`);
    }
  },
);

export const updateIssueTool = tool(
  'youtrack_update_issue',
  'Update a YouTrack issue (change state, assignee, priority, add comment, etc.).',
  {
    issue_id: z.string().describe(`The issue ID (e.g. "${YT_PROJECT}-123").`),
    state: z.string().describe('New state (e.g. "In Progress", "Fixed", "Done").').optional(),
    assignee: z.string().describe('New assignee login.').optional(),
    priority: z.string().describe('New priority.').optional(),
    summary: z.string().describe('New summary/title.').optional(),
    comment: z.string().describe('Add a comment to the issue.').optional(),
  },
  async ({ issue_id, state, assignee, priority, summary, comment }) => {
    try {
      const updates = [];

      const safeId = validateIssueId(issue_id);

      if (summary) {
        await ytApi(`/api/issues/${safeId}?fields=idReadable`, {
          method: 'POST',
          body: { summary },
        });
        updates.push('summary updated');
      }

      if (state || assignee || priority) {
        const customFields = [];
        if (state) {
          customFields.push({
            name: 'State',
            $type: 'StateIssueCustomField',
            value: { name: state, $type: 'StateBundleElement' },
          });
        }
        if (assignee) {
          customFields.push({
            name: 'Assignee',
            $type: 'SingleUserIssueCustomField',
            value: { login: assignee, $type: 'User' },
          });
        }
        if (priority) {
          customFields.push({
            name: 'Priority',
            $type: 'SingleEnumIssueCustomField',
            value: { name: priority, $type: 'EnumBundleElement' },
          });
        }
        await ytApi(`/api/issues/${safeId}?fields=idReadable`, {
          method: 'POST',
          body: { customFields },
        });
        if (state) updates.push(`state → ${state}`);
        if (assignee) updates.push(`assignee → ${assignee}`);
        if (priority) updates.push(`priority → ${priority}`);
      }

      if (comment) {
        await ytApi(`/api/issues/${safeId}/comments`, {
          method: 'POST',
          body: { text: comment },
        });
        updates.push('comment added');
      }

      return textResult(`**${issue_id}** updated: ${updates.join(', ')}\n${YT_BASE}/issue/${issue_id}`);
    } catch (e) {
      return textResult(`YouTrack error: ${e.message}`);
    }
  },
);

export const myIssuesTool = tool(
  'youtrack_my_issues',
  'Get the current user\'s open issues. Quick shortcut for "what am I working on?".',
  {
    assignee: z.string().describe('Assignee login to check (e.g. "jane.doe"). Defaults to searching all.').optional(),
    state: z.string().describe('Filter by state (e.g. "In Progress", "Open"). Default: all unresolved.').optional(),
  },
  async ({ assignee, state }) => {
    try {
      let query = `project: ${YT_PROJECT} #Unresolved`;
      if (assignee) query += ` for: ${assignee}`;
      if (state) query += ` State: {${state}}`;
      query += ' sort by: updated desc';

      const params = new URLSearchParams({
        query,
        fields: 'idReadable,summary,customFields(name,value(name,fullName))',
        $top: '15',
      });

      const issues = await ytApi(`/api/issues?${params}`);

      if (!issues || issues.length === 0) {
        return textResult('No open issues found.');
      }

      const lines = issues.map((issue) => {
        const state = ytField(issue, 'State')?.name || '?';
        const type = ytField(issue, 'Type')?.name || '?';
        return `\`${issue.idReadable}\` ${issue.summary} — _${type} | ${state}_`;
      });

      return textResult(`**${issues.length} open issue(s):**\n\n` + lines.join('\n'));
    } catch (e) {
      return textResult(`YouTrack error: ${e.message}`);
    }
  },
);
