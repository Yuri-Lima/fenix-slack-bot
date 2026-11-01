import { YT_BASE } from '../../agent/tools/youtrack.js';
import { config } from '../../config.js';
import { createTokenReader } from '../../utils/tokens.js';

const getYtToken = createTokenReader('YOUTRACK_API_TOKEN', '.youtrack_token');
const getSlackToken = createTokenReader('SLACK_BOT_TOKEN', '.slack_bot_token');

const FETCH_TIMEOUT_MS = 15_000;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

async function uploadFileToYouTrack(ytToken, issueId, fileName, fileBuffer, mimeType, logger) {
  const formData = new FormData();
  formData.append('file', new Blob([fileBuffer], { type: mimeType }), fileName);

  const res = await fetch(`${YT_BASE}/api/issues/${issueId}/attachments?fields=id,name`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ytToken}` },
    body: formData,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    logger?.warn(`Failed to upload ${fileName} to ${issueId}: ${res.status} ${err.slice(0, 100)}`);
    return null;
  }
  return res.json();
}

/**
 * Handle the YouTrack ticket modal submission.
 * Creates the ticket via YouTrack API, uploads any Slack file attachments,
 * and posts a confirmation in the original channel.
 *
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackViewMiddlewareArgs} args
 */
export async function handleYouTrackTicketModal({ ack, body, client, logger }) {
  await ack();

  try {
    const values = body.view.state.values;
    const summary = values.summary_block.summary_input.value;
    const type = values.type_block.type_select.selected_option?.value || 'Task';
    const priority = values.priority_block.priority_select.selected_option?.value || 'Normal';
    const extra = values.extra_block?.extra_input?.value || '';

    const meta = JSON.parse(body.view.private_metadata || '{}');
    const { messageText, authorName, channelId, messageTs, files } = meta;

    const description =
      `## Original message\n**From:** ${authorName}\n\n> ${messageText}` +
      (extra ? `\n\n## Additional context\n${extra}` : '');

    const ytToken = getYtToken();
    if (!ytToken) {
      throw new Error('No YouTrack token configured');
    }

    const customFields = [
      { name: 'Type', $type: 'SingleEnumIssueCustomField', value: { name: type, $type: 'EnumBundleElement' } },
      { name: 'Priority', $type: 'SingleEnumIssueCustomField', value: { name: priority, $type: 'EnumBundleElement' } },
    ];

    const res = await fetch(`${YT_BASE}/api/issues?fields=idReadable,summary`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ytToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        summary,
        description,
        project: { shortName: config.youtrack.project, $type: 'Project' },
        customFields,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`YouTrack API ${res.status}: ${errText.slice(0, 200)}`);
    }

    const issue = await res.json();
    const issueUrl = `${YT_BASE}/issue/${issue.idReadable}`;

    // Upload Slack file attachments to the YouTrack issue
    let uploadedCount = 0;
    if (files?.length) {
      const slackToken = getSlackToken();
      if (slackToken) {
        for (const file of files) {
          try {
            if (file.size && file.size > MAX_ATTACHMENT_BYTES) {
              logger.warn(`Skipping ${file.name}: ${(file.size / 1024 / 1024).toFixed(1)}MB exceeds 10MB limit`);
              continue;
            }
            const dlRes = await fetch(file.url, {
              headers: { Authorization: `Bearer ${slackToken}` },
              signal: AbortSignal.timeout(30_000),
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
            const uploaded = await uploadFileToYouTrack(
              ytToken,
              issue.idReadable,
              file.name,
              buffer,
              file.mimetype,
              logger,
            );
            if (uploaded) uploadedCount++;
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
