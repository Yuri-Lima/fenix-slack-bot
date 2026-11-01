import { buildAppHomeView } from '../views/app-home-builder.js';

const SUGGESTED_PROMPTS = [
  { title: 'Latest failed build', message: 'What broke in the latest failed build, and whose change caused it?' },
  { title: 'Flaky tests', message: 'Which tests are flaky right now?' },
  { title: 'My open tickets', message: 'What YouTrack issues are assigned to me?' },
];

/**
 * Handle app_home_opened events. Under agent_view, this event fires for both
 * the Home tab and the Messages tab (the agent DM). Branch on event.tab:
 *   - 'messages' → pin suggested prompts to the top of the DM
 *   - 'home'     → publish the App Home Block Kit view
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'app_home_opened'>} args
 * @returns {Promise<void>}
 */
export async function handleAppHomeOpened({ client, event, context, logger }) {
  try {
    if (event.tab === 'messages') {
      await client.assistant.threads.setSuggestedPrompts(
        // Under agent_view, suggested prompts pin to the top of the Messages tab —
        // no thread_ts is required. Cast until @slack/bolt's types catch up.
        /** @type {import('@slack/web-api').AssistantThreadsSetSuggestedPromptsArguments} */ ({
          channel_id: event.channel,
          title: 'What can I look into for you?',
          prompts: SUGGESTED_PROMPTS,
        }),
      );
      // TODO(agent-dm-messages-tab): handle app_context_changed once Bolt supports it
      return;
    }

    const userId = /** @type {string} */ (context.userId);
    const view = buildAppHomeView(context.botUserId);
    await client.views.publish({ user_id: userId, view });
  } catch (e) {
    logger.error(`Failed to handle app_home_opened: ${e}`);
  }
}
