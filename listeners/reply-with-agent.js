import { runFenixAgent } from '../agent/index.js';
import { sessionStore } from '../thread-context/index.js';
import { readSlackImages } from '../utils/slack.js';
import { formatUsageFooter } from '../utils/usage-report.js';
import { monthToDate } from '../utils/usage-store.js';
import { buildFeedbackBlocks } from './views/feedback-builder.js';

const LOADING_MESSAGES = [
  'Teaching the hamsters to type faster…',
  'Untangling the internet cables…',
  'Consulting the office goldfish…',
  'Polishing up the response just for you…',
  'Convincing the AI to stop overthinking…',
];

/**
 * Shared agent-reply pipeline used by both message and app_mention handlers.
 * Sets the loading status, runs the agent, saves the session, and streams the reply.
 *
 * @param {Object} opts
 * @param {string} opts.text - The user's message text
 * @param {import('@slack/web-api').WebClient} opts.client
 * @param {string} opts.channelId
 * @param {string} opts.threadTs
 * @param {string} opts.messageTs
 * @param {string} opts.userId
 * @param {string} opts.userName
 * @param {string | null | undefined} opts.existingSessionId
 * @param {Function} opts.setStatus
 * @param {Function} opts.sayStream
 * @param {Parameters<typeof readSlackImages>[1]} [opts.files] - Files attached to the message; images are read
 */
export async function replyWithAgent({
  text,
  client,
  channelId,
  threadTs,
  messageTs,
  userId,
  userName,
  existingSessionId,
  setStatus,
  sayStream,
  files = [],
}) {
  await setStatus({ status: 'Thinking…', loading_messages: LOADING_MESSAGES });

  const { images, skipped } = await readSlackImages(client, files);
  const prompt = [
    text || (images.length ? '(No text; see the attached images.)' : ''),
    skipped.length ? `[Attachments you could not read: ${skipped.join('; ')}]` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const deps = { client, channelId, threadTs, messageTs, userId, userName };
  const {
    responseText,
    sessionId: newSessionId,
    usage,
  } = await runFenixAgent(prompt, existingSessionId ?? undefined, deps, { images });

  if (newSessionId) {
    sessionStore.setSession(channelId, threadTs, newSessionId);
  }

  const streamer = sayStream();
  await streamer.append({ markdown_text: responseText });
  // Model, tokens and cost of this reply, plus the month so far; nothing for rejected (busy) runs
  /** @type {import('@slack/types').KnownBlock[]} */
  const footer =
    usage.outcome === 'busy'
      ? []
      : [{ type: 'context', elements: [{ type: 'mrkdwn', text: formatUsageFooter(usage, monthToDate()) }] }];
  await streamer.stop({ blocks: [...footer, ...buildFeedbackBlocks()] });
}
