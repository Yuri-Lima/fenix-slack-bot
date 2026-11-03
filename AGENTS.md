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
| `YOUTRACK_API_TOKEN` | YouTrack permanent token (or `~/.youtrack_token`) |
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

### Dependency Injection

`runFenixAgent(text, sessionId, deps)` takes a required `deps` object with `{ client, channelId, threadTs, messageTs, userId, userName }`. Tools that need Slack API access (emoji reactions, mark resolved, feedback) are created as closures inside `runFenixAgent()` that capture the `deps` parameter. Static tools (TeamCity, flaky tracker, YouTrack, GitLab) are module-level exports in `agent/tools/`, collected in `ALL_TOOLS`.

### Integrations

`integrations/` is the single home of external API access: `http.js` (shared timeout, `requireConfigured`, uniform `<Service> API error (HTTP n)`), `teamcity.js` (client, request limiter, `locatorValue`, `buildUrl`, change helpers), `test-history.js` (TeamCity pass/fail history, flaky thresholds, classification, infra-kill detection via `isInfraKill`), `youtrack.js` (client, attachment upload, issue URL, custom-field builders, issue types/priorities), and `gitlab.js` (client, blocked-path list). Agent tools in `agent/tools/` and Slack listeners import from here; never call these services with `fetch` directly or create a second token reader. Slack user names resolve through `utils/slack.js`.

Tool handlers return `textResult(message, true)` from every `catch`, so the agent sees failures as errors.

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
