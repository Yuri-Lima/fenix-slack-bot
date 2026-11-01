import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { textResult } from '../../utils/helpers.js';

/** User permissions lookup tool for the Casey agent. */
export const lookupUserPermissionsTool = tool(
  'lookup_user_permissions',
  "Look up a user's access permissions and group memberships for a given system. " +
    'Use this tool when a user asks about their access level, group memberships, ' +
    'or whether they have permission to use a specific system or resource.',
  {
    target_user: z.string().describe('The username or email of the user to look up.'),
    system: z.string().describe("The system or resource to check permissions for (e.g., 'github', 'jira', 'aws')."),
  },
  async () => {
    return textResult(
      'User permissions lookup is not yet connected to a directory service. Ask the user to check their access through the IT portal or contact their manager.',
      true,
    );
  },
);
