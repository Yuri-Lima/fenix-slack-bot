/** How long a resolved display name is reused before asking Slack again. */
const USER_NAME_TTL_MS = 30 * 60_000;

/** @type {Map<string, { name: string, ts: number }>} one entry per Slack user seen */
const userNames = new Map();

/**
 * Display name for a Slack user (real name, then handle, then the ID itself).
 * Cached per process; lookups that fail fall back to the ID without caching.
 * @param {import('@slack/web-api').WebClient} client
 * @param {string | undefined} userId
 * @returns {Promise<string>}
 */
export async function resolveUserName(client, userId) {
  if (!userId) return 'unknown';
  const cached = userNames.get(userId);
  if (cached && Date.now() - cached.ts < USER_NAME_TTL_MS) return cached.name;
  try {
    const info = await client.users.info({ user: userId });
    const name = info.user?.real_name || info.user?.name || userId;
    userNames.set(userId, { name, ts: Date.now() });
    return name;
  } catch {
    return cached?.name || userId;
  }
}
