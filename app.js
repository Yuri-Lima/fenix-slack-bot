import 'dotenv/config';

import { App, LogLevel } from '@slack/bolt';

import { registerListeners } from './listeners/index.js';
import { startMcpServer } from './mcp/server.js';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.INFO,
  ignoreSelf: false,
});

registerListeners(app);

process.on('unhandledRejection', (reason) => {
  app.logger.error(`Unhandled rejection: ${reason}`);
});

process.on('uncaughtException', (err) => {
  app.logger.error(`Uncaught exception: ${err}`);
  process.exit(1);
});

process.on('SIGTERM', async () => {
  app.logger.info('SIGTERM received, draining...');
  await app.stop();
  process.exit(0);
});

(async () => {
  await app.start();
  app.logger.info('Fenix is running!');
  startMcpServer(app.logger);
})().catch((err) => {
  console.error('Failed to start Fenix:', err);
  process.exit(1);
});
