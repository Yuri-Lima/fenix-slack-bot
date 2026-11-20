import { runFenixAgent } from '../agent/index.js';
import { sessionStore } from '../thread-context/index.js';
import { readSlackImages } from '../utils/slack.js';
import { budgetNote } from '../utils/usage-budget.js';
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
    threadTotals,
  } = await runFenixAgent(prompt, existingSessionId ?? undefined, deps, {
    images,
    threadTotals: existingSessionId ? sessionStore.getTotals(channelId, threadTs) : null,
  });

  if (newSessionId) {
    sessionStore.setSession(channelId, threadTs, newSessionId, threadTotals);
  }

  const streamer = sayStream();
  await streamer.append({ markdown_text: responseText });
  // Model, tokens and cost of this reply, the month so far, and what is left of a nearly used budget;
  // nothing for runs that were refused (busy, or over a budget)
  const refused = usage.outcome === 'busy' || usage.outcome === 'budget';
  const footerText = [formatUsageFooter(usage, monthToDate()), budgetNote(userId, threadTotals?.costUsd ?? 0)]
    .filter(Boolean)
    .join('  ·  ');
  /** @type {import('@slack/types').KnownBlock[]} */
  const footer = refused ? [] : [{ type: 'context', elements: [{ type: 'mrkdwn', text: footerText }] }];
  await streamer.stop({ blocks: [...footer, ...buildFeedbackBlocks()] });
}
