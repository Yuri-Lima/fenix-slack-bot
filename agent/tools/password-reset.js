import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { textResult } from '../../utils/helpers.js';

/** Password reset tool for the Casey agent. */
export const triggerPasswordResetTool = tool(
  'trigger_password_reset',
  'Trigger a password reset for a specified user account. ' +
    'Use this tool when a user requests a password reset for their own account ' +
    'or reports being locked out. The reset link will be sent to their registered email address. ' +
    "IMPORTANT: You need the user's email address for target_user. " +
    "First, try to look up the user's Slack profile to get their email address. " +
    'If the lookup fails or does not return an email, ask the user for their email address. ' +
    'Never guess or assume — you must either look it up or ask for it.',
  { target_user: z.string().describe('The username or email of the user whose password should be reset.') },
  async () => {
    return textResult(
      'Password reset is not yet connected to a real identity provider. Ask the user to reset their password through the IT portal directly.',
      true,
    );
  },
);
