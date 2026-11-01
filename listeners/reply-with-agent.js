import { runCaseyAgent } from '../agent/index.js';
import { sessionStore } from '../thread-context/index.js';
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
}) {
  await setStatus({ status: 'Thinking…', loading_messages: LOADING_MESSAGES });

  const deps = { client, channelId, threadTs, messageTs, userId, userName };
  const { responseText, sessionId: newSessionId } = await runCaseyAgent(text, existingSessionId ?? undefined, deps);

  if (newSessionId) {
    sessionStore.setSession(channelId, threadTs, newSessionId);
  }

  const streamer = sayStream();
  await streamer.append({ markdown_text: responseText });
  await streamer.stop({ blocks: buildFeedbackBlocks() });
}
