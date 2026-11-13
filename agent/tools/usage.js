import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
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
