import { baseUrl, config } from '../config.js';
import { createTokenReader } from '../utils/tokens.js';
import { httpRequest, requireConfigured } from './http.js';

const GL_BASE = baseUrl(config.gitlab.url);
const PROJECT_PATH = config.gitlab.project ? encodeURIComponent(config.gitlab.project) : null;

const getToken = createTokenReader('GITLAB_TOKEN', '.gitlab_token');

/**
 * Sensitive paths the codebase tools never expose, as `[pattern, description]`.
 * Matched against every segment of a path, so a blocked directory hides its
 * contents too. The descriptions feed the agent's system prompt.
 * @type {Array<[RegExp, string]>}
 */
const BLOCKED_PATHS = [
  [/\.env($|\.)/i, '.env files'],
  [/\.(pem|key|p12|pfx|jks|keystore)$/i, 'keys and certificates (.pem, .key, .p12, .pfx, .jks, .keystore)'],
  [/secret/i, 'anything named *secret*'],
  [/credential/i, 'anything named *credential*'],
  [/\.gitlab-ci/i, 'GitLab CI config'],
  [/docker-compose/i, 'docker-compose files'],
  [/\.(netrc|npmrc|pypirc)$/i, '.netrc, .npmrc, .pypirc'],
  [/id_(rsa|ed25519|ecdsa)/i, 'SSH keys (id_rsa, id_ed25519, id_ecdsa)'],
];

/** Human-readable list of blocked paths, for the system prompt. */
export const BLOCKED_PATHS_DESCRIPTION = BLOCKED_PATHS.map(([, d]) => d).join(', ');

/**
 * @param {string} filePath - Repository-relative path
 * @returns {boolean}
 */
export function isBlockedPath(filePath) {
  return filePath
    .split('/')
    .filter(Boolean)
    .some((segment) => BLOCKED_PATHS.some(([pattern]) => pattern.test(segment)));
}

function requireGitLab() {
  const token = getToken();
  requireConfigured('GitLab', {
    base: GL_BASE && PROJECT_PATH,
    token,
    configHint: 'gitlab.url and gitlab.project',
  });
  return /** @type {string} */ (token);
}

/**
 * GET a project-scoped API path, e.g. `/search` or `/repository/tree`.
 * @param {string} projectPath - Path under `/projects/:id`
 * @param {Record<string, string | number | boolean | undefined>} [params]
 * @returns {Promise<any>}
 */
export async function glProjectApi(projectPath, params = {}) {
  const token = requireGitLab();
  const url = new URL(`${GL_BASE}/api/v4/projects/${PROJECT_PATH}${projectPath}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const res = await httpRequest('GitLab', url, { headers: { 'PRIVATE-TOKEN': token, Accept: 'application/json' } });
  return res.json();
}

/**
 * Raw file content at a ref.
 * @param {string} filePath
 * @param {string} ref
 * @returns {Promise<string>}
 */
export async function glRawFile(filePath, ref) {
  const token = requireGitLab();
  const url = new URL(
    `${GL_BASE}/api/v4/projects/${PROJECT_PATH}/repository/files/${encodeURIComponent(filePath)}/raw`,
  );
  url.searchParams.set('ref', ref);
  try {
    const res = await httpRequest('GitLab', url, { headers: { 'PRIVATE-TOKEN': token } });
    return res.text();
  } catch (e) {
    if (/** @type {any} */ (e).status === 404) throw new Error(`File not found: ${filePath} (ref: ${ref})`);
    throw e;
  }
}
