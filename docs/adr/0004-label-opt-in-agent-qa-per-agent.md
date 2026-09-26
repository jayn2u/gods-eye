# Run Agent QA per agent, only on an explicit label

Status: accepted (2026-09-25)

Update (2026-09-26): the `agent-qa` label and nine unused default labels were deleted from the repository; Claude Agent QA shipped as described below.

## Context

Agent QA ran one browser agent, the GitHub Copilot CLI, from a single `agent-qa.yml` workflow. It
started for any pull request whose base matched `release/*` and for any pull request carrying the
`agent-qa` label. The label, the workflow path, the comment marker, the evidence branch, and the
report's agent name were each a single hard-coded value, and one `execute.cjs run` process owned the
whole run from runtime start to report.

We want a second agent, Claude, run through the Claude Code GitHub Action, and the ability to run the
same scenarios through either agent or both. A GitHub Action is a workflow step, not a child process
the harness can supervise.

## Decision

Agent QA runs only when a pull request carries an agent's own label: `copilot-agent-qa` or
`claude-agent-qa`. The `release/*` automatic trigger is removed. The old `agent-qa` label starts
nothing; it stays in the repository described as deprecated until it is deleted. The label is the
whole opt-in: no base branch is required. Both labels together run both agents independently.

Each agent has its own trusted workflow pair (`<agent>-agent-qa.yml` and
`<agent>-agent-qa-report.yml`), its own secret, its own pull-request comment marker
(`gods-eye-<agent>-agent-qa:v1`), its own artifact prefix, and its own screenshot branch
(`<agent>-agent-qa-evidence`). Every agent-specific value comes from one Agent Profile registry, so the
controller, reporter, and evidence publisher cannot disagree about them. Both workflows share the
single self-hosted runner and the one global concurrency group, so all Agent QA runs one job at a
time.

The harness stays shared and agent-agnostic: the scenarios, prompt, trusted browser journal and
receipt evidence model, fixture runtime, and deterministic baseline are identical for every agent,
so the two agents are judged by the same proof. `execute.cjs` is split into three steps — `prepare`
(doctor, fixture runtime, baseline, prompt), an agent step, and `finalize` (journal verification,
report, cleanup) that runs under `always()`. The fixture runtime's process groups are detached and
handed from `prepare` to `finalize` through their manifest. The agent credential is visible only to
the agent step.

Claude runs through `anthropics/claude-code-base-action`, pinned by commit SHA, which has no GitHub
integration: it receives only `CLAUDE_CODE_OAUTH_TOKEN` and never a repository token. Claude Code is
installed from the pinned toolchain lock, not by the action's `curl | bash` installer, and passed as
`path_to_claude_code_executable`; it runs with a run-scoped `HOME`, `--strict-mcp-config`, and only the
Playwright browser tools allowed. It runs `--model opus`.

## Consequences

Removing the release trigger means a release pull request gets no Agent QA unless someone applies a
label. Agent QA stays advisory in every case and never becomes a required check.

The Claude model is the `opus` alias, which follows the newest Opus model. This is a deliberate
exception to the pin policy that forbids `latest`-style substitution for every other tool: the report
records the model the run actually resolved, so a change of model is visible, but it is not reviewed
in advance.

Two labels on one pull request double the queue time for that head, because both runs share the one
runner. Two workflows, two report workflows, and two evidence branches are more files than one
parameterized workflow; in return a job never holds another agent's credential, and each reporter
owns exactly one comment and one branch, so two publications never race.

The work lands in two pull requests: the Copilot rename, trigger removal, profile registry, and step
split first, validated live, then the Claude adapter and workflows.
