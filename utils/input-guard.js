import { config } from '../config.js';

/**
 * Check if a user bypasses all guards (access gate + input filter + strikes).
 * @param {string} userId
 * @returns {boolean}
 */
export function isWhitelisted(userId) {
  return config.ownerIds.includes(userId);
}

// Term lists accept plurals (`keys?`), and path fragments that start with `.`,
// `/` or `~` are not anchored with \b, which needs a word character before them.
const SENSITIVE_PATTERNS = [
  /\b(api[_ -]?keys?|api[_ -]?tokens?|access[_ -]?tokens?|secret[_ -]?keys?|auth[_ -]?tokens?)\b/i,
  /\b(passwords?|passwd|passwort|credentials?|private[_ -]?keys?)\b/i,
  /\bssh[_ -]?(keys?|credentials?|private)\b/i,
  /(^|[^\w.])\.env\b|\b(dotenv|environment[_ -]?variables?)\b/i,
  /\b(bearer|authorization[_ -]?headers?)\b/i,
  /\b(database[_ -]?(passwords?|credentials?|connection[_ -]?strings?))\b/i,
  /\b(slack[_ -]?tokens?|bot[_ -]?tokens?|xoxb|xapp)\b/i,
  /\b(teamcity[_ -]?tokens?|gitlab[_ -]?tokens?|youtrack[_ -]?tokens?)\b/i,
];

const INJECTION_PATTERNS = [
  /\b(ignore|disregard|forget)\b.{0,30}\b(previous|above|prior|system|all)\b.{0,30}\b(instructions?|prompts?|rules?|directives?)\b/i,
  /\b(you are now|switch to|enter)\b.{0,20}\b(debug|admin|root|sudo|unrestricted|jailbreak)\b.{0,10}\b(mode)?\b/i,
  /\b(reveal|show|output|print|repeat|dump)\b.{0,30}\b(system[_ -]?prompts?|instructions?|config|secrets?|tokens?|credentials?)\b/i,
  /\b(pretend|act as if|imagine)\b.{0,30}\b(no restrictions?|no rules?|no boundar\w*|unrestricted)\b/i,
  /\bDAN\b/,
];

const INFRA_PROBE_PATTERNS = [
  /\b(server|host|machine|ip[_ -]?address|ssh|port)s?\b.{0,40}\b(access|connect\w*|login|details?|credentials?|info)\b/i,
  /\bread\b.{0,20}(\/etc\/|~\/\.|\bhome\/|\bopt\/)/i,
  /\b(cat|less|more|head|tail)\b.{0,10}(\/etc\/|~\/\.|(^|[^\w.])\.env\b)/i,
];

/**
 * @typedef {'clean' | 'sensitive' | 'injection' | 'infra_probe'} InputVerdict
 * @param {string} text
 * @returns {{ verdict: InputVerdict, matched: string | null }}
 */
function classifyInput(text) {
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
const STRIKE_TTL_HOURS = 24;
const STRIKE_TTL = STRIKE_TTL_HOURS * 60 * 60_000;
/** Strikes within the TTL window that block a user. */
const MAX_STRIKES = 2;

/**
 * Record a strike for a user. Returns the new strike count.
 * @param {string} userId
 * @returns {number}
 */
function addStrike(userId) {
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
function isBlocked(userId) {
  const entry = strikes.get(userId);
  if (!entry) return false;
  if (Date.now() - entry.ts > STRIKE_TTL) {
    strikes.delete(userId);
    return false;
  }
  return entry.count >= MAX_STRIKES;
}

const FIRST_WARNING = `This is your first warning. If you try again, your access will be blocked for ${STRIKE_TTL_HOURS} hours.`;

const MESSAGES = {
  sensitive: `:warning: I can not share tokens, passwords, API keys, or any credentials. ${FIRST_WARNING}`,
  injection: `:no_entry: That looks like an attempt to manipulate my instructions. ${FIRST_WARNING}`,
  infra_probe: `:warning: I can not share server access details, SSH credentials, or infrastructure information. ${FIRST_WARNING}`,
  blocked:
    ':no_entry: Your access has been temporarily blocked due to repeated attempts to access restricted information. ' +
    `Contact ${config.ownerName} if you need help.`,
};

/** Reply to anyone who is not on the owner list. */
const ACCESS_DENIED_MESSAGE =
  "Hey! I'm still a work in progress and not ready for everyone yet. " +
  `Only ${config.ownerName} can use me for now while I'm being tested. Stay tuned!`;

/** Generic reply when handling a request fails unexpectedly. */
export const GENERIC_ERROR_MESSAGE = `:warning: Something went wrong. Please try again or contact ${config.ownerName}.`;

/**
 * @typedef {Object} GateResult
 * @property {string} reply - Message to send back instead of running the agent
 * @property {InputVerdict} verdict - Input classification ('clean' when only the access gate applied)
 * @property {number} strikes - Strike count after this request (0 when no strike was added)
 */

/**
 * Single entry point for request screening, run before the agent. Owners pass
 * straight through. Everyone else is screened by the input guard first
 * (blocked users, credential/infra probes, prompt injection, with strikes),
 * and a clean request then gets the access-denied reply.
 * @param {string} userId
 * @param {string} text
 * @returns {GateResult | null} null when the request may proceed to the agent
 */
export function gateRequest(userId, text) {
  if (isWhitelisted(userId)) return null;
  if (isBlocked(userId)) return { reply: MESSAGES.blocked, verdict: 'clean', strikes: 0 };

  const { verdict } = classifyInput(text);
  if (verdict !== 'clean') {
    const count = addStrike(userId);
    return { reply: count >= MAX_STRIKES ? MESSAGES.blocked : MESSAGES[verdict], verdict, strikes: count };
  }
  return { reply: ACCESS_DENIED_MESSAGE, verdict, strikes: 0 };
}
