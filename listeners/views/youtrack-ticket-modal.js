import {
  attachSlackFiles,
  issueUrl as buildIssueUrl,
  createIssue,
  DEFAULT_PRIORITY,
  DEFAULT_TYPE,
} from '../../integrations/youtrack.js';

/**
 * Handle the YouTrack ticket modal submission.
 * Creates the ticket via YouTrack API, uploads any Slack file attachments,
 * and posts a confirmation in the original channel.
 *
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackViewMiddlewareArgs} args
 */
export async function handleYouTrackTicketModal({ ack, body, client, context, logger }) {
  await ack();

  try {
    const values = body.view.state.values;
    const summary = values.summary_block.summary_input.value;
    const type = values.type_block.type_select.selected_option?.value || DEFAULT_TYPE;
    const priority = values.priority_block.priority_select.selected_option?.value || DEFAULT_PRIORITY;
    const extra = values.extra_block?.extra_input?.value || '';

    const meta = JSON.parse(body.view.private_metadata || '{}');
    const { messageText, authorName, channelId, messageTs, files } = meta;

    const description =
      `## Original message\n**From:** ${authorName}\n\n> ${messageText}` +
      (extra ? `\n\n## Additional context\n${extra}` : '');

    const issue = await createIssue({ summary, description, type, priority });
    const issueUrl = buildIssueUrl(issue.idReadable);

    // Upload Slack file attachments to the YouTrack issue (same bot token Bolt uses for this request)
    let uploadedCount = 0;
    const slackToken = context.botToken;
    if (files?.length && slackToken) {
      const { attached, skipped } = await attachSlackFiles(slackToken, issue.idReadable, files);
      uploadedCount = attached.length;
      for (const why of skipped) logger.warn(`Not attached to ${issue.idReadable}: ${why}`);
    }

    const userId = body.user.id;
    const attachNote = uploadedCount ? ` (${uploadedCount} attachment${uploadedCount > 1 ? 's' : ''})` : '';
    const confirmText = `<@${userId}> created YouTrack ticket *<${issueUrl}|${issue.idReadable}>*: ${summary}${attachNote}`;

    let posted = false;
    if (channelId && messageTs) {
      try {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: messageTs,
          text: confirmText,
        });
        posted = true;
      } catch {
        // bot can't post to this channel (e.g. DM between other users), fall through to DM
      }
    }

    if (!posted) {
      const dm = await client.conversations.open({ users: userId });
      const dmChannel = dm.channel?.id;
      if (dmChannel) {
        await client.chat.postMessage({
          channel: dmChannel,
          text: `Ticket created: *<${issueUrl}|${issue.idReadable}>* - ${summary}${attachNote}`,
        });
      }
    }
  } catch (e) {
    logger.error(`Failed to create YouTrack ticket from modal: ${e}`);
    try {
      const dm = await client.conversations.open({ users: body.user.id });
      if (dm.channel?.id) {
        await client.chat.postMessage({
          channel: dm.channel.id,
          text: `:warning: Failed to create YouTrack ticket: ${e.message || e}`,
        });
      }
    } catch {
      // last resort, already logged
    }
  }
}
