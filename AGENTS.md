# AGENTS.md - Fenix

Fenix is a Slack DevOps assistant built with Bolt for JavaScript and the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview) (`@anthropic-ai/claude-agent-sdk`).

See [README.md](README.md) for features, tools, and deployment.

## Setup

```sh
cp .env.sample .env                          # ANTHROPIC_API_KEY, SLACK_BOT_TOKEN, SLACK_APP_TOKEN
cp fenix.config.example.json fenix.config.json  # owners, TeamCity/GitLab/YouTrack URLs
npm install
npm start
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `SLACK_BOT_TOKEN` | Bot token (`xoxb-`) |
| `SLACK_APP_TOKEN` | App-level token (`xapp-`) for Socket Mode |
| `TEAMCITY_TOKEN` | TeamCity access token (or `~/.teamcity_token`) |
| `GITLAB_TOKEN` | GitLab read token (or `~/.gitlab_token`) |
| `GRAFANA_TOKEN` | Grafana Viewer service-account token (or `~/.grafana_token`) |
| `FENIX_MCP_TOKEN` | Bearer token for the MCP endpoint (or `~/.fenix_mcp_token`) |
| `YOUTRACK_API_TOKEN` | YouTrack permanent token (or `~/.youtrack_token`) |
| `ANTHROPIC_ADMIN_KEY` | Optional Admin API key (or `~/.anthropic_admin_key`) to read Fenix's bill; read-only use |
| `SLACK_USER_TOKEN` | Optional user token (`xoxp-`) for the YouTrack shortcut's DM context (or `~/.slack_user_token`) |
| `FENIX_CONFIG` | Path to the config file (default `fenix.config.json`) |

## Configuration

Deployment-specific values never live in source. `config.js` loads `fenix.config.json` (git-ignored; template in `fenix.config.example.json`) and exports a `config` object with owner IDs, the admin DM channel, TeamCity/GitLab/YouTrack URLs, the TeamCity Slack bot ID, and key build configs. Team knowledge for the system prompt (codebase layout, conventions) goes in `prompts/context.local.md` (git-ignored; template in `prompts/context.example.md`). Do not hardcode company URLs, Slack IDs, or names in source or tests. Tests run against `tests/fixtures/fenix.config.json`.

## Commands

```sh
npm install          # Install dependencies
npm start            # Start the app
npm run lint         # Biome lint and format check
npm run lint:fix     # Auto-fix lint and format issues
npm run check        # Type check JavaScript with tsc (checkJs)
```

## Testing

Tests use the Node.js built-in test runner (`node:test`) and assertion module (`node:assert`).

```sh
npm test             # Run all tests
```

### Conventions

- Test files live in `tests/` and mirror the source directory structure
- Tests run with `tests/fixtures/fenix.config.json`, whose `dataDir` is `tests/.data`, so they never touch real data in `data/`
- File naming: `<source-file>.test.js` (not `.spec.js`)
- Use `describe()` / `it()` / `beforeEach()` blocks from `node:test`
- Use `mock.fn()` from `node:test` for mocking — no external mock libraries
- Assertions use `node:assert` (`strictEqual`, `ok`, `deepStrictEqual`)
- Mock Slack client methods as `mock.fn()` objects with the needed nested structure
- Test files use ES module `import` statements (`"type": "module"`)

### What to Test

- **View builders** — pure functions, test structure and data correctness
- **Listener handlers** — mock `ack`, `client`, `context`, `logger`; verify API calls and error handling
- **SessionStore** — instantiate directly, test CRUD, TTL expiry, and eviction

## Architecture

### Agent Layer

The agent is defined in `agent/fenix.js` using the Claude Agent SDK:

- `query({ prompt, options })` returns an async generator of messages
- Tools are defined with `tool()` from the SDK using Zod v4 schemas
- Tools are wrapped in an in-process MCP server via `createSdkMcpServer()`
- Tools return MCP `CallToolResult` format: `{ content: [{ type: 'text', text }] }`
- `permissionMode: 'bypassPermissions'` since all tools are safe
- Model: the Agent SDK default (no `model` option is set)

### Conversation Management

`thread-context/store.js` exports a `SessionStore` that stores **session IDs only** (not full message history). The Claude Agent SDK manages conversation history server-side. The store passes `{ resume: sessionId }` on subsequent turns to continue a conversation.

The store uses a `Map` keyed by `${channelId}:${threadTs}` with TTL-based cleanup (24 hours) and a max entry limit (1000). Build keys with `threadKey()` from `thread-context/`.

### Access

`utils/input-guard.js`: `isOwner()` (`ownerIds`) gets admin tools, the `report` and `delete` commands and every approval; `isAllowed()` adds `allowedUserIds`, who may ask the agent but still pass the input guard. Never use `isAllowed()` for anything that changes Fenix itself or approves an action.

### Dependency Injection

`runFenixAgent(text, sessionId, deps)` takes a required `deps` object with `{ client, channelId, threadTs, messageTs, userId, userName }`. Tools that need Slack API access (emoji reactions, mark resolved, feedback, attaching the thread's files to a YouTrack issue through `attachSlackFiles()` in `integrations/youtrack.js`, which the ticket shortcut uses too) are created as closures inside `runFenixAgent()` that capture the `deps` parameter. Static tools (TeamCity, flaky tracker, YouTrack, GitLab) are module-level exports in `agent/tools/`, collected in `ALL_TOOLS`.

### Integrations

`integrations/` is the single home of external API access: `http.js` (shared timeout, `requireConfigured`, uniform `<Service> API error (HTTP n)`), `teamcity.js` (client, request limiter, `locatorValue`, `buildUrl`, change helpers), `test-history.js` (TeamCity pass/fail history, flaky thresholds, classification, infra-kill detection via `isInfraKill`), `youtrack.js` (client, attachment upload, issue URL, custom-field builders, issue types/priorities), `gitlab.js` (client, blocked-path list), `grafana.js` (read-only Prometheus/Loki queries through Grafana's data source proxy), `host-health.js` (evidence about a host around an alert, the pure `diagnose()` verdicts, `readableLogLine()`, which also masks secrets, and `logHosts()`/`lokiHostFor()`, the cached Loki host list and exact host matching; never match hosts by prefix; `ignoredBy()` checks `ignoreHostParts()`, which combines `grafana.ignoreHosts` with the parts owners added through the `grafana_ignore_hosts` tool, stored by `utils/ignore-hosts-store.js` in data/, each with an optional `until` after which it stops applying on its own, and `exact` entries, listed by `ignoreHostNames()`, that match one whole server name via `serverOf()`, never a substring), and `host-logs.js` (host-name resolution and grouped log timelines for the `host_logs` tool). Agent tools in `agent/tools/` and Slack listeners import from here; never call these services with `fetch` directly or create a second token reader. Slack user names resolve through `utils/slack.js`, and files attached to a message are downloaded there too (`readSlackFiles()`: Slack's file host only, at most 4 per message; images and PDFs type checked with `sniffFile()`, text with `textChecker()`, masked with `maskSecrets()` and cut to its end) and passed to `runFenixAgent()` as image and document blocks. Times people give ("2026-11-16 11:10") are parsed with `parseLocalTime()` in `config.timeZone`; each prompt is stamped with its send time (and, for owners, `ownerTitle`, how to address them) by `buildPrompt()` (in the user message, so the system prompt stays cacheable).

Tool handlers return `textResult(message, true)` from every `catch`, so the agent sees failures as errors.

### Usage Tracking

Every run is recorded through `utils/usage-store.js`: `runFenixAgent()` records agent runs (including busy, timeout and error outcomes) from the SDK result's `modelUsage`, `total_cost_usd`, `num_turns` and `duration_ms`; rule-based analyses record `ruleBasedRun()` with zero tokens. Logs rotate monthly (`data/usage/YYYY-MM.jsonl`, append-only, retention `usage.retentionMonths`). Never store message text. Reports are aggregated in code (`utils/usage-report.js`, `listeners/views/usage-report-builder.js`); never send raw usage records to the model.

The SDK reports a resumed session's usage as the running total of the whole thread, so the session store keeps each thread's totals (`setSession(…, totals)`) and `sinceLastReply()` logs a reply with its own cost; never record `total_cost_usd` of a resumed run directly.

Budgets (`utils/usage-budget.js`, `config.usage.budgets`) are checked in `runFenixAgent()` before the model is called, from the in-memory per-person totals (`spendByUser()`), and each reply is capped with the SDK's `maxBudgetUsd`. Owners are never refused. Refusals reply in code and are logged with the outcome `budget`. Limits are in billed dollars: `utils/billing.js` syncs Anthropic's bill for Fenix's keys (`integrations/anthropic-billing.js`, `config.usage.billing`, Admin API key) and `calibration()` gives the billed/estimated ratio over the last 7 complete billed days; read spend through `billedSpend()`, never `spendByUser()` directly, and only ever list costs with the admin key. Owners change a person's limits through `utils/budget-limits.js` only, used by both the `budget_limits` tool (owner-only) and the `limit` command (`listeners/events/budget-limit-command.js`, no tokens); those limits live in `data/budget-overrides.json` and win over `perUser`, field by field, until their `until` day.

### Translations

`listeners/events/translate-watch.js` translates German channel messages for the owners in `config.translate.userIds` (`translateUserIds()` in `utils/translate-prefs.js` drops anyone who is not an owner): messages in threads they wrote in or were mentioned in, and top-level messages that mention them. Participants are found with `conversations.replies` once per thread and cached; messages are batched per thread and person (`translate.batchSeconds`) and translated by `translateMessages()` in `agent/translate.js` (one Claude Haiku call with structured output, no agent; `mightBeGerman()` skips clearly English text without a call). Mentions become plain names before translating (`plainMentions()`) and `noMentions()` neutralizes any left in the output, so a translation notifies only the person it is for. The reply (`listeners/views/translation-builder.js`) has buttons, used only by that person (`listeners/actions/translate-buttons.js`), that re-read the messages from Slack to translate them again or stop the thread. Settings (`translate …` commands, `listeners/events/translate-command.js`) live in `data/translate-prefs.json`. Each call is logged as the person's `agent` usage with the tool `translate`. Never store message text.

### MCP Endpoint

`mcp/server.js` serves `READ_ONLY_TOOLS` (from `agent/tools/index.js`) to Claude Code over Streamable HTTP, stateless, behind `FENIX_MCP_TOKEN`. It registers the same tool objects the agent uses; never re-implement a tool for MCP. Only add a tool to `READ_ONLY_TOOLS` if it cannot change anything. Slack tools come from `createSlackMcpTools(client)`, which shares one cached workspace directory: its `readOnly` tools (`slack_channels`, `slack_users`) go to every connection, and `send(approve)` builds `slack_send_message` (which changes things) only for callers with the `send` scope, never for OAuth sign-ins. Callers are identified in `identifyCaller()` (`mcp/server.js`): the static token is `claude-code`; named clients (Cursor, Grok, ...) come from `mcp/clients.js` (`data/mcp-clients.json`, token hashes only, managed with `scripts/mcp-client.js` / `npm run vps:mcp-client`); clients with `sendApproval: "slack"` only draft, and an owner posts with the Send button (`mcp/send-approval.js`, `listeners/actions/mcp-send-approval.js`). Images, videos, PDFs and text/log files reach `slack_send_message` through `POST`/`PUT /uploads` (`mcp/uploads.js`: send scope only, owner-bound, single use, binary formats checked by `sniffFile()`, text by `textChecker()` as it streams, `mcp.maxUploadMb`, 1 hour, streamed to `data/uploads/`; waiting uploads and drafts are saved in data/ through `utils/json-file.js`, which every store in data/ uses) and go to Slack streamed (`uploadFileToSlack` in `utils/slack.js`); whoever takes an upload deletes its file. Never take file bytes as a tool argument. Never let a client that may run tools without asking its user send without Slack approval. Claude app connectors sign in through the OAuth server in `mcp/oauth.js` (discovery, CIMD fetched only from `mcp.cimdOrigins`, DCR limited to `mcp.oauthRedirectUris`, port-agnostic loopback redirects, PKCE, rotating refresh tokens stored hashed); every sign-in needs an owner's Approve click in Slack (`listeners/actions/mcp-oauth-approval.js`). Never add a way to obtain tokens without that approval.

### Tool Definitions

Tools in `agent/tools/` are defined using `tool()` from the Claude Agent SDK:

```js
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export const myTool = tool(
  'tool_name',
  'Description of what this tool does',
  { query: z.string() },
  async (args) => ({
    content: [{ type: 'text', text: 'result' }],
  })
);
```
