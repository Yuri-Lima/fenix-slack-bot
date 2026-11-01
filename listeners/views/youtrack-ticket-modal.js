import { FETCH_TIMEOUT_MS } from '../../integrations/http.js';
import {
  issueUrl as buildIssueUrl,
  createIssue,
  DEFAULT_PRIORITY,
  DEFAULT_TYPE,
  ytUploadAttachment,
} from '../../integrations/youtrack.js';

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Slack file downloads can be large, so they get a longer timeout than API calls. */
const DOWNLOAD_TIMEOUT_MS = 2 * FETCH_TIMEOUT_MS;

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

    // Upload Slack file attachments to the YouTrack issue
    let uploadedCount = 0;
    if (files?.length) {
      // Same bot token Bolt uses for this request; url_private needs it
      const slackToken = context.botToken;
      if (slackToken) {
        for (const file of files) {
          try {
            if (file.size && file.size > MAX_ATTACHMENT_BYTES) {
              logger.warn(`Skipping ${file.name}: ${(file.size / 1024 / 1024).toFixed(1)}MB exceeds 10MB limit`);
              continue;
            }
            const dlRes = await fetch(file.url, {
              headers: { Authorization: `Bearer ${slackToken}` },
              signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
            });
            if (!dlRes.ok) {
              logger.warn(`Failed to download Slack file ${file.name}: ${dlRes.status}`);
              continue;
            }
            const buffer = Buffer.from(await dlRes.arrayBuffer());
            if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
              logger.warn(
                `Skipping ${file.name}: downloaded size ${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB exceeds 10MB limit`,
              );
              continue;
            }
            await ytUploadAttachment(issue.idReadable, file.name, buffer, file.mimetype);
            uploadedCount++;
          } catch (err) {
            logger.warn(`Error processing file ${file.name}: ${err.message}`);
          }
        }
      }
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
