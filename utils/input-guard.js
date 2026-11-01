import { config } from '../config.js';

/**
 * Check if a user bypasses all guards (access gate + input filter + strikes).
 * @param {string} userId
 * @returns {boolean}
 */
export function isWhitelisted(userId) {
  return config.ownerIds.includes(userId);
}

const SENSITIVE_PATTERNS = [
  /\b(api[_ -]?key|api[_ -]?token|access[_ -]?token|secret[_ -]?key|auth[_ -]?token)\b/i,
  /\b(password|passwd|passwort|credential|private[_ -]?key)\b/i,
  /\bssh[_ -]?(key|credential|private)\b/i,
  /\b(\.env|dotenv|environment[_ -]?variable)\b/i,
  /\b(bearer|authorization[_ -]?header)\b/i,
  /\b(database[_ -]?(password|credential|connection[_ -]?string))\b/i,
  /\b(slack[_ -]?token|bot[_ -]?token|xoxb|xapp)\b/i,
  /\b(teamcity[_ -]?token|gitlab[_ -]?token|youtrack[_ -]?token)\b/i,
];

const INJECTION_PATTERNS = [
  /\b(ignore|disregard|forget)\b.{0,30}\b(previous|above|prior|system|all)\b.{0,30}\b(instruction|prompt|rule|directive)\b/i,
  /\b(you are now|switch to|enter)\b.{0,20}\b(debug|admin|root|sudo|unrestricted|jailbreak)\b.{0,10}\b(mode)?\b/i,
  /\b(reveal|show|output|print|repeat|dump)\b.{0,30}\b(system[_ -]?prompt|instruction|config|secret|token|credential)\b/i,
  /\b(pretend|act as if|imagine)\b.{0,30}\b(no restriction|no rule|no boundar|unrestricted)\b/i,
  /\bDAN\b/,
];

const INFRA_PROBE_PATTERNS = [
  /\b(server|host|machine|ip[_ -]?address|ssh|port)\b.{0,40}\b(access|connect|login|detail|credential|info)\b/i,
  /\bread\b.{0,20}\b(\/etc\/|~\/\.|home\/|opt\/)\b/i,
  /\b(cat|less|more|head|tail)\b.{0,10}\b(\/etc\/|~\/\.|\.env)\b/i,
];

/**
 * @typedef {'clean' | 'sensitive' | 'injection' | 'infra_probe'} InputVerdict
 * @param {string} text
 * @returns {{ verdict: InputVerdict, matched: string | null }}
 */
export function classifyInput(text) {
  for (const p of INJECTION_PATTERNS) {
    const m = text.match(p);
    if (m) return { verdict: 'injection', matched: m[0] };
  }
  for (const p of SENSITIVE_PATTERNS) {
    const m = text.match(p);
    if (m) return { verdict: 'sensitive', matched: m[0] };
  }
  for (const p of INFRA_PROBE_PATTERNS) {
    const m = text.match(p);
    if (m) return { verdict: 'infra_probe', matched: m[0] };
  }
  return { verdict: 'clean', matched: null };
}

const strikes = new Map();
const STRIKE_TTL = 24 * 60 * 60_000;

/**
 * Record a strike for a user. Returns the new strike count.
 * @param {string} userId
 * @returns {number}
 */
export function addStrike(userId) {
  const now = Date.now();
  const entry = strikes.get(userId);
  if (entry && now - entry.ts < STRIKE_TTL) {
    entry.count++;
    entry.ts = now;
    return entry.count;
  }
  strikes.set(userId, { count: 1, ts: now });
  return 1;
}

/**
 * Check if a user is currently blocked.
 * @param {string} userId
 * @returns {boolean}
 */
export function isBlocked(userId) {
  const entry = strikes.get(userId);
  if (!entry) return false;
  if (Date.now() - entry.ts > STRIKE_TTL) {
    strikes.delete(userId);
    return false;
  }
  return entry.count >= 2;
}

const MESSAGES = {
  sensitive:
    ':warning: I can not share tokens, passwords, API keys, or any credentials. ' +
    'This is your first warning. If you try again, your access will be blocked for 24 hours.',
  injection:
    ':no_entry: That looks like an attempt to manipulate my instructions. ' +
    'This is your first warning. If you try again, your access will be blocked for 24 hours.',
  infra_probe:
    ':warning: I can not share server access details, SSH credentials, or infrastructure information. ' +
    'This is your first warning. If you try again, your access will be blocked for 24 hours.',
  blocked:
    ':no_entry: Your access has been temporarily blocked due to repeated attempts to access restricted information. ' +
    `Contact ${config.ownerName} if you need help.`,
};

export const GUARD_MESSAGES = MESSAGES;

/** Reply to anyone who is not on the owner list. */
export const ACCESS_DENIED_MESSAGE =
  "Hey! I'm still a work in progress and not ready for everyone yet. " +
  `Only ${config.ownerName} can use me for now while I'm being tested. Stay tuned!`;
