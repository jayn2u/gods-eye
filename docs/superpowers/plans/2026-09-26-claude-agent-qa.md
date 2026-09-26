# Claude Agent QA (PR ②) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second, independent Agent QA agent — Claude, run through `anthropics/claude-code-base-action` — on the shared, agent-agnostic harness that PR ① (#80) delivered, opted in only by the `claude-agent-qa` label.

**Architecture:** A `claude` Agent Profile joins the registry. `prepare` writes Claude-specific inputs (prompt file, strict MCP config pointing at the same Playwright MCP + trusted Browser Journal, deny-by-default settings, result JSON schema) into the private run directory. The Claude step is the pinned GitHub Action, using the runner's pinned Claude Code and Bun binaries, a run-scoped `HOME`, `--strict-mcp-config`, only the Playwright browser tools, and `--model opus`. A new `execute.cjs record-agent` step turns the action's `execution_file` into the same `agent-outcome.json` + private agent result that `finalize` already consumes, so the report, comment, artifact, and evidence branch paths are reused unchanged. A per-agent doctor checks only the running agent's binaries.

**Tech Stack:** Node 24 CommonJS, `node:test`, Ajv, GitHub Actions, `anthropics/claude-code-base-action` (pinned SHA), Claude Code 2.1.283, Bun 1.3.14, Playwright MCP 0.0.80.

**Spec:** `docs/adr/0004-label-opt-in-agent-qa-per-agent.md`; operator contract `docs/setup/agent-qa.md`; PR ① plan `docs/superpowers/plans/2026-09-25-copilot-agent-qa-label-opt-in.md` (interfaces it produced).

## Global Constraints

- Branch `claude/claude-agent-qa`, one PR into `develop`; commits end with `Co-authored-by: Codex <noreply@openai.com>` and `Co-authored-by: Claude Opus 5.5 <noreply@anthropic.com>`. Code is written by Codex (`codex exec -m gpt-6-luna`, effort max, `-s workspace-write`); Claude runs tests outside the sandbox, commits, and reviews.
- Claude profile values, verbatim: agent `claude`; label `claude-agent-qa`; workflow `claude-agent-qa.yml`, name `Claude Agent QA`; report workflow `claude-agent-qa-report.yml`, name `Claude Agent QA Report`; marker `<!-- gods-eye-claude-agent-qa:v1 -->`; title `Claude Agent QA (advisory)`; artifact prefix `claude-agent-qa`; evidence branch `claude-agent-qa-evidence`. (All produced by `define('claude', 'Claude')` in `agents/profiles.cjs`.)
- Action pin: `anthropics/claude-code-base-action@7456abb892dcd39cd63025550e1726fe65b7c5d2` (main, 2026-09-25; the repo's tags stopped at v0.0.63 in 2025). Comment the pin like the other actions.
- Toolchain pins (in `.github/agent-qa/package.json` devDependencies + `package-lock.json` with integrity): `@anthropic-ai/claude-code` `2.1.283` (platform package `@anthropic-ai/claude-code-linux-x64` integrity `sha512-q9+Ke42t/I6oLb/bTmh6sI24jMw4KNwz3QbQLp9dVQ8ipQChfAW5L11SX8jcDzVCW/P2tId7ftI+lgBURvz9uQ==`) and `bun` `1.3.14` (platform package `@oven/bun-linux-x64` integrity `sha512-7OVTAKvwfPmSbIV1HpdOoVVx5VRc427GuPPne93N6vk4eQBPId9nXmZDh9/zGaKPdbVjVtQSZafWQoUjx38Utw==`). `setup-runner.sh` installs with `npm ci --ignore-scripts`, so the postinstall shims never run: the executables are `toolchain/node_modules/@anthropic-ai/claude-code-linux-x64/claude` and `toolchain/node_modules/@oven/bun-linux-x64/bin/bun`.
- Credential: repository secret `CLAUDE_CODE_OAUTH_TOKEN` (already registered). It appears only in the token-check step and the action step; never `GITHUB_TOKEN`/`GH_TOKEN` (blank everywhere in the QA job), never `ANTHROPIC_API_KEY`.
- Model: `--model opus` (alias, per ADR 0004); the report records the model the run resolved (from the execution log's init message).
- Claude runs with: run-scoped `HOME` (`<private_root>/agent-home`), `CLAUDE_WORKING_DIR` = `<private_root>/work` (empty, outside the candidate), `--strict-mcp-config --mcp-config <private>/claude/mcp-config.json`, `--allowedTools` = exactly the 14 `mcp__playwright__<tool>` names from `scenarios.json` `browser.allowed_tools`, `--disallowedTools Bash,Read,Write,Edit,MultiEdit,NotebookEdit,Glob,Grep,LS,WebFetch,WebSearch,Task,TodoWrite`, `--json-schema <private>/claude/result.schema.json`, settings file `<private>/claude/settings.json` with the same allow/deny lists, `show_full_output: false`.
- The action's composite runs `actions/setup-node` with `env.NODE_VERSION || '18.x'`; the Claude action step must set `NODE_VERSION: 24.12.0` so later steps keep the pinned Node.
- Both agents share the runner, the global queue `gods-eye-agent-qa-global`, the scenarios, prompt, Browser Journal, runtime, baseline, report contract, and finalize. Copilot behaviour must not change.
- Label events for one agent must not cancel the other agent's in-progress run: a `labeled`/`unlabeled` event whose label is not the workflow's own QA Label gets a unique concurrency group and its admission job is skipped.
- Doctor checks only the running agent's binaries, so Copilot keeps working before the runner operator reinstalls the toolchain.
- Operator step after merge (runner host, not this machine): `bash .github/agent-qa/setup-runner.sh install` then `bash .github/agent-qa/setup-runner.sh start`.
- Tests: `node --test --test-timeout=180000 test/*.test.cjs` in `.github/agent-qa` must equal the environment baseline (22 doctor/setup-runner failures on this machine); `uv run --extra indexing pytest -q` green.

## File Structure

| File | Responsibility |
|---|---|
| `.github/agent-qa/agents/profiles.cjs` | add `claude` profile |
| `.github/agent-qa/request.schema.json`, `report.schema.json` | `agent` enum `copilot`, `claude` |
| `.github/agent-qa/agents/mcp.cjs` (new) | shared Playwright MCP server definition (command, args, env, tools) |
| `.github/agent-qa/agents/copilot.cjs` | use `agents/mcp.cjs` |
| `.github/agent-qa/agents/claude.cjs` (new) | write Claude inputs; convert an action execution log into an agent outcome + private result |
| `.github/agent-qa/doctor.cjs` | per-agent binary/version checks; claude/bun pins |
| `.github/agent-qa/execute.cjs` | prepare writes Claude inputs; `record-agent` subcommand; agent-neutral outcome paths; model recording; redaction of Anthropic tokens |
| `.github/agent-qa/package.json`, `package-lock.json`, `setup-runner.sh` | pinned toolchain; unit env `QA_CLAUDE_BIN`, `QA_BUN_BIN`; unset `CLAUDE_CODE_OAUTH_TOKEN` |
| `.github/workflows/claude-agent-qa.yml`, `claude-agent-qa-report.yml` (new); `copilot-agent-qa.yml` | Claude job; cross-label concurrency guard in both QA workflows |
| `docs/setup/agent-qa.md` | Claude section, operator reinstall, secret, label cleanup |

---

### Task 1: Claude profile, schema enums, and redaction

**Files:** `agents/profiles.cjs`, `request.schema.json`, `report.schema.json`, `execute.cjs` (`sanitizeText` ~204), tests `profiles.test.cjs`, `contracts.test.cjs`, `execute.test.cjs`.

- [ ] Add `claude: define('claude', 'Claude')` to `PROFILES`; `AGENTS` becomes `['copilot', 'claude']`.
- [ ] Enums: `request.schema.json` `properties.agent.enum` and `report.schema.json` `tools.agent.name.enum` = `["copilot", "claude"]` (the existing guard tests keep them equal to `AGENTS`).
- [ ] `sanitizeText`: also redact `sk-ant-[A-Za-z0-9_-]{6,}` and `CLAUDE_CODE_OAUTH_TOKEN\s*[:=]\s*[^\s,;]+` and `ANTHROPIC_API_KEY\s*[:=]…`.
- [ ] Tests: profile values for claude verbatim (list above); `profileForWorkflowPath('.github/workflows/claude-agent-qa.yml').agent === 'claude'`; the existing contracts `agent_mismatch` test now reaches its branch (report `claude`, request `copilot` → code `agent_mismatch`, asserted by code); redaction of `sk-ant-oat01-abcdef…` and `CLAUDE_CODE_OAUTH_TOKEN=x`.
- [ ] Commit `feat(agent-qa): declare the Claude Agent Profile`.

### Task 2: Shared MCP server definition and the Claude adapter

**Files:** create `agents/mcp.cjs`, `agents/claude.cjs`, `test/claude.test.cjs`; modify `agents/copilot.cjs`, `test/execute.test.cjs` if it imports copilot internals.

**Interfaces (produced):**
- `mcp.cjs`: `MCP_SERVER = 'playwright'`; `playwrightServer({ mcpBin, origin, screenshotsRoot, initPage, journal, browsers })` → `{ command, args, env }` with the exact args copilot uses today (`--browser chromium --headless --isolated --block-service-workers --codegen none --viewport-size 1440x1000 --allowed-origins <origin> --output-dir <screenshotsRoot> --init-page <initPage>`) and `env: { QA_BROWSER_JOURNAL: journal, PLAYWRIGHT_BROWSERS_PATH: browsers }`; `browserToolNames()` → the 14 names from `scenarios.json`.
- `copilot.cjs` `mcpConfig` builds its entry from `playwrightServer` (Copilot keeps `type: 'local'` and its `tools` array); behaviour and existing tests unchanged.
- `claude.cjs`:
  - `CLAUDE_DENIED_TOOLS` (the list in Global Constraints) and `claudeAllowedTools()` → `browserToolNames().map((t) => \`mcp__playwright__${t}\`)`.
  - `async writeClaudeInputs({ claudeDir, server, resultSchema })` writes 0600 files in a 0700 `claudeDir`: `mcp-config.json` = `{ mcpServers: { playwright: { type: 'stdio', command, args, env } } }`; `settings.json` = `{ permissions: { allow: claudeAllowedTools(), deny: CLAUDE_DENIED_TOOLS }, enableAllProjectMcpServers: false }`; `result.schema.json` = the agent-result schema (resolved, no external `$ref`) → returns `{ mcpConfigPath, settingsPath, schemaPath }`. Refuses if `claudeDir` already contains `.mcp.json`.
  - `claudeArgs({ mcpConfigPath, schemaPath })` → the single `claude_args` string: `--model opus --strict-mcp-config --mcp-config <p> --allowedTools <comma list> --disallowedTools <comma list> --json-schema <p>` (paths quoted if they contain spaces; they do not in practice).
  - `readExecutionLog(file)` → array of SDK messages (bounded 50 MiB; JSON array or JSON lines).
  - `claudeOutcome({ messages, conclusion, stepOutcome, tokenReady })` → `{ process_error, model, result }`:
    - `tokenReady === false` → `AUTH_REQUIRED`.
    - no messages and `stepOutcome` in `cancelled|failure` (step timeout/cancel) → `CANCELLED`.
    - no messages otherwise → `AGENT_NO_OUTPUT`.
    - result message `api_error_status` 401/403, or error text matching auth/unauthorized/invalid token → `AUTH_REQUIRED`; 429 or rate/usage limit → `RATE_LIMITED` (message contains `rate limit` so `mapFailure` classifies it); subtype `error_max_turns` → `MAX_TURNS`; other `is_error`/error subtypes → `AGENT_FAILED` with sanitized `errors`.
    - `model` from the first `{ type: 'system', subtype: 'init' }` message's `model`, if it matches the report `version` pattern.
    - `result` = the result message's `structured_output` object if present, else JSON extracted from its `result` string with the same fence/brace logic as `copilot.cjs` `extractAgentResult` (move that helper into `mcp.cjs` or a small shared module and reuse it).
- [ ] Tests with inline fixture logs: success with `structured_output`; success with fenced JSON in `result`; 401; 429; max turns; empty log + stepOutcome `cancelled`; token missing; init model captured; config files mode 0600 and exact allow/deny lists; copilot `mcpConfig` output unchanged (snapshot vs today's shape).
- [ ] Commit `feat(agent-qa): add the Claude adapter on a shared Playwright MCP definition`.

### Task 3: Per-agent doctor, pinned Claude Code and Bun, runner unit

**Files:** `doctor.cjs`, `package.json`, `package-lock.json`, `setup-runner.sh`, tests `doctor.test.cjs`, `setup-runner.test.cjs`.

- [ ] `EXPECTED` gains `claude: '2.1.283'`, `bun: '1.3.14'`.
- [ ] `runDoctor({ env, phase, agent })`: `agent` defaults to `'copilot'` (keeps CLI and existing tests); `bins` adds `claude: env.QA_CLAUDE_BIN || toolchain/node_modules/@anthropic-ai/claude-code-linux-x64/claude`, `bun: env.QA_BUN_BIN || toolchain/node_modules/@oven/bun-linux-x64/bin/bun`. Version commands and the `pinned` list depend on the agent: copilot → `copilot`, `playwright_mcp`; claude → `claude`, `bun`, `playwright_mcp` (`claude --version` prints `2.1.283 (Claude Code)`; `bun --version` prints `1.3.14`; `versionFrom` must extract both). `tool_versions` detail records `agent`.
- [ ] `subscription_auth` in `prepare` phase is unchanged (no token needed); in `status` phase the token env is `QA_COPILOT_TOKEN` for copilot and `QA_CLAUDE_TOKEN` for claude.
- [ ] `package.json` devDependencies add `"@anthropic-ai/claude-code": "2.1.283"` and `"bun": "1.3.14"`; regenerate `package-lock.json` (controller runs `npm install --package-lock-only --prefix .github/agent-qa` outside the sandbox if the implementer cannot) and confirm both platform integrities equal the Global Constraints values.
- [ ] `setup-runner.sh` unit: add `Environment="QA_CLAUDE_BIN=${escaped_root}/toolchain/node_modules/@anthropic-ai/claude-code-linux-x64/claude"` and `Environment="QA_BUN_BIN=${escaped_root}/toolchain/node_modules/@oven/bun-linux-x64/bin/bun"`; `UnsetEnvironment` adds `CLAUDE_CODE_OAUTH_TOKEN`; help text mentions the `CLAUDE_CODE_OAUTH_TOKEN` secret; refuse `QA_ROOT == $HOME/.claude` like the `.copilot` guard.
- [ ] Tests: claude doctor passes with fake claude/bun bins printing the pinned versions and fails on drift; copilot doctor ignores missing claude/bun; unit text contains the new lines (existing unit tests are environment-failing on this machine — assert via the pure unit-rendering function if one exists, otherwise extend the existing tests and note they run on the runner).
- [ ] Commit `feat(agent-qa): pin Claude Code and Bun and check only the running agent's tools`.

### Task 4: execute.cjs — Claude inputs in prepare, `record-agent`, model recording

**Files:** `execute.cjs`, `test/execute.test.cjs`.

- [ ] `prepare`: call `runDoctor({ env, phase: 'prepare', agent: request.agent })`; `toolsFromDoctor` reads the agent's version (`versions[request.agent]`). When `request.agent === 'claude'`, after writing the prompt, call `writeClaudeInputs({ claudeDir: <private_root>/claude, server: playwrightServer({...same paths runAgentStep builds for copilot...}), resultSchema })` and create `agent_home` (0700). Record `state.agent_paths.claude = { mcp_config, settings, schema }`. The prepare stdout JSON line adds `"claude_args": claudeArgs(...)` only for claude, plus `"prompt"` (prompt path), `"agent_home"`, `"work_dir"` — so the workflow can pass them through step outputs.
- [ ] `runAgentStep`: outcome log paths become agent-neutral (`<private_root>/agent-supervisor/logs/<agent>.stdout.log`, config path from the agent); for `claude` it records `process_error: { code: 'UNKNOWN_AGENT' }` as today (Claude never runs through it).
- [ ] New CLI `record-agent --state <abs> --execution-file <abs|''> --conclusion <success|failure|''> --step-outcome <success|failure|cancelled|skipped|''> [--token-missing]` → `recordAgentOutcome(...)`: reads the log with `readExecutionLog` (missing/empty path allowed), builds `claudeOutcome`, writes the private result (0600) when `result` exists, and writes `agent-outcome.json` with `process_error`, `journal_path`, `private_result`, `model`, `stdout_path: null`, `stderr_path: null`, `config_path: <mcp-config path>`, and `phases: [{ name: 'agent', seconds: <from execution log duration_ms or 0> }]`. Only paths inside `private_root` are written or referenced (reuse `privateChildPath`). `--execution-file` may live outside `private_root` (the action writes it under `RUNNER_TEMP`); it is only read, never deleted.
- [ ] `finalize`: when the outcome has `model`, set `tools.agent.model`; map `MAX_TURNS`/`AGENT_FAILED`/`AGENT_NO_OUTPUT` to `invalid_output` and `RATE_LIMITED` to `rate_limited` (check `REPORT_REASONS`).
- [ ] Tests: prepare for a claude request writes the three files, prints `claude_args` containing `--model opus --strict-mcp-config` and all 14 `mcp__playwright__` tools; `record-agent` with a success log + a journal proving all scenarios (reuse the existing fake journal builder) → finalize `no_findings` with `tools.agent = { name: 'claude', version: '2.1.283', model: <init model> }`; token-missing → `auth_required`; stepOutcome cancelled with no log and no `--cancelled` finalize → `timeout`; 401 log → `auth_required`; CLI parsing and relative-path rejection for `record-agent`.
- [ ] Commit `feat(agent-qa): prepare Claude inputs and record the Claude action's outcome`.

### Task 5: Workflows

**Files:** create `.github/workflows/claude-agent-qa.yml`, `.github/workflows/claude-agent-qa-report.yml`; modify `.github/workflows/copilot-agent-qa.yml`, `test/workflows.test.cjs`.

- [ ] `claude-agent-qa.yml` = `copilot-agent-qa.yml` with: `name: Claude Agent QA`; `run-name: "Claude Agent QA PR #${{ github.event.pull_request.number }} head ${{ github.event.pull_request.head.sha }}"`; per-PR group base `gods-eye-claude-agent-qa-pr-`; admission `agent: 'claude'`; same trusted checkouts, candidate verification, recheck, prepare (unchanged env, blank tokens), stage/summary/upload (artifact `claude-agent-qa-<pr>-<run>-<attempt>`), global queue `gods-eye-agent-qa-global`, runner labels, 30-min job limit. The agent part is three steps:
  1. `token` (id `token`): `if: steps.prepare.outputs.state != ''`; env `CLAUDE_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`, `GITHUB_TOKEN: ""`, `GH_TOKEN: ""`; run: a `node -e` that prints `ready=true|false` to `$GITHUB_OUTPUT` using `agentTokenReadiness` from the trusted `doctor.cjs` (no token echo).
  2. `agent`: `if: steps.token.outputs.ready == 'true'`; `timeout-minutes: 25`; `uses: anthropics/claude-code-base-action@7456abb892dcd39cd63025550e1726fe65b7c5d2` (comment `# anthropics/claude-code-base-action main 2026-09-25`); `env: HOME: <agent_home from prepare output>, CLAUDE_WORKING_DIR: <work_dir output>, NODE_VERSION: 24.12.0, GITHUB_TOKEN: "", GH_TOKEN: "", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", CODEX_API_KEY: "", GOOGLE_API_KEY: ""`; `with: prompt_file, claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}, path_to_claude_code_executable: <QA_ROOT>/toolchain/node_modules/@anthropic-ai/claude-code-linux-x64/claude, path_to_bun_executable: <QA_ROOT>/toolchain/node_modules/@oven/bun-linux-x64/bin/bun, settings: <settings path>, claude_args: ${{ steps.prepare.outputs.claude_args }}, show_full_output: 'false'`. `QA_ROOT` comes from `steps.paths.outputs.qa_root`.
  3. `record` (id `record`): `if: always() && steps.prepare.outputs.state != ''`; env `STATE_PATH`, `EXECUTION_FILE: ${{ steps.agent.outputs.execution_file }}`, `CONCLUSION: ${{ steps.agent.outputs.conclusion }}`, `AGENT_OUTCOME: ${{ steps.agent.outcome }}`, `TOKEN_READY: ${{ steps.token.outputs.ready }}`, blank tokens; run: `execute.cjs record-agent` with those (adds `--token-missing` when `TOKEN_READY != true`).
  Then `finalize` exactly as Copilot's.
  The `prepare` step must also emit `claude_args`, `prompt`, `agent_home`, `work_dir` outputs from the prepare JSON (same capture-status pattern already used for `state`).
- [ ] `claude-agent-qa-report.yml` = the copilot report workflow with `name: Claude Agent QA Report`, `workflows: [Claude Agent QA]`, correlate `profileForWorkflowPath(run?.path)?.agent === 'claude'`, report group `gods-eye-claude-agent-qa-report-pr-…`.
- [ ] Cross-label guard in BOTH QA workflows: top-level `concurrency.group` becomes `gods-eye-<agent>-agent-qa-pr-${{ github.event.pull_request.number }}${{ (contains(fromJSON('["labeled","unlabeled"]'), github.event.action) && github.event.label.name != '<agent>-agent-qa') && format('-ignored-{0}', github.run_id) || '' }}` and the `admission` job gets `if: ${{ !(contains(fromJSON('["labeled","unlabeled"]'), github.event.action) && github.event.label.name != '<agent>-agent-qa') }}`. (Own-label add/remove and every non-label event keep today's supersede behaviour.)
- [ ] `workflows.test.cjs`: parameterize the existing Copilot policy assertions over both agents where they apply; Claude-specific assertions: action pinned to the exact SHA; `CLAUDE_CODE_OAUTH_TOKEN` referenced only in the `token` env and the action `with.claude_code_oauth_token`; the action step env blanks `GITHUB_TOKEN`/`GH_TOKEN`/`ANTHROPIC_API_KEY`, sets `NODE_VERSION: 24.12.0`, `HOME` and `CLAUDE_WORKING_DIR` from prepare outputs; `show_full_output` is `'false'`; `timeout-minutes: 25`; `record` and `finalize` run under `always()`; no `run:` interpolates `${{ steps.* }}`; report workflow correlates only `claude`; concurrency/`if` guard strings for both workflows; an event fixture where `claude-agent-qa` is added does not admit Copilot and vice versa (use the controller with the real profile).
- [ ] Commit `feat(agent-qa): run Claude Agent QA through the pinned Claude Code action`.

### Task 6: Documentation

**Files:** `docs/setup/agent-qa.md`, `docs/adr/0004-label-opt-in-agent-qa-per-agent.md` (status note only if needed).

- [ ] Guide: Agent QA now has two agents; eligibility lists both labels, both can be applied (independent runs, shared queue, other-label events never cancel a run); remove every mention of the deleted `agent-qa` label except one migration sentence ("the former `agent-qa` label was removed"); Claude section: action pin, pinned Claude Code/Bun and why not the action's installer, run-scoped HOME, strict MCP config, allowed/denied tools, `--model opus` alias exception, `CLAUDE_CODE_OAUTH_TOKEN` secret (created with `claude setup-token`, stored with `gh secret set CLAUDE_CODE_OAUTH_TOKEN`), `auth_required` recovery, `rate_limited`; operator reinstall after this change (`setup-runner.sh install` + `start`) and that until then Claude runs report `setup_failed` while Copilot is unaffected; comment/artifact/branch names for Claude.
- [ ] Commit `docs(agent-qa): add the Claude agent to the operator guide`.

### Task 7: Verification, PR, operator step, live validation

- [ ] Full helper suite equals the environment baseline; pytest green.
- [ ] Final whole-branch review (opus); fix wave; re-review.
- [ ] Push, open PR, CI green, merge (user authorized merging in this session for Agent QA work).
- [ ] Ask the user to run the operator reinstall on the runner host; confirm with the next run's doctor.
- [ ] Live: disposable PR with an empty commit and label `claude-agent-qa` → expect admission `admitted`, Claude steps succeed, report `no_findings` (or a named incomplete reason), comment marker/title, screenshots on `claude-agent-qa-evidence`, `tools.agent.model` recorded. Then add `copilot-agent-qa` to the same PR while Claude is queued/running and confirm neither run is cancelled by the other's label event. Close the PR.
