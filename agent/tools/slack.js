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
 * Tool that posts a message as Fenix to a channel, a DM or a thread. It changes
 * something, so it is never in READ_ONLY_TOOLS: the MCP server offers it only to
 * the owner's static-token connection.
 * @param {import('@slack/web-api').WebClient} client
 */
export function createSlackSendMessageTool(client) {
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

  /** @param {string} name */
  async function memberIds(name) {
    if (Date.now() - people.at > DIRECTORY_TTL_MS) {
      people.members = [];
      let cursor;
      do {
        const page = await client.users.list({ limit: 1000, cursor });
        people.members.push(...(page.members || []).filter((m) => !m.deleted && !m.is_bot && m.id !== 'USLACKBOT'));
        cursor = page.response_metadata?.next_cursor || undefined;
      } while (cursor);
      people.at = Date.now();
    }
    const wanted = name.toLowerCase();
    return people.members
      .filter((m) =>
        [m.name, m.profile?.display_name, m.profile?.real_name, m.real_name].some((n) => n?.toLowerCase() === wanted),
      )
      .map((m) => ({ id: m.id, name: m.real_name || m.name }));
  }

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
      const matches = await memberIds(value.slice(1));
      if (matches.length === 1) return { channel: matches[0].id };
      if (matches.length > 1) {
        return {
          error: `"${value}" matches ${matches.map((m) => `${m.name} (${m.id})`).join(', ')}. Use the user ID.`,
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
        return textResult(`Sent to ${where}${threadRef ? ' (in thread)' : ''}.${link ? ` ${link}` : ''}`);
      } catch (e) {
        const code = /** @type {any} */ (e).data?.error;
        return textResult(code ? explainSlackError(code, where) : `Could not send the message: ${e}`, true);
      }
    },
  );
}
