import { flakyTestsTool, flakyTrendsTool, testTimelineTool } from './flaky-tracker.js';
import { listFilesTool, readFileTool, recentCommitsTool, searchCodeTool } from './gitlab.js';
import { hostHealthTool, hostLogsTool } from './grafana.js';
import {
  createSlackChannelsTool,
  createSlackDirectory,
  createSlackSendMessageTool,
  createSlackUsersTool,
} from './slack.js';
import {
  getBuildChangesTool,
  getBuildDetailsTool,
  getBuildFailuresTool,
  getTestDetailTool,
  listBuildConfigsTool,
  listRecentBuildsTool,
} from './teamcity.js';
import { usageReportTool } from './usage.js';
import { createIssueTool, getIssueTool, myIssuesTool, searchIssuesTool, updateIssueTool } from './youtrack.js';

/** Every static tool the agent can call; Slack-bound tools are added per request in agent/fenix.js. */
export const ALL_TOOLS = [
  createIssueTool,
  flakyTestsTool,
  flakyTrendsTool,
  getBuildChangesTool,
  getBuildDetailsTool,
  getBuildFailuresTool,
  getIssueTool,
  getTestDetailTool,
  hostHealthTool,
  hostLogsTool,
  listBuildConfigsTool,
  listFilesTool,
  listRecentBuildsTool,
  myIssuesTool,
  readFileTool,
  recentCommitsTool,
  searchCodeTool,
  searchIssuesTool,
  testTimelineTool,
  updateIssueTool,
];

/**
 * Tools that only read data, exposed to Claude Code through the MCP server
 * (mcp/server.js). Tools that create or change things (YouTrack create/update)
 * and Slack-bound tools are deliberately left out.
 */
export const READ_ONLY_TOOLS = [
  flakyTestsTool,
  flakyTrendsTool,
  getBuildChangesTool,
  getBuildDetailsTool,
  getBuildFailuresTool,
  getIssueTool,
  getTestDetailTool,
  hostHealthTool,
  hostLogsTool,
  listBuildConfigsTool,
  listFilesTool,
  listRecentBuildsTool,
  myIssuesTool,
  readFileTool,
  recentCommitsTool,
  searchCodeTool,
  searchIssuesTool,
  testTimelineTool,
  usageReportTool,
];

/**
 * Slack tools for the MCP server, sharing one cached workspace directory.
 * `readOnly` tools are served to every connection. `send(options)` builds slack_send_message for a
 * connection allowed to send (never OAuth sign-ins from Claude app connectors); its options say whether
 * messages wait for an owner's approval in Slack and how the connection attaches uploaded images.
 * @param {import('@slack/web-api').WebClient} client
 */
export function createSlackMcpTools(client) {
  const directory = createSlackDirectory(client);
  return {
    readOnly: [createSlackChannelsTool(directory), createSlackUsersTool(client, directory)],
    /** @param {import('./slack.js').SendToolOptions} [options] */
    send: (options) => createSlackSendMessageTool(client, directory, options),
  };
}
