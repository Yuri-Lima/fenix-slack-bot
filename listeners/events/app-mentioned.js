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
import { handleDeleteCommand, isDeleteCommand } from './delete-thread.js';

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

/**
 * Handle app_mention events and run the Casey agent.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'app_mention'>} args
 * @returns {Promise<void>}
 */
export async function handleAppMentioned({ client, context, event, logger, say, sayStream, setStatus }) {
  try {
    const channelId = event.channel;
    const text = event.text || '';
    const threadTs = event.thread_ts || event.ts;

    // `@Fenix delete` removes the bot's messages from the thread. Owner-only;
    // anyone else sending it is ignored without a reply.
    if (isDeleteCommand(text.replace(/<@[A-Z0-9]+>/g, ''))) {
      if (!isWhitelisted(event.user)) return;
      await handleDeleteCommand({ client, event, botUserId: context.botUserId, botId: context.botId, logger });
      return;
    }

    // Access gate: only whitelisted users can interact with the bot
    if (!isWhitelisted(event.user)) {
      await say({
        text: ACCESS_DENIED_MESSAGE,
        thread_ts: threadTs,
      });
      return;
    }

    // Strip the bot mention from the text
    const cleanedText = text.replace(/<@[A-Z0-9]+>/g, '').trim();

    if (!cleanedText) {
      await say({
        text: "Hey there! How can I help you? Describe your IT issue and I'll do my best to assist.",
        thread_ts: threadTs,
      });
      return;
    }

    // Input guard: whitelisted users bypass all checks
    if (!isWhitelisted(event.user)) {
      if (isBlocked(event.user)) {
        await say({ text: GUARD_MESSAGES.blocked, thread_ts: threadTs });
        return;
      }
      const { verdict } = classifyInput(cleanedText);
      if (verdict !== 'clean') {
        const count = addStrike(event.user);
        if (count >= 2) {
          await say({ text: GUARD_MESSAGES.blocked, thread_ts: threadTs });
        } else {
          await say({ text: GUARD_MESSAGES[verdict], thread_ts: threadTs });
        }
        logger.warn(
          `Input guard: user=${event.user} verdict=${verdict} strikes=${count} text="${cleanedText.slice(0, 80)}"`,
        );
        return;
      }
    }

    // Add eyes reaction only to the first message (not threaded replies)
    if (!event.thread_ts) {
      await client.reactions.add({
        channel: channelId,
        timestamp: event.ts,
        name: 'eyes',
      });
    }

    const existingSessionId = sessionStore.getSession(channelId, threadTs);
    const userName = await resolveUserName(client, event.user);

    await replyWithAgent({
      text: cleanedText,
      client,
      channelId,
      threadTs,
      messageTs: event.ts,
      userId: event.user,
      userName,
      existingSessionId,
      setStatus,
      sayStream,
    });
  } catch (e) {
    logger.error(`Failed to handle app mention: ${e}`);
    await say({
      text: `:warning: Something went wrong. Please try again or contact ${config.ownerName}.`,
      thread_ts: event.thread_ts || event.ts,
    });
  }
}
