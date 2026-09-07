'use strict';

const Ajv2020 = require('ajv/dist/2020');
const {
  ContractError,
  LIMITS,
  readBoundedJson,
  validateEvidenceFile,
  validateEvidenceManifest,
} = require('./evidence-contracts.cjs');

const requestSchema = require('./request.schema.json');
const agentResultSchema = require('./agent-result.schema.json');
const reportSchema = require('./report.schema.json');

const SCENARIO_IDS = Object.freeze([
  'search-detail-return',
  'model-provenance',
  'cancel-replace',
  'unprepared-model',
  'recover-409',
  'blank-input',
]);
const REPORT_STATUSES = Object.freeze(['no_findings', 'findings', 'incomplete', 'cancelled']);
const REPORT_REASONS = Object.freeze([
  'none',
  'auth_required',
  'rate_limited',
  'timeout',
  'setup_failed',
  'browser_unavailable',
  'invalid_output',
  'stale',
  'source_changed',
  'runner_failed',
  'permission_lookup_failed',
]);
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(requestSchema);
ajv.addSchema(agentResultSchema);
const validators = Object.freeze({
  request: ajv.getSchema(requestSchema.$id),
  agentResult: ajv.getSchema(agentResultSchema.$id),
  report: ajv.compile(reportSchema),
});

function schemaIssues(errors) {
  return (errors || []).slice(0, 20).map(({ instancePath, keyword }) => ({ instancePath, keyword }));
}

function assertSchema(name, value) {
  const validator = validators[name];
  if (!validator(value)) {
    throw new ContractError(`invalid_${name}`, schemaIssues(validator.errors));
  }
  return value;
}

function assertExactScenarioSet(scenarios, code) {
  const ids = scenarios.map(({ id }) => id);
  if (new Set(ids).size !== SCENARIO_IDS.length || SCENARIO_IDS.some((id) => !ids.includes(id))) {
    throw new ContractError(code);
  }
}

function validateRequest(value) {
  assertSchema('request', value);
  if (!Number.isFinite(Date.parse(value.admitted_at))) {
    throw new ContractError('invalid_request_timestamp');
  }
  return value;
}

function validateAgentResult(value) {
  assertSchema('agentResult', value);
  assertExactScenarioSet(value.scenarios, 'invalid_agentResult_scenarios');
  const scenarioStatus = new Map(value.scenarios.map(({ id, status }) => [id, status]));
  if (value.findings.some(({ scenario_id }) => scenarioStatus.get(scenario_id) !== 'finding')) {
    throw new ContractError('invalid_agentResult_finding');
  }
  if (value.scenarios.some(({ id, status }) => status === 'finding'
      && !value.findings.some(({ scenario_id }) => scenario_id === id))) {
    throw new ContractError('invalid_agentResult_finding');
  }
  return value;
}

function sameRequestIdentity(request, identity) {
  return request.repository === identity.repository
    && request.pr_number === identity.pr_number
    && request.head.repository === identity.head.repository
    && request.head.id === identity.head.id
    && request.head.sha === identity.head.sha
    && request.base.ref === identity.base.ref
    && request.base.sha === identity.base.sha
    && request.controller_sha === identity.controller_sha
    && request.run.id === identity.run.id
    && request.run.attempt === identity.run.attempt
    && request.author === identity.author
    && request.admitted_at === identity.admitted_at;
}

function validateReport(value, expectedRequest) {
  assertSchema('report', value);
  validateRequest(value.request);
  assertExactScenarioSet(value.scenarios, 'invalid_report_scenarios');
  if (expectedRequest && !sameRequestIdentity(expectedRequest, value.request)) {
    throw new ContractError('unexpected_report_identity');
  }
  if (value.tested_head_sha !== value.request.head.sha || value.controller_sha !== value.request.controller_sha) {
    throw new ContractError('invalid_report_identity');
  }
  const started = Date.parse(value.started_at);
  const finished = Date.parse(value.finished_at);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) {
    throw new ContractError('invalid_report_timestamps');
  }
  const evidencePaths = new Set(value.evidence.map(({ path: evidencePath }) => evidencePath));
  const references = [
    ...value.scenarios.flatMap(({ evidence }) => evidence),
    ...value.findings.flatMap(({ evidence }) => evidence),
    ...value.tool_calls.flatMap(({ evidence }) => evidence ? [evidence] : []),
  ];
  if (new Set(value.evidence.map(({ path: evidencePath }) => evidencePath)).size !== value.evidence.length
      || references.some((reference) => !evidencePaths.has(reference))) {
    throw new ContractError('invalid_report_evidence_reference');
  }
  const scenarioStatus = new Map(value.scenarios.map(({ id, status }) => [id, status]));
  if (value.findings.some(({ scenario_id }) => scenarioStatus.get(scenario_id) !== 'finding')
      || value.scenarios.some(({ id, status }) => status === 'finding'
        && !value.findings.some(({ scenario_id }) => scenario_id === id))) {
    throw new ContractError('invalid_report_finding');
  }
  assertReportOutcome(value);
  return value;
}

function assertReportOutcome(report) {
  const failure = report.deterministic_results.find(({ status }) => status === 'failed');
  const incompleteScenario = report.scenarios.some(({ status }) => status === 'incomplete');
  const observedFinding = report.scenarios.some(({ status }) => status === 'finding');
  if ((report.status === 'no_findings' || report.status === 'findings') && report.reason !== 'none') {
    throw new ContractError('invalid_report_reason');
  }
  if (report.status === 'incomplete' && report.reason === 'none') {
    throw new ContractError('invalid_report_reason');
  }
  if (report.status === 'incomplete' && report.reason === 'stale') {
    throw new ContractError('invalid_report_reason');
  }
  if (report.status === 'cancelled' && report.reason !== 'none' && report.reason !== 'stale') {
    throw new ContractError('invalid_report_reason');
  }
  if (report.status === 'no_findings'
      && (report.findings.length > 0
        || observedFinding
        || incompleteScenario
        || failure
        || report.deterministic_results.some(({ status }) => status !== 'passed')
        || !hasCompleteBrowserProof(report))) {
    throw new ContractError('invalid_report_outcome');
  }
  if (report.status === 'findings'
      && report.findings.length === 0
      && !(failure && failure.harness_started && failure.app_started)) {
    throw new ContractError('invalid_report_outcome');
  }
  if (report.status === 'findings' && incompleteScenario) {
    throw new ContractError('invalid_report_outcome');
  }
}

function hasCompleteBrowserProof(report) {
  const screenshotPaths = new Set(
    report.evidence.filter(({ kind }) => kind === 'screenshot').map(({ path: evidencePath }) => evidencePath),
  );
  const interactionTools = new Set([
    'browser_click',
    'browser_type',
    'browser_fill_form',
    'browser_select_option',
    'browser_press_key',
  ]);
  return report.scenarios.every((scenario) => {
    const calls = report.tool_calls.filter(({ scenario_id, status }) => scenario_id === scenario.id && status === 'completed');
    return calls.some(({ tool }) => tool === 'browser_navigate')
      && calls.some(({ tool }) => interactionTools.has(tool))
      && calls.some(({ tool, evidence }) => tool === 'browser_take_screenshot' && screenshotPaths.has(evidence))
      && scenario.evidence.some((evidencePath) => screenshotPaths.has(evidencePath));
  });
}

function deriveReportOutcome(input) {
  if (input.cancelled) return { status: 'cancelled', reason: 'none' };
  if (input.stale) return { status: 'cancelled', reason: 'stale' };
  if (input.infrastructureReason && input.infrastructureReason !== 'none') {
    if (!REPORT_REASONS.includes(input.infrastructureReason)) throw new ContractError('invalid_outcome_reason');
    return { status: 'incomplete', reason: input.infrastructureReason };
  }
  if (!input.evidenceComplete || !input.agentResult) {
    return { status: 'incomplete', reason: 'invalid_output' };
  }
  const deterministicResults = input.deterministicResults || [];
  if (deterministicResults.length === 0 || deterministicResults.some(({ status }) => status === 'not_run')) {
    return { status: 'incomplete', reason: 'setup_failed' };
  }
  const failed = deterministicResults.find(({ status }) => status === 'failed');
  if (failed && (!failed.harness_started || !failed.app_started)) {
    return { status: 'incomplete', reason: 'setup_failed' };
  }
  const hasFinding = Boolean(failed)
    || input.agentResult.findings.length > 0
    || input.agentResult.scenarios.some(({ status }) => status === 'finding');
  if (hasFinding) return { status: 'findings', reason: 'none' };
  if (input.agentResult.scenarios.some(({ status }) => status !== 'observed')) {
    return { status: 'incomplete', reason: 'invalid_output' };
  }
  return { status: 'no_findings', reason: 'none' };
}

module.exports = Object.freeze({
  ContractError,
  LIMITS,
  REPORT_REASONS,
  REPORT_STATUSES,
  SCENARIO_IDS,
  deriveReportOutcome,
  readBoundedJson,
  sameRequestIdentity,
  validateAgentResult,
  validateEvidenceFile,
  validateEvidenceManifest,
  validateReport,
  validateRequest,
});
