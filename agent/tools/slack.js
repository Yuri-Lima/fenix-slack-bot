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
 * Slack error codes explained for the model.
 * @param {string} code
 * @param {string} target
 * @returns {string}
 */
function explainSlackError(code, target) {
  switch (code) {
    case 'not_in_channel':
      return `Fenix is not a member of ${target}. Invite it there with /invite @Fenix, then try again.`;
    case 'channel_not_found':
      return `Slack cannot find ${target}, or Fenix cannot see it (private channels need an invite).`;
    case 'is_archived':
      return `${target} is archived.`;
    case 'thread_not_found':
      return 'That thread does not exist in this channel.';
    default:
      return `Slack refused the message (${code}).`;
  }
}

/**
 * @typedef {object} SlackDirectory
 * @property {(name: string) => Promise<string | undefined>} channelId - channel ID by name (without #)
 * @property {() => Promise<any[]>} members - active people in the workspace (no bots, no deactivated accounts)
 * @property {(name: string) => Promise<any[]>} findMembers - people whose handle, display or real name equals `name`
 */

/**
 * Workspace channels and people, cached for DIRECTORY_TTL_MS. One directory is
 * shared by the Slack tools so they ask Slack once.
 * @param {import('@slack/web-api').WebClient} client
 * @returns {SlackDirectory}
 */
export function createSlackDirectory(client) {
  /** @type {{ at: number, byName: Map<string, string> }} channel name -> ID */
  const channels = { at: 0, byName: new Map() };
  /** @type {{ at: number, members: any[] }} */
  const people = { at: 0, members: [] };

  /** @param {string} name */
  async function channelId(name) {
    if (Date.now() - channels.at > DIRECTORY_TTL_MS) {
      channels.byName = new Map();
      let cursor;
      do {
        const page = await client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 1000,
          cursor,
        });
        for (const c of page.channels || []) if (c.name && c.id) channels.byName.set(c.name.toLowerCase(), c.id);
        cursor = page.response_metadata?.next_cursor || undefined;
      } while (cursor);
      channels.at = Date.now();
    }
    return channels.byName.get(name.toLowerCase());
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

  return { channelId, members, findMembers };
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
  const { channelId, findMembers } = directory;

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
    const id = await channelId(value.replace(/^#/, ''));
    return id ? { channel: id } : { error: `No channel called "${value}" that Fenix can see.` };
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
        const sent = `Sent to ${where}${threadRef ? ' (in thread)' : ''}.${link ? ` ${link}` : ''}`;
        // For a DM, say if the person has a status (vacation, sick, focus...) so the user knows
        const person = /^[UW]/.test(/** @type {string} */ (channel))
          ? (await directory.members().catch(() => [])).find((m) => m.id === channel)
          : null;
        const status = person ? describeStatus(person) : '';
        return textResult(status ? `${sent}\nNote: ${personName(person)} has ${status}.` : sent);
      } catch (e) {
        const code = /** @type {any} */ (e).data?.error;
        return textResult(code ? explainSlackError(code, where) : `Could not send the message: ${e}`, true);
      }
    },
  );
}
