export { flakyTestsTool, flakyTrendsTool, testTimelineTool } from './flaky-tracker.js';
export {
  listFilesTool,
  readFileTool,
  recentCommitsTool,
  searchCodeTool,
} from './gitlab.js';
export { searchKnowledgeBaseTool } from './knowledge-base.js';
export { triggerPasswordResetTool } from './password-reset.js';
export { checkSystemStatusTool } from './system-status.js';
export {
  getBuildChangesTool,
  getBuildDetailsTool,
  getBuildFailuresTool,
  getTestDetailTool,
  listBuildConfigsTool,
  listRecentBuildsTool,
} from './teamcity.js';
export { createSupportTicketTool } from './ticket.js';
export { lookupUserPermissionsTool } from './user-permissions.js';
export {
  createIssueTool,
  getIssueTool,
  myIssuesTool,
  searchIssuesTool,
  updateIssueTool,
} from './youtrack.js';

import { flakyTestsTool, flakyTrendsTool, testTimelineTool } from './flaky-tracker.js';
import { listFilesTool, readFileTool, recentCommitsTool, searchCodeTool } from './gitlab.js';
import { searchKnowledgeBaseTool } from './knowledge-base.js';
import { triggerPasswordResetTool } from './password-reset.js';
import { checkSystemStatusTool } from './system-status.js';
import {
  getBuildChangesTool,
  getBuildDetailsTool,
  getBuildFailuresTool,
  getTestDetailTool,
  listBuildConfigsTool,
  listRecentBuildsTool,
} from './teamcity.js';
import { createSupportTicketTool } from './ticket.js';
import { lookupUserPermissionsTool } from './user-permissions.js';
import { createIssueTool, getIssueTool, myIssuesTool, searchIssuesTool, updateIssueTool } from './youtrack.js';

export const ALL_TOOLS = [
  checkSystemStatusTool,
  createIssueTool,
  createSupportTicketTool,
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
  lookupUserPermissionsTool,
  myIssuesTool,
  readFileTool,
  recentCommitsTool,
  searchCodeTool,
  searchIssuesTool,
  searchKnowledgeBaseTool,
  testTimelineTool,
  triggerPasswordResetTool,
  updateIssueTool,
];
