/** What Fenix can do, shown on the Home tab. */
const CAPABILITIES = [
  ':red_circle: *Build failures*: when TeamCity posts a failed build, I reply in its thread with new vs. pre-existing failures, flaky tests, and the likely culprit commits.',
  ':recycle: *Flaky tests*: ask which tests are flaky, what got worse this week, or when a test started failing.',
  ':ticket: *YouTrack*: search, read, create, and update issues. I always confirm before changing anything.',
  ':mag: *Codebase*: search code, read files, and check recent commits.',
];

/**
 * Build the App Home view.
 * @param {string | null} [botUserId] - The bot's user ID for dynamic mentions.
 * @returns {import('@slack/types').HomeView}
 */
export function buildAppHomeView(botUserId = null) {
  const mention = botUserId ? `<@${botUserId}>` : 'me';
  return {
    type: 'home',
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: "Hey there :wave: I'm Fenix, your DevOps assistant.", emoji: true },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: CAPABILITIES.join('\n\n') },
      },
      { type: 'divider' },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Send me a DM, or mention ${mention} in a channel or thread. In channels I only reply when mentioned. Use \`@Fenix delete\` in a thread to remove my messages from it.`,
          },
        ],
      },
    ],
  };
}
