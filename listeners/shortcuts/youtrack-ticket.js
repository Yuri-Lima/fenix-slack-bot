import { createTokenReader } from '../../utils/tokens.js';

/**
 * Handle the "Create YouTrack Ticket" message shortcut.
 *
 * When a user right-clicks a message and picks "Create YouTrack Ticket",
 * we gather surrounding context (thread replies, or consecutive messages
 * from the same author) and show a modal with the full conversation.
 */

const getSlackUserToken = createTokenReader('SLACK_USER_TOKEN', '.slack_user_token');

/**
 * Fetch channel history, trying the bot token first, then a user token as fallback.
 */
async function fetchHistory(client, opts, logger) {
  try {
    return await client.conversations.history(opts);
  } catch (err) {
    if (err.data?.error === 'channel_not_found' || err.data?.error === 'not_in_channel') {
      const userToken = getSlackUserToken();
      if (userToken) {
        logger?.info('Bot token failed for history, retrying with user token');
        return await client.conversations.history({ ...opts, token: userToken });
      }
    }
    throw err;
  }
}

/**
 * Fetch thread replies, trying the bot token first, then a user token as fallback.
 */
async function fetchReplies(client, opts, logger) {
  try {
    return await client.conversations.replies(opts);
  } catch (err) {
    if (err.data?.error === 'channel_not_found' || err.data?.error === 'not_in_channel') {
      const userToken = getSlackUserToken();
      if (userToken) {
        logger?.info('Bot token failed for replies, retrying with user token');
        return await client.conversations.replies({ ...opts, token: userToken });
      }
    }
    throw err;
  }
}

/**
 * Gather context around the clicked message.
 * - If it's in a thread, fetch the whole thread.
 * - Otherwise, fetch recent consecutive messages from the same author.
 */
async function gatherContext(client, channelId, messageTs, threadTs, messageUser, logger) {
  const messages = [];

  if (threadTs) {
    try {
      const result = await fetchReplies(
        client,
        {
          channel: channelId,
          ts: threadTs,
          limit: 50,
        },
        logger,
      );
      for (const msg of result.messages || []) {
        if (msg.subtype) continue;
        const files = (msg.files || []).map((f) => ({
          name: f.name,
          mimetype: f.mimetype,
          url: f.url_private,
          size: f.size,
        }));
        messages.push({ user: msg.user, text: msg.text || '', ts: msg.ts, files });
      }
    } catch (err) {
      logger?.warn(`Failed to fetch thread replies: ${err.data?.error || err.message}`);
    }
  }

  if (messages.length === 0) {
    try {
      const before = await fetchHistory(
        client,
        {
          channel: channelId,
          latest: messageTs,
          inclusive: true,
          limit: 50,
        },
        logger,
      );
      const after = await fetchHistory(
        client,
        {
          channel: channelId,
          oldest: messageTs,
          inclusive: false,
          limit: 50,
        },
        logger,
      );

      const allMessages = [...(before.messages || []).reverse(), ...(after.messages || []).reverse()];

      const clickedIdx = allMessages.findIndex((m) => m.ts === messageTs);
      if (clickedIdx === -1) return messages;

      let start = clickedIdx;
      for (let i = clickedIdx - 1; i >= 0; i--) {
        if (allMessages[i].subtype) break;
        if (allMessages[i].user === messageUser) {
          start = i;
        } else {
          break;
        }
      }

      let end = clickedIdx;
      for (let i = clickedIdx + 1; i < allMessages.length; i++) {
        if (allMessages[i].subtype) break;
        if (allMessages[i].user === messageUser) {
          end = i;
        } else {
          break;
        }
      }

      for (let i = start; i <= end; i++) {
        const msg = allMessages[i];
        if (!msg.subtype) {
          const files = (msg.files || []).map((f) => ({
            name: f.name,
            mimetype: f.mimetype,
            url: f.url_private,
            size: f.size,
          }));
          messages.push({ user: msg.user, text: msg.text || '', ts: msg.ts, files });
        }
      }
    } catch (err) {
      logger?.warn(`Failed to fetch channel history: ${err.data?.error || err.message}`);
    }
  }

  return messages;
}

/**
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackShortcutMiddlewareArgs} args
 */
export async function handleYouTrackShortcut({ ack, shortcut, client, logger }) {
  await ack();

  try {
    const sc = /** @type {any} */ (shortcut);
    const messageText = sc.message?.text || '';
    const messageUser = sc.message?.user || '';
    const channelId = sc.channel?.id || '';
    const messageTs = sc.message?.ts || '';
    const threadTs = sc.message?.thread_ts || '';

    // Open a loading modal immediately to beat the 3s trigger_id expiry
    const modalRes = await client.views.open({
      trigger_id: sc.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'youtrack_ticket_modal_loading',
        title: { type: 'plain_text', text: 'Create YouTrack Ticket' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: ':hourglass_flowing_sand: Gathering context...' },
          },
        ],
      },
    });

    const viewId = modalRes.view?.id;

    let authorName = messageUser;
    if (messageUser) {
      try {
        const info = await client.users.info({ user: messageUser });
        authorName = info.user?.real_name || info.user?.name || messageUser;
      } catch {
        // keep the user ID as fallback
      }
    }

    const contextMessages = await gatherContext(client, channelId, messageTs, threadTs, messageUser, logger);

    // Collect all file attachments from gathered messages
    const allFiles = [];
    for (const msg of contextMessages) {
      for (const f of msg.files || []) {
        allFiles.push(f);
      }
    }

    let fullText;
    let previewText;

    if (contextMessages.length > 1) {
      const userCache = new Map();
      userCache.set(messageUser, authorName);

      const lines = [];
      for (const msg of contextMessages) {
        let name = userCache.get(msg.user);
        if (!name) {
          try {
            const info = await client.users.info({ user: msg.user });
            name = info.user?.real_name || info.user?.name || msg.user;
          } catch {
            name = msg.user;
          }
          userCache.set(msg.user, name);
        }
        let line = `**${name}:** ${msg.text}`;
        if (msg.files?.length) {
          const fileNames = msg.files.map((f) => f.name).join(', ');
          line += `\n  [attachments: ${fileNames}]`;
        }
        lines.push(line);
      }
      fullText = lines.join('\n\n');

      const previewLines = lines.map((l) => (l.length > 120 ? l.slice(0, 120) + '...' : l));
      previewText = previewLines.join('\n');
      if (previewText.length > 2800) {
        previewText = previewText.slice(0, 2800) + '\n...';
      }
    } else {
      fullText = messageText;
      if (allFiles.length) {
        fullText += `\n  [attachments: ${allFiles.map((f) => f.name).join(', ')}]`;
      }
      previewText = fullText.length > 2800 ? fullText.slice(0, 2800) + '...' : fullText;
    }

    const msgCount = contextMessages.length > 1 ? ` (${contextMessages.length} messages)` : '';
    const fileCount = allFiles.length ? ` + ${allFiles.length} file${allFiles.length > 1 ? 's' : ''}` : '';

    // Update the loading modal with the real form
    await client.views.update({
      view_id: viewId,
      view: {
        type: 'modal',
        callback_id: 'youtrack_ticket_modal',
        private_metadata: JSON.stringify({ messageText: fullText, authorName, channelId, messageTs, files: allFiles }),
        title: { type: 'plain_text', text: 'Create YouTrack Ticket' },
        submit: { type: 'plain_text', text: 'Create Ticket' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*From:* ${authorName}${msgCount}${fileCount}\n\n> ${previewText.split('\n').join('\n> ')}`,
            },
          },
          { type: 'divider' },
          {
            type: 'input',
            block_id: 'summary_block',
            element: {
              type: 'plain_text_input',
              action_id: 'summary_input',
              placeholder: { type: 'plain_text', text: 'Ticket title/summary' },
            },
            label: { type: 'plain_text', text: 'Summary' },
          },
          {
            type: 'input',
            block_id: 'type_block',
            element: {
              type: 'static_select',
              action_id: 'type_select',
              initial_option: {
                text: { type: 'plain_text', text: 'Task' },
                value: 'Task',
              },
              options: [
                { text: { type: 'plain_text', text: 'Task' }, value: 'Task' },
                { text: { type: 'plain_text', text: 'Bug' }, value: 'Bug' },
                { text: { type: 'plain_text', text: 'Feature' }, value: 'Feature' },
              ],
            },
            label: { type: 'plain_text', text: 'Type' },
          },
          {
            type: 'input',
            block_id: 'priority_block',
            element: {
              type: 'static_select',
              action_id: 'priority_select',
              initial_option: {
                text: { type: 'plain_text', text: 'Normal' },
                value: 'Normal',
              },
              options: [
                { text: { type: 'plain_text', text: 'Critical' }, value: 'Critical' },
                { text: { type: 'plain_text', text: 'Major' }, value: 'Major' },
                { text: { type: 'plain_text', text: 'Normal' }, value: 'Normal' },
                { text: { type: 'plain_text', text: 'Minor' }, value: 'Minor' },
              ],
            },
            label: { type: 'plain_text', text: 'Priority' },
          },
          {
            type: 'input',
            block_id: 'extra_block',
            optional: true,
            element: {
              type: 'plain_text_input',
              action_id: 'extra_input',
              multiline: true,
              placeholder: { type: 'plain_text', text: 'Additional context (optional)' },
            },
            label: { type: 'plain_text', text: 'Extra Notes' },
          },
        ],
      },
    });
  } catch (e) {
    logger.error(`Failed to open YouTrack shortcut modal: ${e}`);
  }
}
