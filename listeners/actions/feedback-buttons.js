import { addFeedback } from '../../utils/feedback-store.js';
import { resolveUserName } from '../../utils/slack.js';

/**
 * Handle feedback button interactions.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackActionMiddlewareArgs<import('@slack/bolt').BlockFeedbackButtonsAction>} args
 * @returns {Promise<void>}
 */
export async function handleFeedbackButton({ ack, body, client, context, logger }) {
  await ack();

  try {
    const userId = /** @type {string} */ (context.userId);
    const channelId = /** @type {string} */ (body.channel?.id);
    const messageTs = /** @type {string} */ (body.message?.ts);
    const feedbackValue = body.actions[0].value;

    const userName = await resolveUserName(client, userId);

    if (feedbackValue === 'good-feedback') {
      addFeedback({
        userId,
        userName,
        originalText: '(thumbs up button)',
        summary: 'Positive quick feedback on bot response',
        category: 'praise',
        sentiment: 'positive',
        actionable: 'Keep doing what worked in this response',
        source: 'button',
      });

      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        thread_ts: messageTs,
        text: 'Glad that was helpful! :tada: Your feedback has been recorded.',
      });
    } else {
      addFeedback({
        userId,
        userName,
        originalText: '(thumbs down button)',
        summary: 'Negative quick feedback on bot response',
        category: 'accuracy',
        sentiment: 'negative',
        actionable: 'Review what went wrong in this response',
        source: 'button',
      });

      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        thread_ts: messageTs,
        text: "Sorry that wasn't helpful. :slightly_frowning_face: Your feedback has been recorded. Want to tell me more? Just reply in this thread with details and I'll save that too.",
      });
    }

    logger.debug(`Feedback saved: value=${feedbackValue}, user=${userName}, message_ts=${messageTs}`);
  } catch (e) {
    logger.error(`Failed to handle feedback: ${e}`);
  }
}
