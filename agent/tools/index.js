import { flakyTestsTool, flakyTrendsTool, testTimelineTool } from './flaky-tracker.js';
import { listFilesTool, readFileTool, recentCommitsTool, searchCodeTool } from './gitlab.js';
import { hostHealthTool } from './grafana.js';
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
 * `readOnly` tools are served to every connection; `owner` tools change things and are
 * served only to the owner's static-token connection (Claude Code), never to OAuth
 * sign-ins from Claude app connectors.
 * @param {import('@slack/web-api').WebClient} client
 */
export function createSlackMcpTools(client) {
  const directory = createSlackDirectory(client);
  return {
    readOnly: [createSlackChannelsTool(directory), createSlackUsersTool(client, directory)],
    owner: [createSlackSendMessageTool(client, directory)],
  };
}
