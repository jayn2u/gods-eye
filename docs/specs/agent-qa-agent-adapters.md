# Agent QA browser-agent adapter specification

## Outcome

Agent QA can drive its bounded fixture scenarios with a second browser agent — the Claude Code CLI
— without weakening any evidence rule that decides a report outcome. The agent becomes a replaceable
adapter; the verifier that turns a tool-call stream into accepted proof stays byte-identical.

The immediate motivation is operational: the Codex subscription quota is exhausted, so the only
live agent is unavailable. The durable motivation is that a single-vendor CLI is a single point of
failure for a check that already fails closed on `auth_required`.

## Why an adapter and not a replacement

The existing verifier is the security boundary. `parseCodexEvents` accepts a scenario only when the
event stream shows, in order: the exact `browser_evaluate` profile marker, every declared observable
action with matching arguments, the exact receipt call returning its `qa-receipt:<id>` token, and a
screenshot at the declared path — with no foreign origin, no shell execution, and no file change
anywhere in the stream. That logic must not be rewritten to accommodate a second event dialect.

Therefore the adapter translates a vendor stream **into** the format the verifier already consumes,
and the verifier is not modified. The Codex JSONL shape becomes the trusted internal event format by
construction. The Codex path keeps feeding it directly; the Claude Code path passes through a pure
translation function first.

The alternative — a new neutral event vocabulary plus a rewritten verifier — is rejected for now.
It would require re-deriving the confidence that the current 148-test suite provides, for no gain
beyond naming.

## Existing seam

`runExecution(options, adapters)` already accepts `adapters.runCodex`, and the suite exercises the
whole pipeline through an injected agent. The adapter contract is unchanged:

```
runAgent({ runtime, paths, prompt, environment, deadline })
  → { processError?, eventsPath, stderrPath, privateResult }
```

`eventsPath` must be JSONL. `privateResult`, when present, must be a JSON document that
`validateAgentResult` accepts. Both are deleted in the `finally` block before any upload.

## Agent selection

A runner-level `QA_AGENT` environment variable selects the adapter, with `codex` as the default so
an unset runner keeps its current behaviour. `execute.cjs` validates it against an exact allowlist
(`codex`, `claude-code`) and fails closed with `setup_failed` on any other value. The workflow
passes it through from the runner unit; it is never read from candidate source, pull-request text,
or page content.

`doctor.cjs` validates prerequisites for the selected agent only. A runner prepared for one agent
must not report ready for the other.

## Claude Code invocation

Pinned CLI: `@anthropic-ai/claude-code` at an exact version recorded alongside the existing Codex
and Playwright MCP pins, installed into `$QA_ROOT/toolchain` by `setup-runner.sh`. Verified against
`claude --version` (observed `2.1.263`).

```
claude --print
       --output-format stream-json --verbose
       --strict-mcp-config --mcp-config <run-scoped playwright.json>
       --allowedTools mcp__playwright__browser_navigate … (the 14 declared tools)
       --disallowedTools <every built-in the probe reports, enumerated explicitly>
       --permission-mode dontAsk
       --no-session-persistence
       --session-id <run-scoped uuid>
       --settings <run-scoped settings.json with empty hooks>
       --model <pinned model id>
       <prompt>
```

Invariants:

- The MCP server definition carries the same Playwright arguments the Codex path uses, including
  `--allowed-origins <loopback origin>`, `--headless`, `--isolated`, `--block-service-workers`,
  `--output-dir <screenshots root>`, and `--init-page browser-init.ts`. The browser containment is
  provided by the MCP server and is therefore agent-independent.
- `--strict-mcp-config` is mandatory: without it, developer and project MCP configuration would
  load on a runner that shares its Linux user with development.
- `CLAUDE_CONFIG_DIR` points at `$QA_ROOT/claude-home`, mode `0700`, distinct from the developer
  configuration directory. `sanitizedChildEnvironment` supplies it the same way it supplies
  `CODEX_HOME`, and the auth lock is taken for the same reason.
- `--settings` must declare an empty hook set. A probe of an unconfigured invocation emitted
  `system/hook_started` and `system/hook_response` events from ambient user configuration; a QA run
  must not execute host hooks.
- This CLI version exposes no `--max-turns`. Bounding stays with the existing supervisor: the
  process runs under `runToDeadline` inside the 12-minute internal deadline and is killed by process
  group on expiry. The translator additionally caps events and tool calls as the verifier already
  does.

## Event translation

`translateClaudeCodeEvents(lines) → codexShapedEvents` is a pure function in a new
`agents/claude-code.cjs`. It takes parsed JSONL objects and returns the array the verifier expects.

| Claude Code event | Translated to | Notes |
|---|---|---|
| `system` / `init` | consumed as a precondition, not emitted | see in-band assertions |
| `assistant` with `content[].type === 'tool_use'`, name `mcp__playwright__<tool>` | buffered, pending its result | `server: 'playwright'`, `tool: <tool>`, `arguments: input` |
| `assistant` with any other `tool_use` name | `item.completed` with `item.type: 'command_execution'` | reuses the verifier's existing forbidden-action rule |
| `user` with `content[].type === 'tool_result'` | completes the buffered call, emits `item.completed` with `item.type: 'mcp_tool_call'` | correlated by `tool_use_id`; `status: is_error ? 'failed' : 'completed'`; `result.content` carried through unchanged |
| `result` with `is_error: false` and `stop_reason: 'end_turn'` | `turn.completed` with mapped usage | `input_tokens` → `input_tokens`, `cache_read_input_tokens` → `cached_input_tokens`, `output_tokens` → `output_tokens` |
| `result` with `is_error: true`, any other `stop_reason`, or a non-null `api_error_status` | `turn.failed` carrying the message | feeds the existing `mapFailure` classification |
| `rate_limit_event` indicating exhaustion | `turn.failed` with a rate-limit message | yields `incomplete/rate_limited` structurally rather than by regex |
| `system` / `hook_started`, `hook_response`, `post_turn_summary`; `assistant` text blocks | ignored | an unknown `type` is ignored; an unknown `content[].type` inside a tool call is not |

Failure modes the translator must reject by emitting a forbidden-action event (so the verifier marks
the run invalid), rather than by silently dropping:

- A `tool_use` whose name does not parse as `mcp__playwright__<known tool>`.
- More than one `tool_use` block in a single assistant message. The scenario contract is strictly
  sequential — marker, then ordered actions, then receipt, then screenshot. Permitting parallel
  calls would make the emitted order ambiguous relative to the buffered order, so a parallel batch
  is refused outright instead of being linearised.
- A `tool_result` with no matching buffered `tool_use`, a duplicate `tool_use_id`, or a buffered
  `tool_use` still unresolved when the stream ends.
- A `tool_result` whose content is not an array of `{type, text}` blocks.

Ordering rule: events are emitted in `tool_use` order. With the parallel-batch refusal above, that
is the same as result order, so the verifier's action-sequence checks keep their meaning.

## Result delivery without a write tool

Codex constrains its final document with `--output-schema` and writes it via
`--output-last-message`. Claude Code offers neither, and granting a write tool to obtain a result
file would reintroduce the file-mutation surface the whitelist removes.

Instead the final document travels in the `result` event's `result` field, and **trusted code** —
not the agent — writes it to `paths.privateResult`:

1. Read `result.result` as text, bounded to the existing JSON limit.
2. Strip at most one surrounding ```json fence. Reject any other surrounding prose.
3. `JSON.parse`, then hand the value to the unchanged `validateAgentResult`.
4. On any failure, write nothing. The existing `!agentResult || !parsed.complete` branch then yields
   `incomplete/invalid_output`.

This is weaker than `--output-schema` in exactly one respect: the schema is enforced after
generation rather than during it. It is not weaker in what reaches a report, because the same Ajv
validator gates the same fields, and because scenario status and findings are still discarded unless
`parseCodexEvents` independently proves the browser evidence.

## Containment substitutes for `--sandbox read-only`

Claude Code has no read-only OS sandbox flag. Four layers replace it, and the design must not ship
without all four:

1. **No dangerous tool is reachable.** `--allowedTools` lists only the 14 Playwright MCP tools and
   `--disallowedTools` names the built-ins. This must be treated as necessary but **not** sufficient:
   a probe that disallowed `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebFetch`, `WebSearch`,
   and `Task` still reported a residual tool set in its `init` event (`NotebookEdit`, `Skill`,
   `ToolSearch`, and others supplied by the host build). The flag list cannot be assumed to be
   exhaustive across CLI versions, so the assertion in layer 2 is load-bearing rather than
   belt-and-braces, and the disallowed list must be derived from what a probe on the pinned version
   actually reports.
2. **In-band capability assertion.** The `system/init` event enumerates `tools`, `mcp_servers`,
   `permissionMode`, `model`, `apiKeySource`, and `claude_code_version`. Observed shapes:
   `mcp_servers` is `[{ name, status }]`, and a subscription session reports
   `apiKeySource: "none"`. The adapter aborts before the first scenario unless `mcp_servers` is
   exactly `playwright` with `status: "connected"`, the advertised `tools` are a subset of the
   whitelist, `apiKeySource` is `"none"`, and `claude_code_version` equals the pin. This runs per
   run and catches a tool the flags failed to remove — which the probe shows is a real case, not a
   hypothetical one.
3. **Denial assertion.** `result.permission_denials` must be empty. A non-empty array means the
   agent attempted something outside the whitelist and is treated as an invalid run, not a product
   finding.
4. **Unchanged outer layers.** `sanitizedChildEnvironment`, the process-group supervisor and its
   cleanup receipt, the tracked-file snapshot diff that yields `source_changed`, the loopback-only
   origin, and the evidence contracts all apply identically.

Honest limitation: layers 1–3 are enforced by the CLI's permission layer and its own event
reporting, whereas Codex's `--sandbox read-only` is enforced below the agent. Layer 4 is what makes
the difference tolerable — a write that slipped through would still surface as `source_changed` and
suppress the report.

## Report and schema changes

`report.schema.json` currently requires `tools.codex`. It must instead require an agent identity so
a report states which agent produced it:

```
"tools": { "node", "playwright_mcp", "chromium", "agent": { "name": "codex" | "claude-code", "version": … }, "model"? }
```

`toolsFromDoctor` populates it from the selected agent's version check. `doctorReason` keeps mapping
a failed auth check to `auth_required` and a failed browser check to `browser_unavailable`;
`setup_failed` remains the fallback. No new report status or reason is introduced — an agent swap
must not add a new way for a report to be inconclusive.

## Files

| Path | Change |
|---|---|
| `.github/agent-qa/agents/claude-code.cjs` | new: `translateClaudeCodeEvents`, `assertInitPreconditions`, `extractAgentResult`, `claudeCodeArguments` |
| `.github/agent-qa/execute.cjs` | select the adapter from `QA_AGENT`; translate before `parseCodexEvents`; write the extracted result document |
| `.github/agent-qa/doctor.cjs` | `EXPECTED.claude`; `claude-home` ownership and mode; agent-scoped checks |
| `.github/agent-qa/setup-runner.sh` | install and pin the CLI; unit environment for `CLAUDE_CONFIG_DIR` |
| `.github/agent-qa/package.json`, `package-lock.json` | pinned dev dependency with an integrity hash |
| `.github/agent-qa/report.schema.json` | `tools.agent` |
| `.github/workflows/agent-qa.yml` | pass `QA_AGENT`; clear `ANTHROPIC_API_KEY` as it already does |
| `docs/setup/agent-qa.md` | agent selection, second login lifecycle, new pins |
| tests | translator fixtures and adversarial cases |

`prompt.md`, `scenarios.json`, `browser-init.ts`, `baseline.config.ts`, `contracts.cjs`,
`evidence-contracts.cjs`, `controller.cjs`, and `reporter.cjs` are untouched. That list is the point
of the design: the scenario contract and the evidence rules are agent-independent.

## Test plan

The translator is a pure function, so the whole design is testable with zero agent quota.

- Recorded-fixture tests: a captured Claude Code stream for a passing run translates into events the
  unmodified `parseCodexEvents` accepts as `complete`.
- Adversarial fixtures, each asserting the run is refused: a non-MCP `tool_use`; a foreign MCP
  server; two `tool_use` blocks in one message; an unpaired `tool_result`; a duplicate
  `tool_use_id`; a `tool_result` whose text forges a `qa-receipt:` token without the preceding
  actions; a `Page URL:` line on a foreign origin; a non-empty `permission_denials`; an
  `apiKeySource` indicating an API key; an `init` event advertising a tool outside the whitelist.
- Equivalence test: the same logical scenario expressed in both dialects produces the same
  `parseCodexEvents` verdict and the same `tool_calls` sequence.
- `runExecution` end-to-end through the existing `adapters` seam with `QA_AGENT=claude-code`.
- A live run remains the only proof of the real integration and must be recorded separately, as the
  Codex path was.

## Open questions

1. **Deriving the disallowed list.** Because the residual tool set is build-dependent, the pinned
   version must be probed once during pin review and its reported `init.tools` recorded in the spec,
   the same way the runner version is recorded. The assertion then fails closed if a later build adds
   a tool.
2. **Auth readiness without a live probe.** The Codex doctor asserts `codex login status` reports a
   ChatGPT subscription. Claude Code exposes no equivalent read-only status command, and
   `apiKeySource` is only observable once a run starts. Options: accept a bounded tool-free probe in
   the doctor at a small quota cost; or accept that `auth_required` is discovered by the first real
   run. Recommendation: probe only in the `start` phase, and rely on the in-band `apiKeySource`
   assertion for every run.
3. **Model pin.** A pinned model id makes runs reproducible but drifts against availability. It must
   be pinned and revalidated by the same rule the other pins follow, never left as an alias.
4. **Whether the Codex path stays.** Keeping both costs a second login lifecycle on the runner.
   Removing Codex loses the OS-level read-only sandbox. Recommendation: keep both, default to
   `codex`, and revisit once the Claude Code path has a recorded live run.
