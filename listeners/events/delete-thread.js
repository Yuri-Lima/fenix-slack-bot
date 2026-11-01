import { sessionStore } from '../../thread-context/index.js';

/**
 * True when the mention text (bot mention already stripped) is the delete command.
 * @param {string} text
 * @returns {boolean}
 */
export function isDeleteCommand(text) {
  return /^delete[.!]?$/i.test(text.trim());
}

/**
 * Delete every message the bot posted in a thread, including the thread
 * parent when the bot posted it. Messages from people or other apps are left
 * alone -- the bot token can only delete the bot's own messages.
 * @param {object} args
 * @param {import('@slack/web-api').WebClient} args.client
 * @param {string} args.channelId
 * @param {string} args.threadTs
 * @param {string} [args.botUserId]
 * @param {string} [args.botId]
 * @param {import('@slack/bolt').Logger} args.logger
 * @returns {Promise<{ deleted: number, failed: number }>}
 */
export async function deleteBotMessagesInThread({ client, channelId, threadTs, botUserId, botId, logger }) {
  /** @type {string[]} */
  const botMessageTs = [];
  /** @type {string | undefined} */
  let cursor;
  do {
    const page = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 200, cursor });
    for (const m of page.messages || []) {
      const isBot = (botUserId && m.user === botUserId) || (botId && m.bot_id === botId);
      if (isBot && m.ts) botMessageTs.push(m.ts);
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);

  let deleted = 0;
  let failed = 0;
  // Replies first, parent last, so the thread never shows orphaned replies
  const ordered = [...botMessageTs.filter((ts) => ts !== threadTs), ...botMessageTs.filter((ts) => ts === threadTs)];
  for (const ts of ordered) {
    try {
      await client.chat.delete({ channel: channelId, ts });
      deleted++;
    } catch (e) {
      failed++;
      logger.error(`Failed to delete bot message ${channelId}/${ts}: ${e}`);
    }
  }

  sessionStore.deleteSession(channelId, threadTs);
  return { deleted, failed };
}

/**
 * Handle `@Fenix delete`: remove the bot's messages from the thread and tell
 * the requester (ephemerally) how it went.
 * @param {object} args
 * @param {import('@slack/web-api').WebClient} args.client
 * @param {import('@slack/types').AppMentionEvent} args.event
 * @param {string} [args.botUserId]
 * @param {string} [args.botId]
 * @param {import('@slack/bolt').Logger} args.logger
 * @returns {Promise<void>}
 */
export async function handleDeleteCommand({ client, event, botUserId, botId, logger }) {
  const channelId = event.channel;
  const user = /** @type {string} */ (event.user);

  if (!event.thread_ts) {
    await client.chat.postEphemeral({
      channel: channelId,
      user,
      text: 'Use `delete` inside a thread to remove my messages from it.',
    });
    return;
  }

  const { deleted, failed } = await deleteBotMessagesInThread({
    client,
    channelId,
    threadTs: event.thread_ts,
    botUserId,
    botId,
    logger,
  });

  // The bot token usually can't delete a user's message; try anyway and keep
  // quiet if Slack refuses.
  try {
    await client.chat.delete({ channel: channelId, ts: event.ts });
  } catch {
    // cant_delete_message -- leave the command message for the user to remove
  }

  let text =
    deleted === 0
      ? 'I had no messages in this thread to delete.'
      : `Deleted ${deleted} of my messages from this thread.`;
  if (failed > 0) text += ` ${failed} could not be deleted -- check the logs.`;

  try {
    await client.chat.postEphemeral({ channel: channelId, user, thread_ts: event.thread_ts, text });
  } catch (e) {
    // The thread may be gone entirely once its parent is deleted
    logger.warn(`Could not confirm thread delete to ${user}: ${e}`);
  }
}
