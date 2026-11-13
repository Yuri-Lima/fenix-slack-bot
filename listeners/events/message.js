import { config } from '../../config.js';
import { sessionStore } from '../../thread-context/index.js';
import { GENERIC_ERROR_MESSAGE, gateRequest, isWhitelisted } from '../../utils/input-guard.js';
import { resolveUserName } from '../../utils/slack.js';
import { replyWithAgent } from '../reply-with-agent.js';
import { handleReportCommand, parseReportCommand } from './usage-report-command.js';

/**
 * @param {import('@slack/types').MessageEvent} event
 * @returns {event is import('@slack/types').GenericMessageEvent}
 */
function isGenericMessageEvent(event) {
  return !('subtype' in event && event.subtype !== undefined);
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
 * Handle messages sent to Fenix via DM. Channel messages are handled only
 * when they @mention the bot, by the app_mention handler.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'message'>} args
 * @returns {Promise<void>}
 */
export async function handleMessage({ client, context, event, logger, say, sayStream, setStatus }) {
  // Skip message subtypes (edits, deletes, etc.)
  if (!isGenericMessageEvent(event)) return;

  // Skip bot messages, including Fenix's own
  if (event.bot_id) return;

  // Skip @mentions in channels -- app_mention handler covers those
  if (context.botUserId && event.text?.includes(`<@${context.botUserId}>`)) return;

  // Only DMs are handled here. In
  // channels and channel threads the bot replies only when @mentioned, even in
  // threads it is already part of -- the app_mention handler covers those and
  // resumes the thread's session.
  const isDm = event.channel_type === 'im';
  if (!isDm) return;

  const userId = event.user;
  const text = event.text || '';
  const threadTs = event.thread_ts || event.ts;

  // Forward DMs from non-whitelisted users to the admin DM channel
  if (!isWhitelisted(userId)) {
    forwardDmToOwner(client, event, logger);
  }

  // Input guard + access gate: non-owners get a guard warning or the
  // access-denied reply instead of the agent
  const gate = gateRequest(userId, text);
  if (gate) {
    if (gate.verdict !== 'clean') {
      logger.warn(
        `Input guard: user=${userId} verdict=${gate.verdict} strikes=${gate.strikes} text="${text.slice(0, 80)}"`,
      );
    }
    await say({ text: gate.reply, thread_ts: threadTs });
    return;
  }

  // `report [period]`: usage report built in code (no AI tokens); only owners get past the gate
  const reportPeriod = parseReportCommand(text);
  if (reportPeriod !== null) {
    await handleReportCommand({ client, channel: event.channel, threadTs, periodArg: reportPeriod });
    return;
  }

  try {
    const channelId = event.channel;
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
    await say({ text: GENERIC_ERROR_MESSAGE, thread_ts: threadTs });
  }
}
