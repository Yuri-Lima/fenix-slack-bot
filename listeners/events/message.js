import { config } from '../../config.js';
import { sessionStore } from '../../thread-context/index.js';
import {
  ACCESS_DENIED_MESSAGE,
  addStrike,
  classifyInput,
  GUARD_MESSAGES,
  isBlocked,
  isWhitelisted,
} from '../../utils/input-guard.js';
import { replyWithAgent } from '../reply-with-agent.js';

/**
 * @param {import('@slack/types').MessageEvent} event
 * @returns {event is import('@slack/types').GenericMessageEvent}
 */
function isGenericMessageEvent(event) {
  return !('subtype' in event && event.subtype !== undefined);
}

/**
 * @typedef {{ event_type: 'issue_submission', event_payload: { user_id: string } }} IssueSubmissionMetadata
 */

/**
 * @param {import('@slack/types').GenericMessageEvent} event
 * @returns {IssueSubmissionMetadata | null}
 */
function getIssueMetadata(event) {
  const metadata = /** @type {any} */ (event).metadata;
  return metadata?.event_type === 'issue_submission' ? metadata : null;
}

const userNameCache = new Map();
const USER_CACHE_TTL = 30 * 60_000;

async function resolveUserName(client, userId) {
  const cached = userNameCache.get(userId);
  if (cached && Date.now() - cached.ts < USER_CACHE_TTL) return cached.name;
  try {
    const info = await client.users.info({ user: userId });
    const name = info.user?.real_name || userId;
    userNameCache.set(userId, { name, ts: Date.now() });
    return name;
  } catch {
    return userId;
  }
}

async function forwardDmToOwner(client, event, logger) {
  const adminChannel = config.adminDmChannel;
  if (!adminChannel || event.channel === adminChannel) return;
  try {
    const name = await resolveUserName(client, event.user);
    const text = event.text || '(no text)';
    await client.chat.postMessage({
      channel: adminChannel,
      text: `*${name}* replied in DM:\n> ${text}`,
    });
  } catch (e) {
    logger.error(`Failed to forward DM to owner: ${e}`);
  }
}

/**
 * Handle messages sent to Casey via DM. Channel messages are handled only
 * when they @mention the bot, by the app_mention handler.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'message'>} args
 * @returns {Promise<void>}
 */
export async function handleMessage({ client, context, event, logger, say, sayStream, setStatus }) {
  // Skip message subtypes (edits, deletes, etc.)
  if (!isGenericMessageEvent(event)) return;

  // Issue submissions are posted by the bot with metadata so the message
  // handler can run the agent on behalf of the original user.
  const issueMetadata = getIssueMetadata(event);

  // Skip bot messages that are not issue submissions.
  if (event.bot_id && !issueMetadata) return;

  // Skip @mentions in channels -- app_mention handler covers those
  if (context.botUserId && event.text?.includes(`<@${context.botUserId}>`)) return;

  // Only DMs are handled here (issue submissions are posted as DMs too). In
  // channels and channel threads the bot replies only when @mentioned, even in
  // threads it is already part of -- the app_mention handler covers those and
  // resumes the thread's session.
  const isDm = event.channel_type === 'im';
  if (!isDm) return;

  const effectiveUser = issueMetadata?.event_payload?.user_id || event.user;

  // Forward DMs from non-whitelisted users to the admin DM channel
  if (!issueMetadata && !isWhitelisted(event.user)) {
    forwardDmToOwner(client, event, logger);
  }

  // Access gate: only whitelisted users can interact with the bot
  if (!isWhitelisted(effectiveUser)) {
    await say({
      text: ACCESS_DENIED_MESSAGE,
      thread_ts: event.thread_ts || event.ts,
    });
    return;
  }

  try {
    const channelId = event.channel;
    const text = event.text || '';
    const threadTs = event.thread_ts || event.ts;
    const userId = issueMetadata?.event_payload?.user_id || event.user;

    // Input guard: whitelisted users bypass all checks
    if (!isWhitelisted(userId)) {
      if (isBlocked(userId)) {
        await say({ text: GUARD_MESSAGES.blocked, thread_ts: threadTs });
        return;
      }
      const { verdict } = classifyInput(text);
      if (verdict !== 'clean') {
        const count = addStrike(userId);
        if (count >= 2) {
          await say({ text: GUARD_MESSAGES.blocked, thread_ts: threadTs });
        } else {
          await say({ text: GUARD_MESSAGES[verdict], thread_ts: threadTs });
        }
        logger.warn(`Input guard: user=${userId} verdict=${verdict} strikes=${count} text="${text.slice(0, 80)}"`);
        return;
      }
    }

    const existingSessionId = sessionStore.getSession(channelId, threadTs);

    // Add eyes reaction only to the first message of the conversation
    if (!existingSessionId) {
      await client.reactions.add({
        channel: channelId,
        timestamp: event.ts,
        name: 'eyes',
      });
    }

    const userName = await resolveUserName(client, userId);

    await replyWithAgent({
      text,
      client,
      channelId,
      threadTs,
      messageTs: event.ts,
      userId,
      userName,
      existingSessionId,
      setStatus,
      sayStream,
    });
  } catch (e) {
    logger.error(`Failed to handle message: ${e}`);
    await say({
      text: `:warning: Something went wrong. Please try again or contact ${config.ownerName}.`,
      thread_ts: event.thread_ts || event.ts,
    });
  }
}
