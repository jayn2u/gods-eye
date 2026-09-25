# Copilot Agent QA Label Opt-in (PR ①) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single `agent-qa` workflow into a per-agent, label-only `copilot-agent-qa` workflow whose harness is agent-agnostic and split into `prepare` → agent step → `finalize`, so PR ② can add Claude through a GitHub Action without touching the shared harness.

**Architecture:** A new Agent Profile registry (`agents/profiles.cjs`) becomes the only source of every agent-specific value (label, workflow file/name, comment marker and title, artifact prefix, evidence branch). The controller, contracts, reporter, evidence publisher, and job summary read the profile instead of constants. `execute.cjs` gains `prepare`, `agent`, and `finalize` subcommands that hand state through a private `state.json`; the fixture runtime's detached process groups survive between steps and are stopped by `finalize` from their manifest. `runExecution` stays as the in-process composition of the three so existing tests keep their shape.

**Tech Stack:** Node 24 CommonJS, `node:test`, Ajv 8.17.1, GitHub Actions (`pull_request_target`, `workflow_run`), `actions/github-script` v8, GitHub Copilot CLI 1.0.83, Playwright MCP 0.0.80.

**Spec:** `docs/adr/0004-label-opt-in-agent-qa-per-agent.md` (decisions) and `docs/setup/agent-qa.md` (current operator contract).

## Global Constraints

- Branch `claude/agent-qa-label-split`, one PR into `develop`; commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Code is written with gpt luna max (`codex exec -m gpt-6-luna` effort max) per the user's global rule; Claude reviews.
- Label `copilot-agent-qa` is the only admission path. `release/*` admission and the `agent-qa` label are removed entirely — a PR carrying only `agent-qa` must be `skipped/qa_not_requested`.
- No base-branch restriction.
- Profile values for Copilot, verbatim: label `copilot-agent-qa`; workflow `copilot-agent-qa.yml`, name `Copilot Agent QA`; report workflow `copilot-agent-qa-report.yml`, name `Copilot Agent QA Report`; marker `<!-- gods-eye-copilot-agent-qa:v1 -->`; comment/summary title `Copilot Agent QA (advisory)`; artifact prefix `copilot-agent-qa`; evidence branch `copilot-agent-qa-evidence`.
- Concurrency groups: per-PR `gods-eye-copilot-agent-qa-pr-<n>`; global runner queue stays `gods-eye-agent-qa-global` (shared by every agent); report `gods-eye-copilot-agent-qa-report-pr-<n>`.
- Runner label `gods-eye-agent-qa`, service `gods-eye-agent-qa-runner.service`, `QA_ROOT`, and the pinned action SHAs are unchanged.
- `QA_COPILOT_TOKEN` is present only in the agent step's `env`; `prepare` and `finalize` never see it.
- Job limit 30 min, internal deadline 25 min from `JOB_START`; the agent step gets `timeout-minutes: 22` so `finalize` always has time.
- Run helper tests with `npm test --prefix .github/agent-qa` (after `npm ci --prefix .github/agent-qa`). The Python suite (`uv run --extra indexing pytest -q`) must stay green but is not touched.
- Never push directly to `develop`; the new workflows go live only after merge.

## File Structure

| File | Responsibility |
|---|---|
| `.github/agent-qa/agents/profiles.cjs` (new) | Agent Profile registry and lookups by agent, workflow path, workflow name |
| `.github/agent-qa/controller.cjs` | Label-only, per-agent admission; run-name and trusted-path checks per profile |
| `.github/agent-qa/request.schema.json` | Request carries `agent` |
| `.github/agent-qa/report.schema.json`, `contracts.cjs` | `tools.agent.name` ∈ profile agents and equals `request.agent` |
| `.github/agent-qa/reporter.cjs` | Profile-derived marker, title, artifact name, trusted path |
| `.github/agent-qa/evidence-branch.cjs` | Branch passed in from the profile |
| `.github/agent-qa/summary.cjs` | Title from the report's agent profile |
| `.github/agent-qa/runtime.cjs` | `ProcessSupervisor.handOff()` and `stopHandedOffRuntime()` |
| `.github/agent-qa/doctor.cjs` | `prepare` phase that does not require the agent token; `agentTokenReadiness()` |
| `.github/agent-qa/execute.cjs` | `prepare` / `agent` / `finalize` subcommands with `state.json` handoff |
| `.github/workflows/copilot-agent-qa.yml`, `copilot-agent-qa-report.yml` (renamed from `agent-qa*.yml`) | Three-step QA job, per-profile names and groups |
| `docs/setup/agent-qa.md`, `docs/setup/local-development.md` | Operator guide for the label model and step split |

---

### Task 1: Agent Profile registry

**Files:**
- Create: `.github/agent-qa/agents/profiles.cjs`
- Test: `.github/agent-qa/test/profiles.test.cjs`

**Interfaces:**
- Produces: `AGENTS: readonly string[]`, `PROFILES: Readonly<Record<string, Profile>>`, `profileFor(agent: string): Profile` (throws `ProfileError` code `unknown_agent`), `profileForWorkflowPath(path: string): Profile | null` (accepts `path` or `path@ref`), `profileForWorkflowName(name: string): Profile | null`, `ProfileError`.
- `Profile = { agent, label, workflowFile, workflowName, workflowPath, reportWorkflowFile, reportWorkflowName, commentMarker, title, artifactPrefix, evidenceBranch }` — all strings, deep-frozen.

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  AGENTS, PROFILES, ProfileError, profileFor, profileForWorkflowName, profileForWorkflowPath,
} = require('../agents/profiles.cjs');

test('declares the Copilot profile verbatim', () => {
  assert.deepEqual(AGENTS, ['copilot']);
  assert.deepEqual({ ...profileFor('copilot') }, {
    agent: 'copilot',
    label: 'copilot-agent-qa',
    workflowFile: 'copilot-agent-qa.yml',
    workflowName: 'Copilot Agent QA',
    workflowPath: '.github/workflows/copilot-agent-qa.yml',
    reportWorkflowFile: 'copilot-agent-qa-report.yml',
    reportWorkflowName: 'Copilot Agent QA Report',
    commentMarker: '<!-- gods-eye-copilot-agent-qa:v1 -->',
    title: 'Copilot Agent QA (advisory)',
    artifactPrefix: 'copilot-agent-qa',
    evidenceBranch: 'copilot-agent-qa-evidence',
  });
  assert.ok(Object.isFrozen(PROFILES) && Object.isFrozen(PROFILES.copilot));
});

test('rejects an unknown or legacy agent', () => {
  for (const value of ['agent-qa', 'claude', '', undefined, '__proto__']) {
    assert.throws(() => profileFor(value), (error) => error instanceof ProfileError && error.code === 'unknown_agent');
  }
});

test('resolves a workflow path with or without a ref and refuses look-alikes', () => {
  assert.equal(profileForWorkflowPath('.github/workflows/copilot-agent-qa.yml').agent, 'copilot');
  assert.equal(profileForWorkflowPath('.github/workflows/copilot-agent-qa.yml@refs/heads/develop').agent, 'copilot');
  for (const value of [
    '.github/workflows/agent-qa.yml', '.github/workflows/copilot-agent-qa.yml.evil',
    '.github/workflows/copilot-agent-qa.yml@', 'copilot-agent-qa.yml', null,
  ]) assert.equal(profileForWorkflowPath(value), null);
});

test('resolves a workflow display name exactly', () => {
  assert.equal(profileForWorkflowName('Copilot Agent QA').agent, 'copilot');
  assert.equal(profileForWorkflowName('Agent QA'), null);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test .github/agent-qa/test/profiles.test.cjs`
Expected: FAIL with `Cannot find module '../agents/profiles.cjs'`.

- [ ] **Step 3: Implement**

```js
'use strict';

/**
 * The one declaration of every agent-specific Agent QA value. The controller, reporter, evidence
 * publisher, and job summary read these instead of their own constants, so they cannot disagree
 * about which label admits a run or which comment and branch a run owns.
 */
class ProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProfileError';
    this.code = code;
  }
}

function define(agent, displayName) {
  const workflowFile = `${agent}-agent-qa.yml`;
  return Object.freeze({
    agent,
    label: `${agent}-agent-qa`,
    workflowFile,
    workflowName: `${displayName} Agent QA`,
    workflowPath: `.github/workflows/${workflowFile}`,
    reportWorkflowFile: `${agent}-agent-qa-report.yml`,
    reportWorkflowName: `${displayName} Agent QA Report`,
    commentMarker: `<!-- gods-eye-${agent}-agent-qa:v1 -->`,
    title: `${displayName} Agent QA (advisory)`,
    artifactPrefix: `${agent}-agent-qa`,
    evidenceBranch: `${agent}-agent-qa-evidence`,
  });
}

const PROFILES = Object.freeze({ copilot: define('copilot', 'Copilot') });
const AGENTS = Object.freeze(Object.keys(PROFILES));

function profileFor(agent) {
  if (typeof agent !== 'string' || !Object.hasOwn(PROFILES, agent)) {
    throw new ProfileError('unknown_agent', 'agent must name a declared Agent Profile');
  }
  return PROFILES[agent];
}

function profileForWorkflowPath(value) {
  if (typeof value !== 'string') return null;
  return Object.values(PROFILES).find((profile) => value === profile.workflowPath
    || (value.startsWith(`${profile.workflowPath}@`) && value.length > profile.workflowPath.length + 1)) ?? null;
}

function profileForWorkflowName(value) {
  return Object.values(PROFILES).find((profile) => profile.workflowName === value) ?? null;
}

module.exports = Object.freeze({
  AGENTS, PROFILES, ProfileError, profileFor, profileForWorkflowName, profileForWorkflowPath,
});
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test .github/agent-qa/test/profiles.test.cjs` — Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add .github/agent-qa/agents/profiles.cjs .github/agent-qa/test/profiles.test.cjs
git commit -m "feat(agent-qa): declare agent-specific values in one Agent Profile registry"
```

---

### Task 2: Label-only, per-agent admission in the controller

**Files:**
- Modify: `.github/agent-qa/controller.cjs` (constants at lines 6–12; `formatRunName`, `parseRunName`, `parseWorkflowRunIdentity`, `isTrustedWorkflowPath` at 41–75; `hasQaLabel`/`requestsAgentQa` at 152–161; `validateAdmissionInput` 97; `assessPullRequest` request object ~282; `recheckPullRequest`; `selectLatestGeneration`; `listCorrelatedWorkflowRuns`; exports)
- Modify: `.github/agent-qa/request.schema.json`
- Modify: `.github/agent-qa/test/controller.test.cjs`, `.github/agent-qa/test/fixtures/actions-run-identity.json`, `.github/agent-qa/test/fixtures/controller/*.json`, `.github/agent-qa/test/contracts.test.cjs` (request fixtures gain `agent`)

**Interfaces:**
- Consumes: `profileFor`, `profileForWorkflowPath` from Task 1.
- Produces:
  - `admitPullRequest({ github, repository, agent, pullNumber, eventHeadSha, controllerSha, runId, runAttempt, admittedAt })` → `{ status, reason, request? }`; `request.agent === agent`.
  - `recheckPullRequest({ github, request })` — agent taken from `request.agent`.
  - `formatRunName({ agent, prNumber, headSha })` → `"<workflowName> PR #<n> head <sha>"`.
  - `parseRunName(displayTitle, agent)` → `{ prNumber, headSha } | null`.
  - `parseWorkflowRunIdentity(run)` → `{ agent, prNumber, headSha } | null` — agent resolved from `run.path` via `profileForWorkflowPath`, and the name must use that profile's `workflowName`.
  - `isTrustedWorkflowPath(value, agent)` → boolean.
  - `selectLatestGeneration(runs, { agent, prNumber, headSha })`, `listCorrelatedWorkflowRuns({ github, repository, agent, prNumber, headSha })`, `findLatestGeneration(same)`.
  - Removed exports: `AGENT_QA_WORKFLOW`, `AGENT_QA_WORKFLOW_NAME`, `AGENT_QA_WORKFLOW_PATH`, `QA_LABEL`, `RELEASE_BASE_PATTERN`.

- [ ] **Step 1: Rewrite the admission tests first**

In `controller.test.cjs`:
- Replace `QA_LABEL` import with `const { profileFor } = require('../agents/profiles.cjs'); const COPILOT = profileFor('copilot');`.
- Pass `agent: 'copilot'` in every `admitPullRequest` input helper.
- Delete `'admits a live private release PR from a write-equivalent author'` and `'admits an unlabelled release PR so the release trigger stays independent of the label'`; in fixture `eligible-event.json` change the base to `develop` and add `labels: [{ "name": "copilot-agent-qa" }]`.
- Change the retarget invalidation case to `['retargeted to another base', (state) => (state.pull_request.base.ref = 'main'), 'source_changed']`.
- Replace `'Agent QA PR #…'` with `'Copilot Agent QA PR #…'` and `'.github/workflows/agent-qa.yml'` / `workflow_id: 'agent-qa.yml'` with the copilot values; update `actions-run-identity.json` the same way (keep ids).
- Add these tests:

```js
test('admits only a PR that carries its own agent label, on any base', async () => {
  for (const base of ['develop', 'main', 'release/1.2.0', 'feature/x']) {
    const state = eligibleState();
    state.pull_request.base.ref = base;
    state.pull_request.labels = [{ name: 'bug' }, { name: COPILOT.label }];
    const decision = await admitPullRequest(inputFor(state, { agent: 'copilot' }));
    assert.equal(decision.status, 'admitted', base);
    assert.equal(decision.request.agent, 'copilot');
  }
});

test('the legacy agent-qa label and a release base admit nothing', async () => {
  for (const [labels, base] of [[[{ name: 'agent-qa' }], 'develop'], [[], 'release/1.2.0'], [[{ name: 'agent-qa' }], 'release/1.2.0']]) {
    const state = eligibleState();
    state.pull_request.labels = labels;
    state.pull_request.base.ref = base;
    assert.deepEqual(
      { ...(await admitPullRequest(inputFor(state, { agent: 'copilot' }))) },
      { status: 'skipped', reason: 'qa_not_requested' },
    );
  }
});

test('an unknown agent is invalid input, not a skip', async () => {
  const decision = await admitPullRequest(inputFor(eligibleState(), { agent: 'agent-qa' }));
  assert.deepEqual({ ...decision }, { status: 'incomplete', reason: 'invalid_input' });
});

test('recheck invalidates a PR whose agent label was removed', async () => {
  const state = eligibleState();
  const admitted = await admitPullRequest(inputFor(state, { agent: 'copilot' }));
  state.pull_request.labels = [{ name: 'agent-qa' }];
  const checked = await recheckPullRequest({ github: githubFor(state), request: admitted.request });
  assert.equal(checked.reason, 'qa_not_requested');
});

test('run identity is bound to the profile named by the workflow path', () => {
  const sha = 'a'.repeat(40);
  assert.equal(formatRunName({ agent: 'copilot', prNumber: 52, headSha: sha }), `Copilot Agent QA PR #52 head ${sha}`);
  assert.equal(parseRunName(`Agent QA PR #52 head ${sha}`, 'copilot'), null);
  const run = { name: `Copilot Agent QA PR #52 head ${sha}`, display_title: `Copilot Agent QA PR #52 head ${sha}`, path: COPILOT.workflowPath };
  assert.deepEqual({ ...parseWorkflowRunIdentity(run) }, { agent: 'copilot', prNumber: 52, headSha: sha });
  assert.equal(parseWorkflowRunIdentity({ ...run, path: '.github/workflows/agent-qa.yml' }), null);
});
```

(`eligibleState()` / `inputFor()` are the existing fixture helpers in this file; extend `inputFor` to accept overrides.)

- [ ] **Step 2: Run to verify failure**

Run: `node --test .github/agent-qa/test/controller.test.cjs` — Expected: FAIL (`agent` unknown / release PR still admitted).

- [ ] **Step 3: Implement the controller changes**

```js
const { validateRequest } = require('./contracts.cjs');
const { ProfileError, profileFor, profileForWorkflowPath } = require('./agents/profiles.cjs');

const EXPECTED_REPOSITORY = 'jayn2u/gods-eye';
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const PAGE_SIZE = 100;

function runNamePattern(profile) {
  const escaped = profile.workflowName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`^${escaped} PR #([1-9][0-9]*) head ([0-9a-f]{40})$`, 'u');
}

function formatRunName({ agent, prNumber, headSha }) {
  const profile = profileFor(agent);
  if (!isPositiveInteger(prNumber) || !isSha(headSha)) {
    throw new ControllerError('invalid_run_identity', 'invalid PR number or head SHA');
  }
  return `${profile.workflowName} PR #${prNumber} head ${headSha}`;
}

function parseRunName(displayTitle, agent) {
  if (typeof displayTitle !== 'string') return null;
  const match = runNamePattern(profileFor(agent)).exec(displayTitle);
  if (!match) return null;
  const prNumber = Number(match[1]);
  return isPositiveInteger(prNumber) ? Object.freeze({ prNumber, headSha: match[2] }) : null;
}

function parseWorkflowRunIdentity(run) {
  if (!run || typeof run !== 'object' || typeof run.name !== 'string' || run.name !== run.display_title) return null;
  const profile = profileForWorkflowPath(run.path);
  if (!profile) return null;
  const parsed = parseRunName(run.name, profile.agent);
  return parsed ? Object.freeze({ agent: profile.agent, ...parsed }) : null;
}

function isTrustedWorkflowPath(value, agent) {
  return profileForWorkflowPath(value)?.agent === profileFor(agent).agent;
}

function requestsAgentQa(pullRequest, agent) {
  const { label } = profileFor(agent);
  return Array.isArray(pullRequest.labels)
    && pullRequest.labels.some((item) => item !== null && typeof item === 'object' && item.name === label);
}
```

- `validateAdmissionInput`: also `profileFor(input.agent)` inside the `try`; catch `ProfileError` alongside `ControllerError` and return `null` (→ `incomplete/invalid_input`).
- `pullRequestRejection(pullRequest, pullNumber, expectedIdentity, agent)` calls `requestsAgentQa(pullRequest, agent)`; `assessPullRequest` passes `input.agent`.
- The admitted request adds `agent: input.agent` directly after `schema_version`.
- `recheckPullRequest` builds `input.agent = request.agent`.
- `selectLatestGeneration(runs, identity)`: call `formatRunName(identity)`, then require `parsed?.agent === identity.agent` and `isTrustedWorkflowPath(run?.path, identity.agent)`.
- `listCorrelatedWorkflowRuns({ github, repository, agent, prNumber, headSha })`: `workflow_id: profileFor(agent).workflowFile`; drop the `workflowId` parameter and its `invalid_workflow` check; error text `failed to list trusted ${profile.workflowName} workflow runs`.
- Exports: remove the five legacy constants; keep everything else.

In `request.schema.json`: add `"agent"` to `required` right after `schema_version`, and `"agent": { "enum": ["copilot"] }` to `properties`. Add `agent: 'copilot'` to every request fixture in `contracts.test.cjs`, `execute.test.cjs`, `reporter.test.cjs`, `workflows.test.cjs`, and `test/fixtures/**` (search: `grep -rln "controller_sha" .github/agent-qa/test`).

- [ ] **Step 4: Add a guard test that the enum and registry agree**

In `contracts.test.cjs`:

```js
test('request schema agents equal the Agent Profile registry', () => {
  const schema = require('../request.schema.json');
  assert.deepEqual(schema.properties.agent.enum, [...require('../agents/profiles.cjs').AGENTS]);
});
```

- [ ] **Step 5: Run and pass**

Run: `npm test --prefix .github/agent-qa` — Expected: controller and contracts tests pass. Reporter/workflow tests may still fail on names; they are fixed in Tasks 3 and 7.

- [ ] **Step 6: Commit**

```bash
git add .github/agent-qa
git commit -m "feat(agent-qa)!: admit only a PR carrying its agent's label and drop the release trigger"
```

---

### Task 3: Profile-driven report contract, reporter, evidence branch, and summary

**Files:**
- Modify: `.github/agent-qa/report.schema.json` (`tools.agent.name`), `.github/agent-qa/contracts.cjs` (`validateReport`)
- Modify: `.github/agent-qa/reporter.cjs` (lines 15–29, `renderComment` 284, `fetchAuthoritativeRun` 326, `findManagedComment` 361, `listExactArtifact` 369, `synthesizeCurrentRequest` 410, `prepareEvidencePublication` 447, `publishWorkflowRun` 471, exports)
- Modify: `.github/agent-qa/evidence-branch.cjs` (`EVIDENCE_BRANCH`/`EVIDENCE_REF` 18–19, `publishScreenshots` 49, commit message 183)
- Modify: `.github/agent-qa/summary.cjs` (`renderJobSummary` 152, footer 204)
- Test: `reporter.test.cjs`, `evidence-branch.test.cjs`, `summary.test.cjs`, `contracts.test.cjs`, `test/fixtures/reporter/api.json`

**Interfaces:**
- Consumes: Task 1 lookups; Task 2 `parseWorkflowRunIdentity` (returns `agent`), `findLatestGeneration({ agent, … })`, `admitPullRequest({ agent, … })`.
- Produces:
  - `validateReport(report, request)` additionally throws unless `report.tools.agent.name === request.agent`.
  - `renderComment({ profile, identity, run, status, reason, report, artifact, notApplicableReason, evidenceFiles })`.
  - `findManagedComment(comments, profile)`.
  - `prepareEvidencePublication(...)` → `{ agent, branch, prNumber, runId, runAttempt, screenshots } | null`.
  - `publishScreenshots({ github, repository, branch, prNumber, runId, runAttempt, screenshots })` — `branch` required and must equal some profile's `evidenceBranch`, otherwise `EvidenceBranchError('invalid_branch')`.
  - `renderJobSummary({ report, runUrl, artifactUrl })` titles with `profileFor(report.tools.agent.name).title`.
  - Removed: `COMMENT_MARKER`, `WORKFLOW_PATH`, `EVIDENCE_BRANCH` exports.

- [ ] **Step 1: Write failing tests**

`contracts.test.cjs`:

```js
test('a report must name the agent its request admitted', () => {
  const { request, report } = validReportFixture();          // existing helper
  report.tools.agent.name = 'claude';
  assert.throws(() => validateReport(report, request));
  const schema = require('../report.schema.json');
  assert.deepEqual(schema.properties.tools.properties.agent.properties.name.enum, [...require('../agents/profiles.cjs').AGENTS]);
});
```

`reporter.test.cjs` — rename all `'Agent QA PR #'`, `agent-qa.yml`, `agent-qa-<pr>-<run>-<attempt>` artifact names, and `<!-- gods-eye-agent-qa:v1 -->` to the Copilot values; then add:

```js
test('the comment uses the profile marker and title and ignores the legacy comment', async () => {
  const profile = profileFor('copilot');
  const legacy = { id: 7, user: { login: 'github-actions[bot]' }, body: '<!-- gods-eye-agent-qa:v1 -->\nold' };
  assert.equal(findManagedComment([legacy], profile), null);
  const body = renderComment({ profile, ...minimalCommentInput() });   // existing fixture builder
  assert.ok(body.startsWith(`${profile.commentMarker}\n## ${profile.title}`));
});

test('a workflow_run from the legacy agent-qa.yml path is untrusted', async () => {
  const run = { ...trustedRun(), path: '.github/workflows/agent-qa.yml' };
  const outcome = await publishWorkflowRun({ github: fakeGithub(), workflowRun: run, repository: 'jayn2u/gods-eye', evidenceFiles: [] });
  assert.equal(outcome.status, 'skipped');
});
```

`evidence-branch.test.cjs`: pass `branch: 'copilot-agent-qa-evidence'` everywhere, assert refs are `heads/copilot-agent-qa-evidence`, and add a case that `branch: 'agent-qa-evidence'` rejects with `invalid_branch`.

`summary.test.cjs`: assert `renderJobSummary({ report })` starts with `# Copilot Agent QA (advisory)`.

- [ ] **Step 2: Run to verify failure**

Run: `npm test --prefix .github/agent-qa` — Expected: the new cases fail.

- [ ] **Step 3: Implement**

- `report.schema.json`: `"name": { "enum": ["copilot"] }`.
- `contracts.cjs` `validateReport`: after the schema check, `if (report.tools.agent.name !== request.agent) throw new ContractError('agent_mismatch')` (use the file's existing error type/code style).
- `reporter.cjs`:
  - Drop `COMMENT_MARKER` and `WORKFLOW_PATH`; import `profileFor`.
  - `fetchAuthoritativeRun`: `const identity = parseWorkflowRunIdentity(run)`; trusted only if `identity` is non-null **and** `isTrustedWorkflowPath(run.path, identity.agent)`; return `{ run, identity, profile: profileFor(identity.agent) }`.
  - `findManagedComment(comments, profile)` matches `profile.commentMarker` exactly as today's marker logic does.
  - `listExactArtifact(github, run, identity, profile)`: `expectedName = \`${profile.artifactPrefix}-${identity.prNumber}-${run.id}-${run.run_attempt}\``.
  - `renderComment` first two lines: `profile.commentMarker`, `` `## ${profile.title}` ``; footer: `` `_${profile.title.replace(' (advisory)', '')} is advisory and does not establish identity or real-gallery quality._` ``.
  - `synthesizeCurrentRequest` passes `agent: identity.agent` to `admitPullRequest`; every `findLatestGeneration` call passes `agent: identity.agent`.
  - `expectedRequestFromReport`: additionally require `report.request.agent === identity.agent`.
  - `prepareEvidencePublication` returns `agent: identity.agent, branch: profile.evidenceBranch` with the existing fields.
- `evidence-branch.cjs`: delete the constants; in `publishScreenshots` validate `branch` against `Object.values(PROFILES).map((p) => p.evidenceBranch)`, derive `const ref = \`heads/${branch}\``, use it for get/update/create, return `branch`, and commit message `` `${profileForBranch.title.replace(' (advisory)', '')} evidence for PR #${prNumber} run ${runId} attempt ${runAttempt}` ``. Update the trust comment at the top to say "the evidence branch named by the run's Agent Profile".
- `summary.cjs`: `const lines = [\`# ${profileFor(report?.tools?.agent?.name).title}\`, '']` guarded with `try/catch` falling back to `'# Agent QA (advisory)'` for a report that failed validation earlier; footer text uses the same agent display name.

- [ ] **Step 4: Run and pass**

Run: `npm test --prefix .github/agent-qa` — Expected: contracts, reporter, evidence-branch, summary pass.

- [ ] **Step 5: Commit**

```bash
git add .github/agent-qa
git commit -m "feat(agent-qa): derive comment, artifact, evidence branch, and summary from the Agent Profile"
```

---

### Task 4: Hand the fixture runtime across process boundaries

**Files:**
- Modify: `.github/agent-qa/runtime.cjs` (`ProcessSupervisor` 186–376, exports 816)
- Test: `.github/agent-qa/test/runtime.test.cjs`

**Interfaces:**
- Produces:
  - `ProcessSupervisor#handOff(): Promise<{ manifestPath, runRoot, receiptPath }>` — clears the deadline timer, `unref()`s every child so the owning Node process can exit, marks the manifest `handedOff: true`, and leaves the process groups running.
  - `stopHandedOffRuntime({ manifestPath, runRoot, reason }): Promise<CleanupReceipt>` — terminates the manifest's process groups by identity + token digest (same `terminateMatchingGroup` path), removes owned paths under the same rules as `#performStop`, writes `cleanup.json`, and returns the same receipt shape (`{ version, reason, finishedAt, processes, paths, allProcessesStopped }`).
  - Internal refactor: `removeOwnedPaths({ runRoot, temporaryDirectory, ownedPaths })` shared by `#performStop` and `stopHandedOffRuntime`. The manifest must include `temporaryDirectory`.

- [ ] **Step 1: Write the failing test** (uses the existing `test/fixtures/runtime-grandchild.cjs`)

```js
test('a handed-off supervisor lets its owner exit and a later process stops the groups', async () => {
  const runRoot = await freshRunRoot();                                   // existing helper
  const script = `
    const { ProcessSupervisor, monotonicDeadlineAfter } = require(${JSON.stringify(require.resolve('../runtime.cjs'))});
    (async () => {
      const s = await new ProcessSupervisor({ runRoot: ${JSON.stringify(runRoot)}, deadline: monotonicDeadlineAfter(60000) }).initialize();
      await s.spawn('sleeper', process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: ${JSON.stringify(runRoot)}, env: { HOME: process.env.HOME, PATH: process.env.PATH } });
      process.stdout.write(JSON.stringify(await s.handOff()));
    })();`;
  const owner = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(owner.status, 0, owner.stderr);                           // owner exited on its own
  const handoff = JSON.parse(owner.stdout);
  const manifest = JSON.parse(fs.readFileSync(handoff.manifestPath, 'utf8'));
  assert.equal(manifest.handedOff, true);
  const [sleeper] = manifest.processes;
  assert.ok(identityMatches(sleeper.identity), 'group survived its owner');
  const receipt = await stopHandedOffRuntime({ ...handoff, reason: 'execution_complete' });
  assert.equal(receipt.allProcessesStopped, true);
  assert.equal(identityMatches(sleeper.identity), false);
  assert.equal(fs.existsSync(manifest.temporaryDirectory), false);
});

test('stopHandedOffRuntime refuses a manifest outside its run root', async () => {
  const runRoot = await freshRunRoot();
  await assert.rejects(stopHandedOffRuntime({ manifestPath: '/tmp/processes.json', runRoot, reason: 'x' }), { code: 'PATH_OUTSIDE_RUN' });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test .github/agent-qa/test/runtime.test.cjs` — Expected: FAIL (`s.handOff is not a function`).

- [ ] **Step 3: Implement**

- `#writeManifest` adds `temporaryDirectory: this.temporaryDirectory` and `handedOff: this.handedOff === true`.
- `handOff()`:

```js
  async handOff() {
    if (this.stopped) throw new RuntimeError('SUPERVISOR_STOPPED', 'Cannot hand off a stopped supervisor')
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer)
    this.deadlineTimer = null
    for (const record of this.records.values()) record.child.unref()
    this.handedOff = true
    await this.#writeManifest()
    return { manifestPath: this.manifestPath, runRoot: this.runRoot, receiptPath: this.receiptPath }
  }
```

- Move the owned-path loop of `#performStop` into module-level `async function removeOwnedPaths({ runRoot, temporaryDirectory, ownedPaths })` returning `pathResults`; `#performStop` calls it.
- `stopHandedOffRuntime`:

```js
async function stopHandedOffRuntime({ manifestPath, runRoot, reason = 'normal' }) {
  const absoluteRoot = assertAbsolutePath(runRoot, 'runRoot')
  const absoluteManifest = assertAbsolutePath(manifestPath, 'manifestPath')
  if (!isWithin(absoluteRoot, absoluteManifest)) throw new RuntimeError('PATH_OUTSIDE_RUN', 'Manifest is outside run root')
  const manifest = JSON.parse(await fsPromises.readFile(absoluteManifest, 'utf8'))
  if (manifest.version !== MANIFEST_VERSION || path.resolve(manifest.runRoot) !== absoluteRoot || !Array.isArray(manifest.processes)) {
    throw new RuntimeError('INVALID_MANIFEST', 'Process manifest does not match the requested run root')
  }
  const processes = []
  for (const record of [...manifest.processes].reverse()) processes.push(await terminateMatchingGroup(record))
  const paths = await removeOwnedPaths({ runRoot: absoluteRoot, temporaryDirectory: manifest.temporaryDirectory, ownedPaths: manifest.ownedPaths ?? [] })
  const receipt = {
    version: 1, reason, finishedAt: new Date().toISOString(), processes, paths,
    allProcessesStopped: processes.every(item => item.outcome === 'stopped' || item.outcome === 'identity_mismatch'),
  }
  await writeJsonAtomic(path.join(absoluteRoot, 'cleanup.json'), receipt)
  return receipt
}
```

  (`terminateMatchingGroup` already accepts a manifest record because `reclaimStaleManifest` uses it that way; confirm it needs only `name`, `identity`, `tokenDigest`.)
- Export `stopHandedOffRuntime`.

- [ ] **Step 4: Run and pass**

Run: `node --test .github/agent-qa/test/runtime.test.cjs` — Expected: all pass, including the existing cleanup tests.

- [ ] **Step 5: Commit**

```bash
git add .github/agent-qa/runtime.cjs .github/agent-qa/test/runtime.test.cjs
git commit -m "feat(agent-qa): hand a running fixture runtime from one step to a later one"
```

---

### Task 5: Doctor `prepare` phase and agent-token readiness

**Files:**
- Modify: `.github/agent-qa/doctor.cjs` (subscription block 195–213, exports)
- Test: `.github/agent-qa/test/doctor.test.cjs`

**Interfaces:**
- Produces:
  - `runDoctor({ env, phase })` accepts `phase: 'prepare'`; in that phase `subscription_auth` checks only `foreign_provider_environment` and reports `token_source: 'agent-step'`, `required: false`.
  - `agentTokenReadiness(token: string): { present: boolean, wellFormed: boolean }` — the exact rule used today (`>= 20` chars after trim, no whitespace anywhere).

- [ ] **Step 1: Failing tests**

```js
test('the prepare phase does not require the agent token but still refuses a foreign provider key', async () => {
  const ready = await runDoctor({ env: readyEnv({ GITHUB_ACTIONS: 'true', QA_COPILOT_TOKEN: '' }), phase: 'prepare' });
  const auth = ready.checks.find((c) => c.name === 'subscription_auth');
  assert.equal(auth.ok, true);
  assert.equal(auth.token_source, 'agent-step');
  const foreign = await runDoctor({ env: readyEnv({ GITHUB_ACTIONS: 'true', ANTHROPIC_API_KEY: 'x' }), phase: 'prepare' });
  assert.equal(foreign.checks.find((c) => c.name === 'subscription_auth').ok, false);
});

test('agentTokenReadiness keeps the whitespace rule', () => {
  assert.deepEqual(agentTokenReadiness('a'.repeat(40)), { present: true, wellFormed: true });
  assert.deepEqual(agentTokenReadiness(`${'a'.repeat(40)}\n`), { present: false, wellFormed: false });
  assert.deepEqual(agentTokenReadiness(''), { present: false, wellFormed: true });
});
```

(`readyEnv` is the existing all-checks-pass env builder in this file.)

- [ ] **Step 2: Run to verify failure** — `node --test .github/agent-qa/test/doctor.test.cjs`.

- [ ] **Step 3: Implement** — extract the token rule into `agentTokenReadiness`; branch the `subscription_auth` detail on `phase === 'prepare'`; keep `status` and `start` phases byte-identical in behaviour. Export `agentTokenReadiness`.

- [ ] **Step 4: Run and pass**, then **Step 5: Commit**

```bash
git add .github/agent-qa/doctor.cjs .github/agent-qa/test/doctor.test.cjs
git commit -m "feat(agent-qa): let the prepare step pass doctor without holding the agent token"
```

---

### Task 6: Split execution into `prepare`, `agent`, and `finalize`

**Files:**
- Modify: `.github/agent-qa/execute.cjs` (CLI 42–67, `toolsFromDoctor` 264, `runExecution` 378–600, `main` 602, exports)
- Test: `.github/agent-qa/test/execute.test.cjs`

**Interfaces:**
- Consumes: Task 4 `handOff`/`stopHandedOffRuntime`; Task 5 `phase: 'prepare'`, `agentTokenReadiness`; Task 2 `request.agent`.
- Produces:
  - CLI:
    - `execute.cjs prepare --request <abs> --candidate <abs> --evidence <abs> --job-start <iso>` → writes `<evidence>/.private-execution/state.json` (0600) and prints `{"state":"<path>","ready":true|false}`.
    - `execute.cjs agent --state <abs>` → runs the agent named by `request.agent` (only `copilot` in this PR), writes `<private>/agent-outcome.json`.
    - `execute.cjs finalize --state <abs> [--cancelled]` → writes `report.json` exactly as today and prints `{status, reason, report}`.
  - `prepareExecution(options, deps) → { statePath, state }`, `runAgentStep({ statePath, signal }, deps) → outcome`, `finalizeExecution({ statePath, cancelled, signal }, deps) → { report, reportPath }`.
  - `runExecution(options, adapters)` keeps its signature and returns the same `{ report, reportPath }` by calling the three in order in one process (tests and `verify-live.cjs` keep working).
  - `state.json` shape (all paths absolute):

```json
{
  "schema_version": 1,
  "request_path": "...", "candidate": "...", "evidence": "...",
  "deadline_epoch_ms": 0, "started_at": "ISO",
  "private_root": "...", "screenshots_root": "...",
  "before": {"<tracked path>": "<sha>"},
  "tools": {"node": "", "agent": {"name": "copilot", "version": ""}, "playwright_mcp": "", "chromium": ""},
  "deterministic": [{"name": "candidate-playwright", "status": "passed"}],
  "phases": [{"name": "doctor", "seconds": 1}],
  "reason": null, "stale": false,
  "runtime": {"origin": "http://127.0.0.1:1234", "manifest_path": "...", "run_root": "..."} ,
  "prompt_path": "...",
  "agent_paths": {"work_dir": "...", "agent_home": "...", "journal": "...", "private_result": "..."}
}
```

  `runtime`, `prompt_path`, and `agent_paths` are `null` when `prepare` failed; `reason` then carries the classified failure (`setup_failed`, `auth_required`, `browser_unavailable`, `timeout`, …) and `ready` is `false`.
  - `agent-outcome.json`: `{ "process_error": null | { "code", "message", "details" }, "journal_path", "stdout_path", "stderr_path", "config_path", "private_result", "phases": [{ "name": "agent", "seconds" }] }`.

- [ ] **Step 1: Failing tests** (reuse the file's existing `bundle` of fake adapters: `runDoctor`, `startRuntime`, `runBaseline`, `runAgent`)

```js
test('prepare, agent, and finalize in separate calls produce the same report as runExecution', async () => {
  const a = await fixtureBundle();                      // existing builder at line ~70
  const whole = await runExecution(a.options, a.adapters);
  const b = await fixtureBundle();
  const { statePath, state } = await prepareExecution(b.options, b.adapters);
  assert.equal(state.runtime.origin.startsWith('http://127.0.0.1:'), true);
  assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
  await runAgentStep({ statePath }, b.adapters);
  const split = await finalizeExecution({ statePath, cancelled: false }, b.adapters);
  const strip = (r) => ({ ...r, started_at: 0, finished_at: 0, phases: undefined, request: { ...r.request, run: 0 } });
  assert.deepEqual(strip(split.report), strip(whole.report));
});

test('finalize still writes a report and stops the runtime when the agent step never ran', async () => {
  const b = await fixtureBundle();
  const { statePath } = await prepareExecution(b.options, b.adapters);
  const { report } = await finalizeExecution({ statePath, cancelled: false }, b.adapters);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.reason, 'runner_failed');
  assert.equal(b.runtimeStopped(), true);                 // fake startRuntime records stop
});

test('a cancelled job finalizes as cancelled', async () => {
  const b = await fixtureBundle();
  const { statePath } = await prepareExecution(b.options, b.adapters);
  const { report } = await finalizeExecution({ statePath, cancelled: true }, b.adapters);
  assert.equal(report.status, 'cancelled');
});

test('a prepare failure is carried to finalize instead of being lost', async () => {
  const b = await fixtureBundle({ doctorOk: false, failedCheck: 'browser' });
  const { state } = await prepareExecution(b.options, b.adapters);
  assert.equal(state.reason, 'browser_unavailable');
  const { report } = await finalizeExecution({ statePath: path.join(state.private_root, 'state.json'), cancelled: false }, b.adapters);
  assert.equal(report.reason, 'browser_unavailable');
});

test('the agent step refuses a missing or whitespace-padded token as auth_required', async () => {
  const b = await fixtureBundle();
  const { statePath } = await prepareExecution(b.options, b.adapters);
  const outcome = await runAgentStep({ statePath }, { ...b.adapters, env: { QA_COPILOT_TOKEN: `${'a'.repeat(40)} ` } });
  assert.equal(outcome.process_error.code, 'AUTH_REQUIRED');
  const { report } = await finalizeExecution({ statePath, cancelled: false }, b.adapters);
  assert.equal(report.reason, 'auth_required');
});

test('the CLI parses each subcommand and rejects relative paths', () => {
  assert.equal(parseCli(['agent', '--state', '/x/state.json']).command, 'agent');
  assert.equal(parseCli(['finalize', '--state', '/x/state.json', '--cancelled']).cancelled, true);
  assert.throws(() => parseCli(['agent', '--state', 'state.json']), { code: 'INVALID_PATH' });
  assert.throws(() => parseCli(['run', '--request', '/a']), { code: 'USAGE' });
});
```

Extend `fixtureBundle` so the fake `startRuntime` returns `{ origin, supervisor: { runRoot, handOff: async () => ({ manifestPath, runRoot }) }, stop }` and the adapter set includes `stopHandedOffRuntime` (records the stop) and `env` (defaults to `{ QA_COPILOT_TOKEN: 'a'.repeat(40) }`).

- [ ] **Step 2: Run to verify failure** — `node --test .github/agent-qa/test/execute.test.cjs`.

- [ ] **Step 3: Implement**

1. **Deadline across processes.** Add

```js
function deadlineFromEpoch(epochMs, clocks = {}) {
  const now = clocks.now ?? Date.now;
  const monotonic = clocks.monotonic ?? (() => performance.now());
  return monotonic() + Math.max(1, epochMs - now());
}
```

   `prepare` stores `deadline_epoch_ms = Date.parse(jobStart) + INTERNAL_DEADLINE_MS`; every step converts with `deadlineFromEpoch`.
2. **`prepareExecution`** = today's `runExecution` body up to and including `agentPrompt(...)`, then:
   - `toolsFromDoctor(doctor, chromium, request.agent)` (the agent name now comes from the request, not the literal `'copilot'`).
   - `runDoctor({ env, phase: 'prepare' })`.
   - Write the prompt to `<private>/prompt.txt` (0600).
   - `const handoff = await runtime.supervisor.handOff()`; record `runtime: { origin, manifest_path: handoff.manifestPath, run_root: handoff.runRoot }`.
   - On any error: if a runtime started, call `runtime.stop('start_failed')` immediately (nothing is handed off), set `state.reason` using the existing classification (`doctorReason`, `BASELINE_SETUP_FAILED → setup_failed`, `mapFailure`), set `stale` for `STALE_CANDIDATE`, and still write `state.json`.
   - The signal handling (`options.signal`) behaves as today.
3. **`runAgentStep`**: read `state.json`; if `state.runtime` is null, write an outcome with `process_error: { code: 'NOT_PREPARED' }` and return. Check `agentTokenReadiness((deps.env ?? process.env).QA_COPILOT_TOKEN ?? '')`; if not present, write `process_error: { code: 'AUTH_REQUIRED', message: 'Agent token missing or malformed' }` and return without spawning anything. Otherwise create `new ProcessSupervisor({ runRoot: path.join(private_root, 'agent-supervisor'), deadline: deadlineFromEpoch(...) }).initialize()`, call `deps.runAgent` (default `runCopilot`) with `runtime: { supervisor, origin }` and the same `paths`/`environment` object built today, catch its error into `process_error`, `await supervisor.stop('agent_complete')`, write `agent-outcome.json`. Install SIGINT/SIGTERM → abort → `supervisor.stop('cancelled')`.
4. **`finalizeExecution`**: read `state.json` and, if present, `agent-outcome.json`. Rebuild `parsed` from the journal exactly as the current post-agent block does (stderr diagnostics included). Reason precedence: `cancelled` flag → `cancelled`; `state.reason` if set; outcome missing while runtime was prepared → `runner_failed`; `AUTH_REQUIRED` → `auth_required`; other `process_error` → `mapFailure(process_error, parsed.errorText)`; otherwise the existing `invalid_output` rules. In `finally`: remove private paths, `deps.stopHandedOffRuntime({ manifestPath, runRoot, reason })` when `state.runtime` exists (this is `cleanupReceipt`), remove `private_root`, prune screenshots. Then the unchanged tail (tracked-file comparison against `state.before`, evidence manifest, `deriveReportOutcome`, report assembly with `phases = [...state.phases, ...outcome.phases, { name: 'finalize', seconds }]`, `validateReport`, atomic write).
   - `mapFailure` gains: `if (error?.code === 'AUTH_REQUIRED') return 'auth_required';` as its second line.
5. **`runExecution`** becomes:

```js
async function runExecution(options, adapters = {}) {
  const { statePath } = await prepareExecution(options, adapters);
  await runAgentStep({ statePath, signal: options.signal }, adapters);
  return finalizeExecution({ statePath, cancelled: Boolean(options.signal?.aborted), signal: options.signal }, adapters);
}
```

6. **CLI**: `parseCli` dispatches on `prepare` (the four flags of today's `run`), `agent` (`--state`), and `finalize` (`--state`, optional `--cancelled`); `run` is removed from the CLI (kept only as the exported function). `usage()` lists the three. `main` prints the per-command JSON line.
7. Update the `resultContract` doc comment: replace "Codex constrained…" with a neutral sentence ("Not every agent CLI can constrain its final document with a schema flag, so the shape is stated in the prompt…").

- [ ] **Step 4: Run and pass**

Run: `npm test --prefix .github/agent-qa` — Expected: execute tests pass; `verify-live.test.cjs` still passes (it goes through `runExecution`).

- [ ] **Step 5: Commit**

```bash
git add .github/agent-qa/execute.cjs .github/agent-qa/test/execute.test.cjs
git commit -m "feat(agent-qa): split execution into prepare, agent, and finalize steps"
```

---

### Task 7: Rename and restructure the workflows

**Files:**
- Rename: `.github/workflows/agent-qa.yml` → `.github/workflows/copilot-agent-qa.yml`
- Rename: `.github/workflows/agent-qa-report.yml` → `.github/workflows/copilot-agent-qa-report.yml`
- Modify: `.github/agent-qa/test/workflows.test.cjs`, `.github/agent-qa/test/fixtures/workflows/*`

**Interfaces:**
- Consumes: Task 2 `admitPullRequest({ agent })`, Task 3 reporter, Task 6 CLI.

- [ ] **Step 1: Update `workflows.test.cjs` first**
  - `parseWorkflow('copilot-agent-qa.yml')` / `('copilot-agent-qa-report.yml')`.
  - Assert `qa.name === 'Copilot Agent QA'`, `run-name === 'Copilot Agent QA PR #${{ github.event.pull_request.number }} head ${{ github.event.pull_request.head.sha }}'`, per-PR group `gods-eye-copilot-agent-qa-pr-${{ github.event.pull_request.number }}`, global group still `gods-eye-agent-qa-global`, report group `gods-eye-copilot-agent-qa-report-pr-${{ needs.correlate.outputs.pr_number }}`, `reporter.on.workflow_run.workflows` deep-equals `['Copilot Agent QA']`.
  - New assertions:

```js
test('only the agent step holds the Copilot token', () => {
  const steps = parseWorkflow('copilot-agent-qa.yml').jobs.qa.steps;
  const holders = steps.filter((s) => JSON.stringify(s.env ?? {}).includes('secrets.AGENT_QA_COPILOT_TOKEN'));
  assert.deepEqual(holders.map((s) => s.id), ['agent']);
  assert.equal(steps.find((s) => s.id === 'agent')['timeout-minutes'], 22);
});

test('prepare, agent, finalize run in order and finalize always runs after an admitted recheck', () => {
  const steps = parseWorkflow('copilot-agent-qa.yml').jobs.qa.steps;
  const ids = steps.map((s) => s.id).filter(Boolean);
  assert.ok(ids.indexOf('prepare') < ids.indexOf('agent') && ids.indexOf('agent') < ids.indexOf('finalize'));
  const finalize = steps.find((s) => s.id === 'finalize');
  assert.match(finalize.if, /always\(\)/u);
  assert.match(finalize.run, /execute\.cjs" finalize/u);
});

test('admission names the copilot agent and no workflow mentions the legacy label or release', () => {
  const source = fs.readFileSync(path.join(workflowRoot, 'copilot-agent-qa.yml'), 'utf8');
  assert.match(source, /agent: 'copilot'/u);
  assert.doesNotMatch(source, /release\/|['"]agent-qa['"]/u);
  assert.equal(fs.existsSync(path.join(workflowRoot, 'agent-qa.yml')), false);
  assert.equal(fs.existsSync(path.join(workflowRoot, 'agent-qa-report.yml')), false);
});
```

  - Keep every existing policy assertion (`assertWorkflowPolicy`, pinned SHAs, no candidate control code executed, trusted checkout at `github.workflow_sha`); only point them at the new file names. Update the forged-path case to `'.github/workflows/copilot-agent-qa.yml.evil'` and add `'.github/workflows/agent-qa.yml'` as another forged path.

- [ ] **Step 2: Run to verify failure** — `node --test .github/agent-qa/test/workflows.test.cjs`.

- [ ] **Step 3: Implement**

```bash
git mv .github/workflows/agent-qa.yml .github/workflows/copilot-agent-qa.yml
git mv .github/workflows/agent-qa-report.yml .github/workflows/copilot-agent-qa-report.yml
```

`copilot-agent-qa.yml` edits:
- `name: Copilot Agent QA`; `run-name: "Copilot Agent QA PR #${{ github.event.pull_request.number }} head ${{ github.event.pull_request.head.sha }}"`; top-level concurrency group `gods-eye-copilot-agent-qa-pr-${{ github.event.pull_request.number }}`. Keep the `pull_request_target` types (`edited` still carries retargets, `labeled`/`unlabeled` carry opt-in).
- Admission script passes `agent: 'copilot'` to `controller.admitPullRequest`.
- Replace the single "Run bounded Copilot browser QA" step with three:

```yaml
      - name: Prepare the fixture runtime and baseline
        id: prepare
        if: steps.recheck.outputs.status == 'admitted'
        env:
          QA_ROOT: ${{ steps.paths.outputs.qa_root }}
          NODE_PATH: ${{ steps.paths.outputs.qa_root }}/toolchain/node_modules
          REQUEST_PATH: ${{ steps.paths.outputs.request }}
          CANDIDATE_PATH: ${{ github.workspace }}/candidate-${{ github.run_id }}-${{ github.run_attempt }}
          EVIDENCE_PATH: ${{ steps.paths.outputs.evidence }}
          JOB_START: ${{ steps.clock.outputs.started_at }}
          GITHUB_TOKEN: ""
          GH_TOKEN: ""
        shell: bash
        run: |
          node "$GITHUB_WORKSPACE/trusted-control/.github/agent-qa/execute.cjs" prepare \
            --request "$REQUEST_PATH" --candidate "$CANDIDATE_PATH" \
            --evidence "$EVIDENCE_PATH" --job-start "$JOB_START" > "$RUNNER_TEMP/agent-qa-prepare.json"
          printf 'state=%s\n' "$(node -p 'require(process.argv[1]).state' "$RUNNER_TEMP/agent-qa-prepare.json")" >> "$GITHUB_OUTPUT"

      - name: Run bounded Copilot browser QA
        id: agent
        if: steps.prepare.outputs.state != ''
        timeout-minutes: 22
        env:
          QA_ROOT: ${{ steps.paths.outputs.qa_root }}
          NODE_PATH: ${{ steps.paths.outputs.qa_root }}/toolchain/node_modules
          # Only this step holds the Copilot credential. GITHUB_TOKEN and GH_TOKEN stay empty so the
          # agent cannot reach the repository API.
          QA_COPILOT_TOKEN: ${{ secrets.AGENT_QA_COPILOT_TOKEN }}
          QA_AGENT_MODEL: ${{ vars.AGENT_QA_MODEL }}
          GITHUB_TOKEN: ""
          GH_TOKEN: ""
          OPENAI_API_KEY: ""
          ANTHROPIC_API_KEY: ""
          CODEX_API_KEY: ""
          GOOGLE_API_KEY: ""
        shell: bash
        run: node "$GITHUB_WORKSPACE/trusted-control/.github/agent-qa/execute.cjs" agent --state "${{ steps.prepare.outputs.state }}"

      - name: Verify the journal, write the report, and stop the runtime
        id: finalize
        if: always() && steps.prepare.outputs.state != ''
        env:
          QA_ROOT: ${{ steps.paths.outputs.qa_root }}
          NODE_PATH: ${{ steps.paths.outputs.qa_root }}/toolchain/node_modules
          JOB_STATUS: ${{ job.status }}
          GITHUB_TOKEN: ""
          GH_TOKEN: ""
        shell: bash
        run: |
          cancelled=()
          if [ "$JOB_STATUS" = "cancelled" ]; then cancelled=(--cancelled); fi
          node "$GITHUB_WORKSPACE/trusted-control/.github/agent-qa/execute.cjs" finalize \
            --state "${{ steps.prepare.outputs.state }}" "${cancelled[@]}"
```

  Note: `prepare` must write `state.json` and exit 0 even when it classifies a failure, so `finalize` always has a state; it exits non-zero only for usage/path errors.
- Stage step condition becomes `if: always() && steps.prepare.outputs.state != ''`; artifact name `copilot-agent-qa-${{ github.event.pull_request.number }}-${{ github.run_id }}-${{ github.run_attempt }}`.

`copilot-agent-qa-report.yml` edits:
- `name: Copilot Agent QA Report`; `workflows: [Copilot Agent QA]`.
- Correlate script: replace the `reporter.WORKFLOW_PATH` checks with

```js
            const { profileForWorkflowPath } = require(path.join(process.env.GITHUB_WORKSPACE, 'trusted-control/.github/agent-qa/agents/profiles.cjs'));
            const trustedPath = profileForWorkflowPath(run?.path)?.agent === 'copilot';
```

  and keep the rest of the condition.
- `publish` concurrency group `gods-eye-copilot-agent-qa-report-pr-${{ needs.correlate.outputs.pr_number }}`.
- Log lines say `Copilot Agent QA …` instead of `Agent QA …`.

- [ ] **Step 4: Run and pass** — `npm test --prefix .github/agent-qa` (full suite) — Expected: all pass. Also `node -e "require('js-yaml')"`-free check: the test file already parses YAML; no extra dependency.

- [ ] **Step 5: Commit**

```bash
git add -A .github/workflows .github/agent-qa/test
git commit -m "feat(agent-qa)!: run Copilot Agent QA as prepare, agent, and finalize steps under its own workflow"
```

---

### Task 8: Operator documentation and repository labels

**Files:**
- Modify: `docs/setup/agent-qa.md`, `docs/setup/local-development.md:37`
- (ADR `docs/adr/0004-label-opt-in-agent-qa-per-agent.md` and the `CONTEXT.md` terms are already committed with this plan.)

- [ ] **Step 1: Rewrite the operator guide sections**
  - Title: "Advisory Agent QA operator guide" stays; intro says Agent QA runs per agent and currently has one agent, Copilot.
  - **Eligibility and activation**: only the `copilot-agent-qa` label admits; no base restriction; `agent-qa` does nothing and is deprecated; release PRs are not automatic. Removing the label or converting to draft or retargeting invalidates and sets the comment to `not_applicable`.
  - Rename every `Agent QA` / `Agent QA report` workflow reference to `Copilot Agent QA` / `Copilot Agent QA Report`; the comment marker, artifact name `copilot-agent-qa-<pr>-<run>-<attempt>`, and branch `copilot-agent-qa-evidence`.
  - New subsection **Step layout**: `prepare` (doctor with `phase: prepare`, runtime, baseline, prompt; no agent credential), agent step (only holder of `QA_COPILOT_TOKEN`, 22-minute step limit), `finalize` (`always()`; verifies the journal, writes the report, stops the handed-off runtime from its manifest). A run killed between steps is cleaned up by `finalize`, and anything still left at job end by the runner's orphan-process cleanup.
  - `phases` now include `finalize`.
  - Migration note: the old `agent-qa-evidence` branch and old `<!-- gods-eye-agent-qa:v1 -->` comments are no longer updated; the branch can be deleted.
  - Link ADR 0004.
- [ ] **Step 2:** In `local-development.md`, keep the link and change its text to "Copilot Agent QA operator guide".
- [ ] **Step 3: Commit**

```bash
git add docs/setup/agent-qa.md docs/setup/local-development.md
git commit -m "docs(agent-qa): describe label-only per-agent QA and the three-step job"
```

- [ ] **Step 4: Labels (after the user confirms — outward-facing)**

```bash
gh label create copilot-agent-qa --color 1D76DB --description "Opt this PR into advisory Copilot Agent QA"
gh label edit agent-qa --description "Deprecated: does nothing. Use copilot-agent-qa or claude-agent-qa"
```

---

### Task 9: Verification, pull request, and live validation

- [ ] **Step 1:** `npm ci --prefix .github/agent-qa && npm test --prefix .github/agent-qa` — all pass; paste the summary line.
- [ ] **Step 2:** `uv run --extra indexing pytest -q` — unchanged and green.
- [ ] **Step 3:** Request a code review (superpowers:requesting-code-review) focusing on: the `pull_request_target` trust boundary, secret scoping to the agent step, handed-off process cleanup, and the legacy-label/legacy-path rejection.
- [ ] **Step 4:** Push and open the PR into `develop` (body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`); bind it with the ccd_pr tools.
- [ ] **Step 5 (after merge):** Create a throwaway validation PR, apply `copilot-agent-qa`, and confirm: admission `admitted`, three QA steps succeed, report `no_findings` (or a documented `incomplete` reason), comment carries the new marker and title, screenshots land on `copilot-agent-qa-evidence`. Then apply only `agent-qa` to another PR and confirm the QA job is skipped with `qa_not_requested`.

---

## Self-Review

- **Spec coverage:** label-only admission and release removal (Task 2), legacy label inert (Tasks 2, 3, 8), no base restriction (Task 2 test), per-agent workflow/marker/artifact/branch (Tasks 1, 3, 7), shared global queue (Task 7 constraint), shared agent-agnostic harness and step split (Tasks 4–6), token only in agent step (Tasks 5, 7), advisory status unchanged (no gating added), docs and ADR (Task 8 + committed ADR). Claude adapter, `claude-agent-qa` label, `CLAUDE_CODE_OAUTH_TOKEN`, pinned Claude Code, `--model opus`, and the `copilot | claude` enum are PR ② by decision.
- **Type consistency:** `agent` is a string key of `PROFILES` everywhere; `profileFor` is the only validator; `request.agent` feeds `toolsFromDoctor`, reporter, and recheck; `stopHandedOffRuntime({ manifestPath, runRoot, reason })` matches `handOff()`'s return plus `reason`.
