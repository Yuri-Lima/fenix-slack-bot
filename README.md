<div align="center">

<img src="assets/icon.png" alt="Fenix" width="140" height="140" />

# Fenix

**An AI DevOps teammate that lives in Slack.**

Fenix explains why your CI broke, tracks flaky tests over time, manages YouTrack tickets, and reads your codebase,
all from a Slack thread. Built on [Bolt for JavaScript](https://tools.slack.dev/bolt-js/) and the
[Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview).

![Node.js](https://img.shields.io/badge/node-%E2%89%A520.11-339933?logo=node.js&logoColor=white)
![Slack Bolt](https://img.shields.io/badge/Slack-Bolt%205-4A154B?logo=slack&logoColor=white)
![Claude Agent SDK](https://img.shields.io/badge/Claude-Agent%20SDK-D97757?logo=anthropic&logoColor=white)
![Socket Mode](https://img.shields.io/badge/transport-Socket%20Mode-0B7285)
![Tests](https://img.shields.io/badge/tests-node%3Atest-2F9E44)
![License](https://img.shields.io/badge/license-MIT-blue)

[Features](#features) · [Tools](#tool-catalog) · [Architecture](#architecture) · [Configuration](#configuration) · [Deployment](#deployment) · [Development](#development)

</div>

---

## Why Fenix

CI notifications tell you *that* a build failed. Fenix tells you **why**, **since when**, and **whose change most likely
caused it**, as a threaded reply under the notification, before anyone has opened a browser tab.

Beyond that, Fenix is a conversational agent with direct, scoped access to the systems an engineering team lives in
(TeamCity, YouTrack, GitLab), so questions like *"what broke the frontend e2e suite this morning?"* or *"open a bug
for this and assign it to me"* get answered in the thread where they were asked.

## Features

| | Capability | What it does |
|---|---|---|
| 🔴 | **Automatic build-failure analysis** | Watches TeamCity notifications in Slack and replies in-thread with new vs. pre-existing failures, flaky tests, the real error behind Cypress/Docker boilerplate, and a ranked list of likely-culprit commits. |
| ♻️ | **Flaky-test tracker** | Records every analysed build to a persistent history and answers "what's flaky?", "what got worse this week?", and "when did this test start failing?". |
| 🎫 | **YouTrack assistant** | Search, read, create, and update issues in natural language, with explicit confirmation before any write. |
| 🧭 | **Codebase navigator** | Read-only GitLab access to search code, read files, browse directories, and inspect recent commits. |
| 📝 | **"Create YouTrack Ticket" shortcut** | Message shortcut that turns any Slack message (and its surrounding context) into a pre-filled ticket. |
| 🧹 | **Thread cleanup** | `@Fenix delete` removes every message Fenix posted in a thread. |
| 💬 | **Feedback loop** | 👍/👎 buttons on every answer plus conversational feedback capture, stored for the owner to review. |
| 🛡️ | **Guardrails** | Owner allowlist, prompt-injection and credential-probing detection with strikes, a strict tool allowlist, and redaction rules. |

## How to talk to Fenix

| Where | How | Behaviour |
|---|---|---|
| **Direct message** | Just write | Fenix answers in a thread and keeps context across follow-ups. |
| **Channels and threads** | `@Fenix <question>` | Fenix replies **only when mentioned**, including inside threads it already joined. A mention resumes that thread's conversation. |
| **TeamCity notifications** | Nothing; automatic | Failed-build messages from the TeamCity app get an analysis reply, no mention needed. |
| **App Home** | Pick a category | A modal collects the details and Fenix starts a DM thread with a resolution. |
| **Assistant panel** | *Add Agent → Fenix* | Suggested prompts to get started. |
| **Message shortcut** | ⋯ → *Create YouTrack Ticket* | Opens a ticket form pre-filled from the message. |

### Commands

| Command | Who | Effect |
|---|---|---|
| `@Fenix delete` | Owners | Deletes every message Fenix posted in the current thread (parent included, if Fenix posted it), then confirms privately. Anyone else is ignored silently. |

## Tool catalog

Fenix's agent can only call the tools below. It runs with Claude Code's built-in tools (`Bash`, `Read`, `Write`,
`Edit`, `WebFetch`, `WebSearch`) explicitly disabled and an allowlist that contains nothing else.

### TeamCity CI/CD

| Tool | Purpose |
|---|---|
| `teamcity_list_builds` | Recent builds for a configuration, filterable by status. |
| `teamcity_build_details` | Status, duration, agent, and trigger info for one build. |
| `teamcity_build_failures` | Failed tests in a build, flagged as new or pre-existing. |
| `teamcity_build_changes` | Commits included in a build and their authors. |
| `teamcity_test_detail` | Full error output for one failed test. |
| `teamcity_list_configs` | Discover build configuration IDs. |

### Flaky-test tracker

| Tool | Purpose |
|---|---|
| `teamcity_flaky_tests` | Tests with a 15–90% fail rate. Uses stored history, falls back to the live TeamCity API. |
| `teamcity_flaky_trends` | Tests whose fail rate rose between two time windows. |
| `teamcity_test_timeline` | Pass/fail history of one test, with partial-name search. |

> A test failing in more than 90% of runs is classed as **broken**, not flaky. History builds up automatically from
> every failure notification Fenix analyses (capped at 60 runs per test and 300 builds per configuration).

### YouTrack

| Tool | Purpose |
|---|---|
| `youtrack_search` | Search with YouTrack query syntax (`project: DEV State: {In Progress}`). |
| `youtrack_get_issue` | Full issue details: description, fields, comments, links. |
| `youtrack_my_issues` | Shortcut for someone's open issues. |
| `youtrack_create_issue` | Create an issue with type, priority, and assignee. **Requires confirmation.** |
| `youtrack_update_issue` | Change state, assignee, or priority, or add a comment. **Requires confirmation.** |

### Codebase (GitLab, read-only)

| Tool | Purpose |
|---|---|
| `repo_search_code` | Search code across the configured repository. |
| `repo_read_file` | Read a file, with optional line ranges (truncated at 25k chars). |
| `repo_list_files` | Browse the directory tree. |
| `repo_recent_commits` | Recent commits, optionally scoped to a path. |

> Sensitive paths (`.env*`, keys and certificates, `*secret*`, `*credential*`, CI and compose files, `.npmrc`,
> SSH keys) are blocked at the tool level, regardless of what the model asks for.

### Slack interaction

| Tool | Purpose |
|---|---|
| `add_emoji_reaction` | Acknowledge a message with a topic-appropriate reaction. |
| `mark_resolved` | Add ✅ to the thread's parent once an issue is resolved. |
| `save_user_feedback` | Store structured feedback (summary, category, sentiment, actionable) after the user confirms it. |
| `list_user_feedback` | *Owner only.* Review stored feedback with filters. |
| `feedback_stats` | *Owner only.* Aggregate feedback by category and sentiment. |

### IT helpdesk (simulated)

`search_knowledge_base`, `create_support_ticket`, `trigger_password_reset`, `check_system_status`, and
`lookup_user_permissions` are inherited from the original IT-support template. They return **simulated data** and
are meant as integration points for real systems.

## Automatic build-failure analysis

When the TeamCity Slack app posts a failed build, Fenix pulls the build, its tests, its changes, and its log, then
replies in the notification's thread:

```text
Master_E2eFrontEnd | 42 min | agent-07 | View build

🔴 New failures (2):
  - invoices › creates an invoice with a delivery address   (3m 12s)
  👤 Likely cause:
      alice.example  a1b2c3d  IMPROVE: require a delivery address on invoices
      🏷️ touches delivery-address.service.ts, invoice.service.ts

♻️ Flaky tests (1):
  - customers › search paginates   (34% fail rate)

🟡 Pre-existing (1):
  - reports › exports PDF
```

How it gets there:

1. **Real error extraction.** It strips Cypress `before all` boilerplate, `(new)` markers, and Docker/corepack noise
   to find the actual error, then fingerprints it.
2. **Error origin.** It walks back through previous builds of the same configuration to find where that fingerprint
   first appeared, so a failure that started three builds ago isn't blamed on today's commits.
3. **Commit scoring.** Commits are ranked by how strongly their changed files match the failing tests and the error
   text, including German domain terms mapped to English code names (e.g. *Rechnung* to `invoice`, *Lieferadresse* to
   `delivery` and `address`). Merge commits are demoted.
4. **Historical correlation.** Files that changed in earlier builds where the same test failed add evidence.
5. **Classification.** Each failure is labelled new, pre-existing, flaky, or broken using the flaky-test history.

## Architecture

```mermaid
flowchart LR
    subgraph Slack
        U[People] -->|DM / @mention| B
        TC[TeamCity app] -->|failed build| B
        B[Bolt app<br/>Socket Mode]
    end

    B --> L{Listeners}
    L -->|DMs, mentions| A[Fenix agent<br/>Claude Agent SDK]
    L -->|TeamCity failures| N[Failure analyser]
    L -->|@Fenix delete| D[Thread cleanup]

    A --> M[(In-process MCP server<br/>fenix-tools)]
    M --> T1[TeamCity API]
    M --> T2[YouTrack API]
    M --> T3[GitLab API]
    M --> T4[Slack Web API]

    N --> T1
    N --> F[(data/flaky)]
    A --> S[(Session store<br/>thread → session)]
    A --> FB[(data/feedback.json)]
```

| Layer | Implementation |
|---|---|
| **Transport** | Bolt for JavaScript in Socket Mode; no public HTTP endpoint required. |
| **Agent** | `query()` from the Claude Agent SDK with a generated system prompt, `maxTurns: 15`, and a 120 s timeout. At most 3 agent runs execute concurrently, and one per thread. |
| **Tools** | Defined with `tool()` and Zod schemas, served by an in-process MCP server (`createSdkMcpServer`). Slack-bound tools are closures over the current channel and thread. |
| **Conversation state** | Only SDK session IDs are stored, keyed by `channel:thread_ts` (24 h TTL, 1,000 entries). Each mention or DM resumes its thread's session. |
| **Persistence** | JSON files under `data/`: feedback (last 500 entries) and per-configuration flaky-test history. |

## Configuration

Fenix keeps **secrets** in environment variables and **deployment-specific settings** in a git-ignored JSON file,
so the source stays generic.

### 1. Secrets (`.env`)

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | Anthropic API key. |
| `SLACK_BOT_TOKEN` | ✅ | Bot token (`xoxb-…`). |
| `SLACK_APP_TOKEN` | ✅ | App-level token (`xapp-…`) with `connections:write`, for Socket Mode. |
| `TEAMCITY_TOKEN` | For CI features | TeamCity access token. |
| `YOUTRACK_API_TOKEN` | For YouTrack features | YouTrack permanent token. |
| `GITLAB_TOKEN` | For codebase features | GitLab token with `read_api`. |
| `SLACK_USER_TOKEN` | Optional | User token (`xoxp-…`) so the ticket shortcut can read DM context. |
| `FENIX_CONFIG` | Optional | Path to the config file (default `fenix.config.json`). |

Every integration token can also be read from a dotfile in `$HOME` (`~/.teamcity_token`, `~/.youtrack_token`,
`~/.gitlab_token`, `~/.slack_user_token`) when the variable is not set.

### 2. Deployment settings (`fenix.config.json`)

```sh
cp fenix.config.example.json fenix.config.json
```

| Key | Description |
|---|---|
| `teamName` | Team Fenix serves, used in its system prompt. |
| `ownerIds` | Slack user IDs allowed to use Fenix. Everyone else gets a friendly "not ready yet" reply. |
| `ownerName` | Name shown in access and error messages. |
| `adminDmChannel` | DM channel where messages from non-owners are forwarded (optional). |
| `teamcity.url` / `teamcity.botId` | TeamCity base URL and the Slack bot ID of the TeamCity app, whose failure posts trigger the analysis. |
| `teamcity.keyConfigs` | Build configurations the agent should know by name: `[{ "id", "description" }]`. |
| `gitlab.url` / `gitlab.project` | GitLab base URL and project path (`group/repo`) for the codebase tools. |
| `youtrack.url` / `youtrack.project` | YouTrack base URL and default project key. |
| `contextFile` | Markdown appended to the system prompt (default `prompts/context.local.md`). |

Integrations that are not configured fail with a clear message instead of guessing a URL.

### 3. Team knowledge (`prompts/context.local.md`)

Anything the agent should know about your team that doesn't belong in source, such as codebase layout and naming
conventions, goes here. See [`prompts/context.example.md`](prompts/context.example.md).

### Slack app

[`manifest.json`](manifest.json) defines the app: Socket Mode, the App Home and Messages tabs, the agent view, the
*Create YouTrack Ticket* shortcut, and the bot events `app_mention`, `app_home_opened`, `message.channels`,
`message.groups`, and `message.im`. Create the app from it at [api.slack.com/apps](https://api.slack.com/apps)
(*From a manifest*), install it to your workspace, and invite Fenix to the channels where TeamCity posts.

## Getting started

```sh
git clone https://github.com/Yuri-Lima/fenix-slack-bot.git
cd fenix-slack-bot
npm install

cp .env.sample .env                              # add your tokens
cp fenix.config.example.json fenix.config.json   # add your owners and URLs

npm start
```

`Fenix is running!` in the log means the Socket Mode connection is up. Send Fenix a DM to try it.

## Deployment

Fenix is a single long-running Node.js process, which makes a small VPS with systemd a good fit.

```sh
cp .env.deploy.sample .env.deploy   # VPS host, port, SSH key, install path
npm run vps:deploy                  # rsync, npm ci --omit=dev, restart, status
```

| Script | Effect |
|---|---|
| `npm run vps:deploy` | Syncs the project (excluding `.env`, `.env.deploy`, `data/`, `node_modules/`), installs production dependencies, and restarts the service. |
| `npm run vps:status` / `vps:restart` / `vps:stop` | Manage the systemd service. |
| `npm run vps:logs` / `vps:logs:follow` | Last 50 log lines, or follow the journal. |

`fenix.config.json` and `prompts/context.local.md` are deployed with the code. `.env` stays on the server. Example
unit file:

```ini
# /etc/systemd/system/fenix-bot.service
[Unit]
Description=Fenix Slack Bot
After=network-online.target

[Service]
User=fenix-bot
WorkingDirectory=/opt/fenix-bot
EnvironmentFile=/opt/fenix-bot/.env
ExecStart=/usr/bin/node app.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## Security model

- **Owner allowlist.** Only `ownerIds` can use the agent. Others get one polite reply in DMs and mentions, and silence
  everywhere else.
- **Input guard.** Ready for when access opens beyond the owners: messages from non-owners that probe for
  credentials or infrastructure, or try prompt injection, get a warning. A second attempt blocks the user for
  24 hours.
- **Least-privilege agent.** Built-in file, shell, and web tools are disabled. The agent can call only the tools in the
  catalog above.
- **Write confirmation.** YouTrack issues are never created or changed without explicit approval in the thread.
- **Secret hygiene.** The system prompt forbids revealing tokens, infrastructure details, or its own instructions,
  and GitLab tools refuse sensitive paths.

## Project structure

```text
.
├── app.js                       # Bolt app (Socket Mode) entry point
├── config.js                    # Loads fenix.config.json
├── agent/
│   ├── casey.js                 # Agent runner, system prompt, Slack-bound tools
│   └── tools/                   # TeamCity, flaky tracker, YouTrack, GitLab, helpdesk tools
├── listeners/
│   ├── events/                  # DMs, mentions, @Fenix delete, TeamCity failure analysis
│   ├── actions/                 # Feedback and issue buttons
│   ├── shortcuts/               # Create YouTrack Ticket
│   └── views/                   # App Home and modals
├── thread-context/              # Thread → agent session store
├── utils/                       # Input guard, stores, token readers
├── prompts/                     # Team context for the system prompt
├── scripts/vps.sh               # VPS management
├── tests/                       # node:test suites mirroring the source tree
└── manifest.json                # Slack app manifest
```

## Development

```sh
npm test           # node:test, against tests/fixtures/fenix.config.json
npm run lint       # Biome lint and format check
npm run lint:fix   # Apply Biome fixes
npm run check      # Type-check JavaScript with tsc (checkJs)
```

- Tests use only `node:test` and `node:assert`. Slack clients are plain `mock.fn()` objects.
- Never hardcode company URLs, Slack IDs, or names. Add them to `fenix.config.json` and read them through `config.js`.
- New agent tools go in `agent/tools/`, are exported from `agent/tools/index.js`, and return MCP `CallToolResult`
  objects (`{ content: [{ type: 'text', text }] }`).

See [AGENTS.md](AGENTS.md) for conventions aimed at coding agents.

## License

[MIT](LICENSE) © Yuri Lima
