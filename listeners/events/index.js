import { handleAppHomeOpened } from './app-home-opened.js';
import { handleAppMentioned } from './app-mentioned.js';
import { handleGrafanaNotify } from './grafana-notify.js';
import { handleMessage } from './message.js';
import { handleTeamCityNotify } from './teamcity-notify.js';

/**
 * Register event listeners with the Bolt app.
 * @param {import('@slack/bolt').App} app
 * @returns {void}
 */
export function register(app) {
  app.event('app_home_opened', handleAppHomeOpened);
  app.event('app_mention', handleAppMentioned);
  app.event('message', handleTeamCityNotify);
  app.event('message', handleGrafanaNotify);
  app.event('message', handleMessage);
}
