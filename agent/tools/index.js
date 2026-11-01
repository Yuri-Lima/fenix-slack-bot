import { flakyTestsTool, flakyTrendsTool, testTimelineTool } from './flaky-tracker.js';
import { listFilesTool, readFileTool, recentCommitsTool, searchCodeTool } from './gitlab.js';
import {
  getBuildChangesTool,
  getBuildDetailsTool,
  getBuildFailuresTool,
  getTestDetailTool,
  listBuildConfigsTool,
  listRecentBuildsTool,
} from './teamcity.js';
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
