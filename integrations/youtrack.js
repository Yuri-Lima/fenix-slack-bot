import { baseUrl, config } from '../config.js';
import { downloadSlackFile } from '../utils/slack.js';
import { createTokenReader } from '../utils/tokens.js';
import { httpRequest, requireConfigured } from './http.js';

const YT_BASE = baseUrl(config.youtrack.url);
export const YT_PROJECT = config.youtrack.project;

/** Issue types offered when creating tickets; the first is the default. */
export const ISSUE_TYPES = ['Task', 'Bug', 'Feature'];
/** Priorities offered when creating tickets. */
export const PRIORITIES = ['Critical', 'Major', 'Normal', 'Minor'];
export const DEFAULT_TYPE = 'Task';
export const DEFAULT_PRIORITY = 'Normal';

const ISSUE_ID_RE = /^[A-Z]+-\d+$/;

const getToken = createTokenReader('YOUTRACK_API_TOKEN', '.youtrack_token');

/**
 * Validate a readable issue ID (e.g. `DEV-123`) and encode it for a URL path.
 * @param {string} id
 * @returns {string}
 */
export function validateIssueId(id) {
  if (!ISSUE_ID_RE.test(id)) throw new Error(`Invalid issue ID format: "${id}"`);
  return encodeURIComponent(id);
}

/**
 * Web link to an issue.
 * @param {string} idReadable
 * @returns {string}
 */
export function issueUrl(idReadable) {
  return `${YT_BASE}/issue/${idReadable}`;
}

/**
 * @param {string} path - Path under the YouTrack base URL, starting with `/`
 * @param {{ method?: string, body?: unknown }} [opts] - `body` is sent as JSON
 * @returns {Promise<any>} parsed JSON, or null for 204 responses
 */
export async function ytApi(path, { method = 'GET', body } = {}) {
  const token = getToken();
  requireConfigured('YouTrack', { base: YT_BASE, token, configHint: 'youtrack.url' });
  const res = await httpRequest('YouTrack', `${YT_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return res.status === 204 ? null : res.json();
}

/**
 * Attach a file to an issue.
 * @param {string} idReadable
 * @param {string} fileName
 * @param {Buffer} content
 * @param {string} mimeType
 * @returns {Promise<any>}
 */
export async function ytUploadAttachment(idReadable, fileName, content, mimeType) {
  const token = getToken();
  requireConfigured('YouTrack', { base: YT_BASE, token, configHint: 'youtrack.url' });
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(content)], { type: mimeType }), fileName);
  const res = await httpRequest(
    'YouTrack',
    `${YT_BASE}/api/issues/${validateIssueId(idReadable)}/attachments?fields=id,name`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form },
  );
  return res.json();
}

/** Largest file copied from Slack to an issue. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Copy files from Slack to an issue: each is downloaded with the bot token and uploaded as an attachment, so the
 * bytes never pass through the model. Used by the ticket shortcut and the agent's youtrack_attach_files tool.
 * @param {string} slackToken - the bot token
 * @param {string} idReadable - e.g. "DEV-123"
 * @param {Array<{ name: string, mimetype?: string, url: string, size?: number }>} files
 * @returns {Promise<{ attached: string[], skipped: string[] }>} skipped: "name (reason)"
 */
export async function attachSlackFiles(slackToken, idReadable, files) {
  /** @type {string[]} */
  const attached = [];
  /** @type {string[]} */
  const skipped = [];
  const limit = `over ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`;
  for (const f of files) {
    try {
      if ((f.size ?? 0) > MAX_ATTACHMENT_BYTES) {
        skipped.push(`${f.name} (${limit})`);
        continue;
      }
      const { data } = await downloadSlackFile(slackToken, f.url);
      if (data.byteLength > MAX_ATTACHMENT_BYTES) {
        skipped.push(`${f.name} (${limit})`);
        continue;
      }
      await ytUploadAttachment(idReadable, f.name, data, f.mimetype || 'application/octet-stream');
      attached.push(f.name);
    } catch (e) {
      skipped.push(`${f.name} (${e instanceof Error ? e.message : e})`);
    }
  }
  return { attached, skipped };
}

// ── Custom field payloads ────────────────────────────────────────────────

/**
 * @param {string} name - Field name, e.g. 'Type'
 * @param {string} value - Enum value, e.g. 'Bug'
 */
export function enumField(name, value) {
  return { name, $type: 'SingleEnumIssueCustomField', value: { name: value, $type: 'EnumBundleElement' } };
}

/**
 * @param {string} name - Field name, e.g. 'Assignee'
 * @param {string} login
 */
export function userField(name, login) {
  return { name, $type: 'SingleUserIssueCustomField', value: { login, $type: 'User' } };
}

/**
 * @param {string} state - State value, e.g. 'In Progress'
 */
export function stateField(state) {
  return { name: 'State', $type: 'StateIssueCustomField', value: { name: state, $type: 'StateBundleElement' } };
}

/**
 * Create an issue and return `{ idReadable, summary }`.
 * @param {{ summary: string, description?: string, project?: string, type?: string, priority?: string, assignee?: string }} fields
 * @returns {Promise<{ idReadable: string, summary: string }>}
 */
export function createIssue({
  summary,
  description = '',
  project = YT_PROJECT,
  type = DEFAULT_TYPE,
  priority = DEFAULT_PRIORITY,
  assignee,
}) {
  /** @type {object[]} */
  const customFields = [enumField('Type', type), enumField('Priority', priority)];
  if (assignee) customFields.push(userField('Assignee', assignee));
  return ytApi('/api/issues?fields=idReadable,summary', {
    method: 'POST',
    body: { summary, description, project: { shortName: project, $type: 'Project' }, customFields },
  });
}
