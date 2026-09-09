'use strict';

const { createHash } = require('node:crypto');
const { crc32 } = require('node:zlib');
const { SCENARIO_IDS } = require('../../contracts.cjs');
const { BOT_LOGIN, COMMENT_MARKER } = require('../../reporter.cjs');

const CONTROL_SHA = 'a'.repeat(40);
const PNG = Buffer.alloc(33, 1);
Buffer.from('89504e470d0a1a0a', 'hex').copy(PNG);
PNG.write('IHDR', 12, 'ascii');
PNG.writeUInt32BE(1440, 16);
PNG.writeUInt32BE(1000, 20);

function zip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const locals = Buffer.concat(localParts);
  const directory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(locals.length, 16);
  return Buffer.concat([locals, directory, end]);
}

function artifact(run, pr, status) {
  const sha256 = createHash('sha256').update(PNG).digest('hex');
  const evidence = SCENARIO_IDS.map((id) => ({
    path: `screenshots/${id}.png`, kind: 'screenshot', size_bytes: PNG.length, sha256,
  }));
  const scenarios = SCENARIO_IDS.map((id, index) => ({
    id, status: status === 'findings' && index === 0 ? 'finding' : 'observed',
    steps: ['Used the fixture browser'], expected: 'Expected fixture state', actual: 'Observed fixture state',
    evidence: [`screenshots/${id}.png`],
  }));
  const findings = status === 'findings' ? [{
    scenario_id: SCENARIO_IDS[0], severity: 'high', title: 'Search submit is disabled',
    description: 'The enabled fixture model cannot submit a search.', evidence: [`screenshots/${SCENARIO_IDS[0]}.png`],
  }] : [];
  const report = {
    schema_version: 1,
    request: {
      schema_version: 1, repository: 'jayn2u/gods-eye', pr_number: pr.number,
      head: { repository: 'jayn2u/gods-eye', id: 77, sha: pr.head.sha },
      base: { ref: pr.base.ref, sha: CONTROL_SHA }, controller_sha: CONTROL_SHA,
      run: { id: run.id, attempt: run.run_attempt }, author: 'jayn2u', admitted_at: '2026-09-07T00:00:00Z',
    },
    tested_head_sha: pr.head.sha, controller_sha: CONTROL_SHA,
    started_at: '2026-09-07T00:00:01Z', finished_at: '2026-09-07T00:00:59Z',
    tools: { node: '24.12.0', agent: { name: 'copilot', version: '1.0.83' }, playwright_mcp: '0.0.80', chromium: 'fixture' },
    status, reason: 'none',
    deterministic_results: [{ name: 'fixture', status: 'passed', harness_started: true, app_started: true, duration_ms: 5 }],
    scenarios, findings,
    tool_calls: SCENARIO_IDS.flatMap((id) => [
      { scenario_id: id, tool: 'browser_navigate', status: 'completed' },
      { scenario_id: id, tool: 'browser_click', status: 'completed' },
      { scenario_id: id, tool: 'browser_take_screenshot', status: 'completed', evidence: `screenshots/${id}.png` },
    ]),
    evidence,
    cleanup: { attempted: true, completed: true, processes_stopped: 2, private_output_deleted: true },
  };
  return zip([
    { name: 'report.json', data: JSON.stringify(report) },
    ...SCENARIO_IDS.map((id) => ({ name: `screenshots/${id}.png`, data: PNG })),
  ]);
}

function run(id, pr, status = 'completed', conclusion = 'success') {
  const name = `Agent QA PR #${pr.number} head ${pr.head.sha}`;
  return {
    id, run_attempt: 1, name, event: 'pull_request_target', status, conclusion,
    head_sha: CONTROL_SHA, display_title: name, path: '.github/workflows/agent-qa.yml',
    repository: { full_name: 'jayn2u/gods-eye' },
  };
}

class LiveMatrixAdapter {
  constructor({ missingTimeline = false, missingAllTimelines = false, overlap = false, wrongJobRunId = false } = {}) {
    this.missingTimeline = missingTimeline;
    this.missingAllTimelines = missingAllTimelines;
    this.overlap = overlap;
    this.wrongJobRunId = wrongJobRunId;
    this.branches = new Map();
    this.pulls = new Map();
    this.runs = [];
    this.archives = new Map();
    this.nextPr = 1;
    this.nextRun = 100;
    this.nextCommit = 1;
    this.closed = [];
    this.deleted = [];
  }

  async authStatus() { return { ok: true }; }
  async repositoryMetadata() { return { full_name: 'jayn2u/gods-eye', private: true, default_branch: 'develop' }; }
  async defaultRef() { return { object: { sha: CONTROL_SHA } }; }
  async workflows() {
    return [
      { id: 1, path: '.github/workflows/agent-qa.yml', state: 'active' },
      { id: 2, path: '.github/workflows/agent-qa-report.yml', state: 'active' },
    ];
  }
  async trustedBlob() { return { sha: CONTROL_SHA }; }
  async localBlobSha() { return CONTROL_SHA; }
  async runners() {
    return [{ name: 'gods-eye-agent-qa', status: 'online', busy: false,
      labels: ['self-hosted', 'Linux', 'X64', 'gods-eye-agent-qa'].map((name) => ({ name })) }];
  }
  async doctor() {
    return { ok: true, report: { ok: true, checks: [
      { name: 'subscription_auth', ok: true, api_environment_present: false },
      { name: 'runner_service', ok: true }, { name: 'tool_versions', ok: true }, { name: 'browser', ok: true },
    ] } };
  }
  async requiredChecks() { return { observable: true, source: 'fixture', contexts: ['Python'], checks: [] }; }
  async findBranch(name) {
    const sha = this.branches.get(name);
    return sha ? { ref: `refs/heads/${name}`, object: { sha } } : null;
  }
  async createBranch(name, sha) {
    this.branches.set(name, sha);
    return { ref: `refs/heads/${name}`, object: { sha } };
  }
  async deleteBranch(name) { this.branches.delete(name); this.deleted.push(name); }
  async findPull(resource) {
    return [...this.pulls.values()].find((pr) => pr.title === resource.title && pr.head.ref === resource.head
      && pr.base.ref === resource.base && pr.body.includes(resource.marker)) || null;
  }
  async getPull(number) { return this.pulls.get(number) || null; }
  async createPull(input) {
    const pr = { number: this.nextPr++, node_id: `PR_${this.nextPr}`, title: input.title, body: input.body,
      state: 'open', draft: false, head: { ref: input.head, sha: this.branches.get(input.head) }, base: { ref: input.base } };
    this.pulls.set(pr.number, pr);
    if (pr.number === 1) this.addRun(pr, 'completed', 'success', 'no_findings');
    else this.addRun(pr, 'in_progress', null, null);
    return pr;
  }
  async closePull(number) { const pr = this.pulls.get(number); if (pr) pr.state = 'closed'; this.closed.push(number); }
  async commit({ branch, file }) {
    const sha = (this.nextCommit++).toString(16).padStart(40, '0');
    this.branches.set(branch, sha);
    const pr = [...this.pulls.values()].find((item) => item.head.ref === branch);
    if (pr) {
      pr.head.sha = sha;
      if (pr.number === 3) {
        this.runs.find((item) => item.pr === 3).status = 'completed';
        this.runs.find((item) => item.pr === 3).conclusion = 'cancelled';
        const other = this.runs.find((item) => item.pr === 2);
        other.status = 'completed'; other.conclusion = 'success';
        this.archives.set(other.id, artifact(other, structuredClone(this.pulls.get(2)), 'no_findings'));
        this.addRun(pr, 'completed', 'success', 'no_findings');
      } else if (pr.number === 2) {
        this.addRun(pr, 'in_progress', null, null);
      } else {
        this.addRun(pr, 'completed', 'success', file ? 'findings' : 'no_findings');
      }
    }
    return sha;
  }
  addRun(pr, status, conclusion, reportStatus) {
    const value = run(this.nextRun++, pr, status, conclusion);
    value.pr = pr.number;
    this.runs.unshift(value);
    if (reportStatus) this.archives.set(value.id, artifact(value, structuredClone(pr), reportStatus));
    return value;
  }
  async workflowRuns() { return structuredClone(this.runs); }
  async artifacts(runId) {
    return this.archives.has(runId) ? [{ id: runId * 10, name: `agent-qa-${this.runs.find((r) => r.id === runId).pr}-${runId}-1`,
      expired: false, workflow_run: { id: runId } }] : [];
  }
  async downloadArtifact(artifactId) { return this.archives.get(artifactId / 10); }
  async comments(prNumber) {
    const pr = this.pulls.get(prNumber);
    const latest = this.runs.find((item) => item.pr === prNumber);
    const status = pr.draft || pr.base.ref === 'develop' ? 'not_applicable'
      : latest.conclusion === 'cancelled' ? 'cancelled'
        : this.archives.has(latest.id) && latest.pr === 1 && latest.id >= 102 ? 'findings' : 'no_findings';
    return [{ id: 7000 + prNumber, user: { login: BOT_LOGIN },
      body: `${COMMENT_MARKER}\n**Status:** ${status}\n**Tested head:** ${pr.head.sha}\n/actions/runs/${latest.id}/attempts/1` }];
  }
  async testsRuns(headSha) { return [{ id: 9000, run_attempt: 1, head_sha: headSha, event: 'pull_request' }]; }
  async jobs(runId) {
    if (runId === 9000) return [{ id: 9001, name: 'Demo Runtime Compose smoke', conclusion: 'skipped' }];
    const value = this.runs.find((item) => item.id === runId);
    if (!value) return [];
    if (value.invalidation) return [{ id: runId * 10, run_id: runId, name: 'Fixture browser QA', status: 'completed', conclusion: 'skipped' }];
    if (value.status === 'in_progress') return [{ id: runId * 10, run_id: runId, name: 'Fixture browser QA', status: 'in_progress', conclusion: null }];
    if (value.conclusion !== 'success') return [];
    const newer = value.pr === 3;
    const started_at = newer ? (this.overlap ? '2026-09-07T00:00:30Z' : '2026-09-07T00:01:00Z') : '2026-09-07T00:00:00Z';
    return [{ id: runId * 10, run_id: this.wrongJobRunId && newer ? runId + 1 : runId,
      name: 'Fixture browser QA', status: 'completed', conclusion: 'success',
      started_at: this.missingAllTimelines ? null : started_at,
      completed_at: this.missingAllTimelines || (this.missingTimeline && newer)
        ? null : newer ? '2026-09-07T00:02:00Z' : '2026-09-07T00:01:00Z' }];
  }
  async file() {
    return '<button className="primary" disabled={props.selectedModel?.ready !== true}>Search gallery';
  }
  async convertToDraft(nodeId) {
    const pr = [...this.pulls.values()].find((item) => item.node_id === nodeId);
    pr.draft = true;
    const value = this.addRun(pr, 'completed', 'success', null); value.invalidation = true;
  }
  async updatePull(number, fields) {
    const pr = this.pulls.get(number);
    if (fields.base) { pr.base.ref = fields.base; const value = this.addRun(pr, 'completed', 'success', null); value.invalidation = true; }
    if (fields.state) pr.state = fields.state;
    return pr;
  }
  async cancelRun(runId) { const value = this.runs.find((item) => item.id === runId); value.status = 'completed'; value.conclusion = 'cancelled'; }
}

module.exports = { CONTROL_SHA, LiveMatrixAdapter };
