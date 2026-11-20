import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { findPerson, listLimits, notFoundText, resetLimits, setLimits } from '../../utils/budget-limits.js';
import { textResult } from '../../utils/helpers.js';
import { formatUsageSummary, usageStatsFor } from '../../utils/usage-report.js';

/** Fenix's own AI usage, pre-aggregated in code so the model reads a short summary, never the raw log. */
export const usageReportTool = tool(
  'usage_report',
  "Fenix's own AI usage: replies, tokens, cost, models, users, tools, reply times, and rule-based analyses. " +
    'Returns a finished summary; for the full visual report in Slack the user can send `report`.',
  {
    period: z.string().optional().describe("'month' (default), 'last-month', '7d', '24h', or a month like '2026-10'"),
  },
  async ({ period }) => {
    const stats = usageStatsFor(period || '');
    if (!stats) return textResult(`Unknown period "${period}". Use month, last-month, 7d, 24h or YYYY-MM.`, true);
    return textResult(formatUsageSummary(stats));
  },
);

/**
 * Tool to list, set or reset a person's Fenix spending limits. It changes who may spend what, so it is
 * offered to owners only. The same functions back the `limit` command (listeners/events/budget-limit-command.js).
 * @param {() => string} actor - who is asking, recorded with each change
 * @param {import('../../utils/budget-limits.js').NameOf} nameOf - Slack display name for a user ID
 */
export function createBudgetLimitsTool(actor, nameOf) {
  return tool(
    'budget_limits',
    "List, raise, lower or reset a person's Fenix spending limits (USD per day and per month; owners have none). " +
      "Use when the owner asks to raise, increase, lower, change or reset someone's Fenix budget or limit, or " +
      'asks what the limits are. For "only this month" pass until "end of month". Fields not given keep their ' +
      'current value. Confirm the result to the owner in one or two sentences.',
    {
      action: z.enum(['list', 'set', 'reset']).describe("list everyone's limits, set a person's, or reset them"),
      person: z
        .string()
        .optional()
        .describe('Name (or part of it), Slack mention or user ID of the person. Required for set and reset.'),
      daily_usd: z.number().optional().describe('New daily limit in USD'),
      monthly_usd: z.number().optional().describe('New monthly limit in USD'),
      until: z
        .string()
        .optional()
        .describe('Last day the new limits apply: "YYYY-MM-DD" or "end of month". Omit to keep them until reset.'),
    },
    async ({ action, person, daily_usd: dailyUsd, monthly_usd: monthlyUsd, until }) => {
      try {
        if (action === 'list') return textResult(await listLimits(nameOf));
        if (!person) return textResult('Say whose limits to change (`person`).', true);
        const found = await findPerson(person, nameOf);
        if ('candidates' in found) return textResult(await notFoundText(person, found.candidates, nameOf), true);
        const result =
          action === 'reset' ? resetLimits(found) : setLimits(found, { dailyUsd, monthlyUsd, until }, actor());
        return textResult(result.text, !result.ok);
      } catch (e) {
        return textResult(`Could not change the limits: ${e instanceof Error ? e.message : e}`, true);
      }
    },
  );
}
