import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { config } from '../../config.js';
import { textResult } from '../../utils/helpers.js';

/** Longest message accepted; Slack truncates the display of longer text. */
export const MAX_MESSAGE_CHARS = 4000;
/** How long the channel and member directories are reused before asking Slack again. */
const DIRECTORY_TTL_MS = 10 * 60_000;
/** Slack conversation and user IDs: C (channel), G (private group), D (DM), U/W (user). */
const SLACK_ID = /^[CGDUW][A-Z0-9]{6,}$/;
/** Message timestamp, as in a ts field. */
const MESSAGE_TS = /^\d{10}\.\d{6}$/;

/**
 * Parse a thread reference: a message ts, or a Slack message link
 * (https://<workspace>.slack.com/archives/<channel>/p<ts digits>[?thread_ts=<parent ts>]).
 * A link to a reply carries its parent in thread_ts, which is what Slack needs.
 * @param {string} ref
 * @returns {{ ts: string, channel?: string } | null}
 */
export function parseThreadRef(ref) {
  const value = ref.trim();
  if (MESSAGE_TS.test(value)) return { ts: value };
  /** @type {URL} */
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const match = url.pathname.match(/\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})$/);
  if (!url.hostname.endsWith('.slack.com') || !match) return null;
  const parent = url.searchParams.get('thread_ts');
  return { channel: match[1], ts: parent && MESSAGE_TS.test(parent) ? parent : `${match[2]}.${match[3]}` };
}

/**
 * Fenix's own Slack identity, so messages name the right bot (its display name may differ from "Fenix").
 * @typedef {{ userId: string, handle: string, name: string }} BotIdentity
 */

/**
 * How to invite Fenix, naming the exact bot user.
 * @param {BotIdentity | null} bot
 * @returns {string}
 */
export const inviteHint = (bot) => (bot ? `/invite @${bot.handle} (the bot shown as "${bot.name}")` : '/invite @Fenix');

/** What Fenix can see and where it can post, for the model. */
const CHANNEL_RULES =
  'Fenix sees every public channel and can post in all of them without being invited; ' +
  'private channels only show up once Fenix is a member.';

/**
 * Levenshtein distance, for suggesting channel names close to a mistyped one.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * Slack error codes explained for the model.
 * @param {string} code
 * @param {string} target
 * @param {BotIdentity | null} bot
 * @returns {string}
 */
function explainSlackError(code, target, bot) {
  switch (code) {
    case 'not_in_channel':
      return `${target} is private and Fenix is not a member. Invite it with ${inviteHint(bot)}, then try again.`;
    case 'channel_not_found':
      return `Slack cannot find ${target}. ${CHANNEL_RULES} If it is private, invite Fenix with ${inviteHint(bot)}.`;
    case 'is_archived':
      return `${target} is archived.`;
    case 'thread_not_found':
      return 'That thread does not exist in this channel.';
    default:
      return `Slack refused the message (${code}).`;
  }
}

/**
 * A channel Fenix can see.
 * @typedef {{ id: string, name: string, isPrivate: boolean, isMember: boolean }} ChannelInfo
 */

/**
 * @typedef {object} SlackDirectory
 * @property {() => Promise<ChannelInfo[]>} channels - every channel Fenix can see (public, plus private ones it is in)
 * @property {(name: string) => Promise<ChannelInfo | undefined>} channelByName - by name, with or without #
 * @property {(name: string) => Promise<string[]>} similarChannels - up to 3 names close to a mistyped one
 * @property {() => Promise<any[]>} members - active people in the workspace (no bots, no deactivated accounts)
 * @property {(name: string) => Promise<any[]>} findMembers - people whose handle, display or real name equals `name`
 * @property {() => Promise<BotIdentity | null>} bot - Fenix's own Slack user
 */

/**
 * Workspace channels and people, cached for DIRECTORY_TTL_MS. One directory is
 * shared by the Slack tools so they ask Slack once.
 * @param {import('@slack/web-api').WebClient} client
 * @returns {SlackDirectory}
 */
export function createSlackDirectory(client) {
  /** @type {{ at: number, list: ChannelInfo[] }} */
  const channelCache = { at: 0, list: [] };
  /** @type {{ at: number, members: any[] }} */
  const people = { at: 0, members: [] };
  /** @type {Promise<BotIdentity | null> | null} */
  let botIdentity = null;

  async function channels() {
    if (Date.now() - channelCache.at > DIRECTORY_TTL_MS) {
      /** @type {ChannelInfo[]} */
      const found = [];
      let cursor;
      do {
        const page = await client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 1000,
          cursor,
        });
        for (const c of page.channels || []) {
          if (c.name && c.id)
            found.push({ id: c.id, name: c.name, isPrivate: !!c.is_private, isMember: !!c.is_member });
        }
        cursor = page.response_metadata?.next_cursor || undefined;
      } while (cursor);
      channelCache.list = found;
      channelCache.at = Date.now();
    }
    return channelCache.list;
  }

  /** @param {string} name */
  async function channelByName(name) {
    const wanted = name.replace(/^#/, '').toLowerCase();
    return (await channels()).find((c) => c.name.toLowerCase() === wanted);
  }

  /** @param {string} name */
  async function similarChannels(name) {
    const wanted = name.replace(/^#/, '').toLowerCase();
    return (await channels())
      .map((c) => ({ name: c.name, score: editDistance(wanted, c.name.toLowerCase()) }))
      .filter(
        (c) =>
          c.score <= 2 || (wanted.length >= 3 && (c.name.includes(wanted) || wanted.includes(c.name.toLowerCase()))),
      )
      .sort((a, b) => a.score - b.score)
      .slice(0, 3)
      .map((c) => `#${c.name}`);
  }

  function bot() {
    botIdentity ??= (async () => {
      const auth = await client.auth.test();
      const info = await client.users.info({ user: /** @type {string} */ (auth.user_id) });
      const handle = info.user?.name || auth.user || 'fenix';
      return { userId: /** @type {string} */ (auth.user_id), handle, name: info.user?.real_name || handle };
    })().catch(() => {
      botIdentity = null; // try again next time
      return null;
    });
    return botIdentity;
  }

  async function members() {
    if (Date.now() - people.at > DIRECTORY_TTL_MS) {
      /** @type {any[]} */
      const found = [];
      let cursor;
      do {
        const page = await client.users.list({ limit: 1000, cursor });
        found.push(...(page.members || []).filter((m) => !m.deleted && !m.is_bot && m.id !== 'USLACKBOT'));
        cursor = page.response_metadata?.next_cursor || undefined;
      } while (cursor);
      people.members = found;
      people.at = Date.now();
    }
    return people.members;
  }

  /** @param {string} name */
  async function findMembers(name) {
    const wanted = name.toLowerCase();
    return (await members()).filter((m) =>
      [m.name, m.profile?.display_name, m.profile?.real_name, m.real_name].some((n) => n?.toLowerCase() === wanted),
    );
  }

  return { channels, channelByName, similarChannels, members, findMembers, bot };
}

/**
 * Read-only tool listing the channels Fenix can post in, and whether it needs an invite.
 * @param {SlackDirectory} directory
 */
export function createSlackChannelsTool(directory) {
  return tool(
    'slack_channels',
    'List the Slack channels Fenix can post in: every public channel (no invite needed) and the private channels ' +
      'it is a member of, with their IDs. Use it to find the exact channel name before posting, or to check whether ' +
      'Fenix needs to be invited somewhere.',
    {
      query: z.string().optional().describe('Only channels whose name contains this text. Leave out to list all.'),
    },
    async ({ query }) => {
      try {
        const wanted = (query || '').trim().replace(/^#/, '').toLowerCase();
        const list = (await directory.channels())
          .filter((c) => !wanted || c.name.toLowerCase().includes(wanted))
          .sort((a, b) => a.name.localeCompare(b.name));
        const bot = await directory.bot();
        const footer =
          `\n${CHANNEL_RULES} Fenix posts as "${bot?.name || 'Fenix'}"` +
          `${bot ? ` (@${bot.handle})` : ''}. To post in another private channel, invite it with ${inviteHint(bot)}.`;
        if (!list.length) {
          const close = wanted ? await directory.similarChannels(wanted) : [];
          const hint = close.length ? ` Did you mean ${close.join(', ')}?` : '';
          return textResult(`No channel matches "${query}".${hint}${footer}`);
        }
        const lines = list.map((c) => {
          const access = c.isPrivate
            ? 'private · Fenix is a member'
            : `public · ${c.isMember ? 'Fenix is a member' : 'Fenix can post without an invite'}`;
          return `• #${c.name} (${c.id}): ${access}`;
        });
        return textResult(`${list.length} channel${list.length === 1 ? '' : 's'}:\n${lines.join('\n')}${footer}`);
      } catch (e) {
        return textResult(`Could not list Slack channels: ${e}`, true);
      }
    },
  );
}

/** Most people slack_users looks up presence for (one Slack call each). */
export const MAX_PRESENCE_LOOKUPS = 25;

/**
 * Read-only tool listing the people Fenix can message, with what Slack knows
 * about their availability: active/away, custom status (vacation, sick, focus...)
 * and when it clears, huddles, and their local time.
 * @param {import('@slack/web-api').WebClient} client
 * @param {SlackDirectory} [directory] - shared with slack_send_message; a private one by default
 */
export function createSlackUsersTool(client, directory = createSlackDirectory(client)) {
  return tool(
    'slack_users',
    'List the people in the Slack workspace that Fenix can message, with their handle, user ID, title, ' +
      'whether they are active or away, their status (vacation, sick, focus...) and until when, huddles, and their ' +
      'local time. Use it before DMing someone, to pick the right person and check they are around.',
    {
      query: z
        .string()
        .optional()
        .describe('Only people whose name, handle or title contains this text. Leave out to list everyone.'),
    },
    async ({ query }) => {
      try {
        const wanted = (query || '').trim().toLowerCase().replace(/^@/, '');
        const people = (await directory.members())
          .filter(
            (m) =>
              !wanted ||
              [m.name, m.real_name, m.profile?.display_name, m.profile?.title].some((v) =>
                v?.toLowerCase().includes(wanted),
              ),
          )
          .sort((a, b) => personName(a).localeCompare(personName(b)));
        if (!people.length) return textResult(query ? `Nobody matches "${query}".` : 'No people found.');

        const withPresence = people.length <= MAX_PRESENCE_LOOKUPS;
        const presence = withPresence
          ? await Promise.all(
              people.map((m) =>
                client.users
                  .getPresence({ user: m.id })
                  .then((r) => r.presence)
                  .catch(() => undefined),
              ),
            )
          : [];
        const now = new Date();
        const lines = people.map((m, i) => {
          const local = m.tz
            ? `${now.toLocaleTimeString('en-GB', { timeZone: m.tz, hour: '2-digit', minute: '2-digit' })} local (${m.tz})`
            : '';
          const facts = [
            presence[i],
            describeStatus(m),
            local,
            m.is_restricted ? 'guest' : '',
            m.id === config.ownerIds[0] ? "bot owner, 'me'" : '',
          ].filter(Boolean);
          const title = m.profile?.title ? `, ${m.profile.title}` : '';
          return `• ${personName(m)} (@${m.name}, ${m.id}${title}): ${facts.join(' · ')}`;
        });
        const note = withPresence
          ? ''
          : `\nActive/away is shown only for ${MAX_PRESENCE_LOOKUPS} people or fewer; narrow the query.`;
        return textResult(`${people.length} ${people.length === 1 ? 'person' : 'people'}:\n${lines.join('\n')}${note}`);
      } catch (e) {
        return textResult(`Could not list Slack users: ${e}`, true);
      }
    },
  );
}

/** @param {any} member */
const personName = (member) => member.real_name || member.profile?.real_name || member.name || member.id;

/**
 * A person's Slack status in words: custom status (with when it clears) and huddle.
 * Empty when they have none.
 * @param {any} member - users.list member
 * @returns {string}
 */
export function describeStatus(member) {
  const p = member.profile || {};
  const parts = [];
  if (p.status_text || p.status_emoji) {
    const until = p.status_expiration
      ? ` until ${new Date(p.status_expiration * 1000).toLocaleString('en-GB', {
          timeZone: member.tz || config.timeZone,
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        })}`
      : '';
    parts.push(`status ${[p.status_emoji, p.status_text].filter(Boolean).join(' ')}${until}`);
  }
  if (p.huddle_state === 'in_a_huddle') parts.push('in a huddle');
  return parts.join(', ');
}

/**
 * Tool that posts a message as Fenix to a channel, a DM or a thread. It changes
 * something, so it is never in READ_ONLY_TOOLS: the MCP server offers it only to
 * the owner's static-token connection.
 * @param {import('@slack/web-api').WebClient} client
 * @param {SlackDirectory} [directory] - shared with slack_users; a private one by default
 */
export function createSlackSendMessageTool(client, directory = createSlackDirectory(client)) {
  const { channelByName, similarChannels, findMembers } = directory;

  /**
   * Resolve where to post. Returns the Slack channel (a user ID posts to the DM with Fenix).
   * @param {string} to
   * @returns {Promise<{ channel: string } | { error: string }>}
   */
  async function resolveTarget(to) {
    const value = to.trim();
    if (value.toLowerCase() === 'me') {
      return config.ownerIds[0] ? { channel: config.ownerIds[0] } : { error: 'No bot owner is configured for "me".' };
    }
    if (SLACK_ID.test(value)) return { channel: value };
    if (value.startsWith('@')) {
      const matches = await findMembers(value.slice(1));
      if (matches.length === 1) return { channel: matches[0].id };
      if (matches.length > 1) {
        return {
          error: `"${value}" matches ${matches.map((m) => `${personName(m)} (${m.id})`).join(', ')}. Use the user ID.`,
        };
      }
      return { error: `No workspace member is called "${value.slice(1)}". Use their Slack handle or user ID.` };
    }
    const found = await channelByName(value);
    if (found) return { channel: found.id };
    const close = await similarChannels(value);
    const bot = await directory.bot();
    return {
      error:
        `No channel called "${value}".${close.length ? ` Did you mean ${close.join(', ')}?` : ''} ${CHANNEL_RULES} ` +
        `So unless the name is mistyped, "${value}" is a private channel: invite Fenix with ${inviteHint(bot)}.`,
    };
  }

  return tool(
    'slack_send_message',
    'Post a message as Fenix (the team bot) in Slack: to a channel, as a DM, or as a reply in a thread. ' +
      'Write the finished message in Slack mrkdwn; it is sent exactly as given. Returns the message link.',
    {
      to: z
        .string()
        .optional()
        .describe(
          "Where to post: 'me' (DM the bot owner), '#channel-name', '@person' (DM by handle or name), " +
            'or a Slack channel or user ID. May be left out when `thread` is a message link.',
        ),
      text: z
        .string()
        .min(1)
        .max(MAX_MESSAGE_CHARS)
        .describe(
          'The message in Slack mrkdwn: *bold*, _italic_, `code`, ```blocks```, <https://url|label>, <@U123> mentions.',
        ),
      thread: z
        .string()
        .optional()
        .describe(
          'Reply in a thread: the link to a message in it (https://<workspace>.slack.com/archives/…) or its ts.',
        ),
    },
    async ({ to, text, thread }) => {
      const threadRef = thread ? parseThreadRef(thread) : null;
      if (thread && !threadRef) return textResult(`"${thread}" is not a Slack message link or ts.`, true);
      if (!to && !threadRef?.channel)
        return textResult('Say where to post: `to`, or a message link in `thread`.', true);

      // A thread link decides the conversation; `to` may only repeat it
      let channel = threadRef?.channel;
      if (to) {
        const target = await resolveTarget(to);
        if ('error' in target) return textResult(target.error, true);
        if (channel && channel !== target.channel) {
          return textResult(`The thread link is in ${channel}, not ${to}. Leave \`to\` out to reply there.`, true);
        }
        channel = target.channel;
      }
      const where = to || channel || '';

      try {
        const posted = await client.chat.postMessage({
          channel: /** @type {string} */ (channel),
          text,
          thread_ts: threadRef?.ts,
          unfurl_links: false,
        });
        const link = await client.chat
          .getPermalink({
            channel: /** @type {string} */ (posted.channel),
            message_ts: /** @type {string} */ (posted.ts),
          })
          .then((r) => r.permalink)
          .catch(() => null);
        const bot = await directory.bot();
        const as = bot ? ` as "${bot.name}" (@${bot.handle})` : '';
        const sent = `Sent${as} to ${where}${threadRef ? ' (in thread)' : ''}.${link ? ` ${link}` : ''}`;
        // For a DM, say if the person has a status (vacation, sick, focus...) so the user knows
        const person = /^[UW]/.test(/** @type {string} */ (channel))
          ? (await directory.members().catch(() => [])).find((m) => m.id === channel)
          : null;
        const status = person ? describeStatus(person) : '';
        return textResult(status ? `${sent}\nNote: ${personName(person)} has ${status}.` : sent);
      } catch (e) {
        const code = /** @type {any} */ (e).data?.error;
        const bot = await directory.bot();
        return textResult(code ? explainSlackError(code, where, bot) : `Could not send the message: ${e}`, true);
      }
    },
  );
}
