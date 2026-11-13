import { sessionStore } from '../../thread-context/index.js';
import { GENERIC_ERROR_MESSAGE, gateRequest, isWhitelisted } from '../../utils/input-guard.js';
import { resolveUserName } from '../../utils/slack.js';
import { replyWithAgent } from '../reply-with-agent.js';
import { handleDeleteCommand, isDeleteCommand } from './delete-thread.js';
import { handleReportCommand, parseReportCommand } from './usage-report-command.js';

/**
 * Handle app_mention events and run the Fenix agent.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'app_mention'>} args
 * @returns {Promise<void>}
 */
export async function handleAppMentioned({ client, context, event, logger, say, sayStream, setStatus }) {
  try {
    const channelId = event.channel;
    const text = event.text || '';
    const threadTs = event.thread_ts || event.ts;

    const cleanedText = text.replace(/<@[A-Z0-9]+>/g, '').trim();
    // App mentions always come from a user; '' never matches an owner
    const userId = event.user ?? '';

    // `@Fenix delete` removes the bot's messages from the thread. Owner-only;
    // anyone else sending it is ignored without a reply.
    if (isDeleteCommand(cleanedText)) {
      if (!isWhitelisted(userId)) return;
      await handleDeleteCommand({ client, event, botUserId: context.botUserId, botId: context.botId, logger });
      return;
    }

    // `@Fenix report [period]`: usage report built in code (no AI tokens). Owner-only.
    const reportPeriod = parseReportCommand(cleanedText);
    if (reportPeriod !== null) {
      if (!isWhitelisted(userId)) return;
      await handleReportCommand({ client, channel: channelId, threadTs, periodArg: reportPeriod });
      return;
    }

    // Input guard + access gate: non-owners get a guard warning or the
    // access-denied reply instead of the agent
    const gate = gateRequest(userId, cleanedText);
    if (gate) {
      if (gate.verdict !== 'clean') {
        logger.warn(
          `Input guard: user=${event.user} verdict=${gate.verdict} strikes=${gate.strikes} text="${cleanedText.slice(0, 80)}"`,
        );
      }
      await say({ text: gate.reply, thread_ts: threadTs });
      return;
    }

    if (!cleanedText) {
      await say({
        text: 'Hey! Ask me about a build, a flaky test, a YouTrack ticket, or the codebase.',
        thread_ts: threadTs,
      });
      return;
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
    await say({ text: GENERIC_ERROR_MESSAGE, thread_ts: event.thread_ts || event.ts });
  }
}
