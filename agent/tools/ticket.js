import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { textResult } from '../../utils/helpers.js';

/** Support ticket creation tool for the Casey agent. */
export const createSupportTicketTool = tool(
  'create_support_ticket',
  'Create a new IT support ticket for issues that require human follow-up. ' +
    "Use this tool when a user's issue cannot be resolved through knowledge base " +
    'articles or automated tools, and needs to be escalated to the IT support team.',
  {
    title: z.string().describe('A concise title describing the issue.'),
    description: z
      .string()
      .describe('A detailed description of the problem and any troubleshooting already attempted.'),
    priority: z
      .enum(['low', 'medium', 'high', 'critical'])
      .describe("The ticket priority level — one of 'low', 'medium', 'high', or 'critical'."),
    category: z
      .enum(['hardware', 'software', 'network', 'access', 'other'])
      .describe("The issue category — one of 'hardware', 'software', 'network', 'access', or 'other'."),
  },
  async () => {
    return textResult(
      'Support ticket creation is not yet connected to a ticketing system. Use the YouTrack tools to create a DEV issue instead, or ask the user to submit through the IT portal.',
      true,
    );
  },
);
