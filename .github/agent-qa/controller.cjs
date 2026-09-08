'use strict';

const { validateRequest } = require('./contracts.cjs');

const EXPECTED_REPOSITORY = 'jayn2u/gods-eye';
const AGENT_QA_WORKFLOW = 'agent-qa.yml';
const AGENT_QA_WORKFLOW_NAME = 'Agent QA';
const AGENT_QA_WORKFLOW_PATH = `.github/workflows/${AGENT_QA_WORKFLOW}`;
const RELEASE_BASE_PATTERN = /^release\/[^/]+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const RUN_NAME_PATTERN = /^Agent QA PR #([1-9][0-9]*) head ([0-9a-f]{40})$/;
const PAGE_SIZE = 100;

class ControllerError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'ControllerError';
    this.code = code;
  }
}

function splitExpectedRepository(repository) {
  if (repository !== EXPECTED_REPOSITORY) {
    throw new ControllerError(
      'invalid_repository',
      `repository must be ${EXPECTED_REPOSITORY}`,
    );
  }
  return { owner: 'jayn2u', repo: 'gods-eye' };
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isSha(value) {
  return typeof value === 'string' && SHA_PATTERN.test(value);
}

function formatRunName({ prNumber, headSha }) {
  if (!isPositiveInteger(prNumber) || !isSha(headSha)) {
    throw new ControllerError('invalid_run_identity', 'invalid PR number or head SHA');
  }
  return `${AGENT_QA_WORKFLOW_NAME} PR #${prNumber} head ${headSha}`;
}

function parseRunName(displayTitle) {
  if (typeof displayTitle !== 'string') {
    return null;
  }
  const match = RUN_NAME_PATTERN.exec(displayTitle);
  if (!match) {
    return null;
  }
  const prNumber = Number(match[1]);
  if (!isPositiveInteger(prNumber)) {
    return null;
  }
  return Object.freeze({ prNumber, headSha: match[2] });
}

function parseWorkflowRunIdentity(run) {
  if (!run || typeof run !== 'object' || typeof run.name !== 'string'
      || run.name !== run.display_title) {
    return null;
  }
  return parseRunName(run.name);
}

function isTrustedWorkflowPath(value) {
  return value === AGENT_QA_WORKFLOW_PATH
    || (typeof value === 'string' && value.startsWith(`${AGENT_QA_WORKFLOW_PATH}@`)
      && value.length > AGENT_QA_WORKFLOW_PATH.length + 1);
}

function apiMethod(github, group, method) {
  const candidate = github?.rest?.[group]?.[method];
  if (typeof candidate !== 'function') {
    throw new ControllerError(
      'invalid_github_client',
      `GitHub client does not provide rest.${group}.${method}`,
    );
  }
  return candidate;
}

function result(status, reason, request) {
  const value = { status, reason };
  if (request !== undefined) {
    value.request = request;
  }
  return Object.freeze(value);
}

function validateAdmissionInput(input) {
  try {
    if (!input || typeof input !== 'object') {
      throw new ControllerError('invalid_input', 'admission input must be an object');
    }
    const repositoryParts = splitExpectedRepository(input.repository);
    if (
      !isPositiveInteger(input.pullNumber) ||
      !isSha(input.eventHeadSha) ||
      !isSha(input.controllerSha) ||
      !isPositiveInteger(input.runId) ||
      !isPositiveInteger(input.runAttempt) ||
      typeof input.admittedAt !== 'string' ||
      !Number.isFinite(Date.parse(input.admittedAt))
    ) {
      throw new ControllerError('invalid_input', 'invalid typed admission input');
    }
    return repositoryParts;
  } catch (error) {
    if (error instanceof ControllerError) {
      return null;
    }
    throw error;
  }
}

async function fetchRepository(github, owner, repo) {
  return apiMethod(github, 'repos', 'get')({ owner, repo });
}

async function fetchPullRequest(github, owner, repo, pullNumber) {
  return apiMethod(github, 'pulls', 'get')({
    owner,
    repo,
    pull_number: pullNumber,
  });
}

async function fetchAuthorPermission(github, owner, repo, author) {
  return apiMethod(github, 'repos', 'getCollaboratorPermissionLevel')({
    owner,
    repo,
    username: author,
  });
}

function repositoryRejection(repository) {
  if (!repository || repository.full_name !== EXPECTED_REPOSITORY) {
    return 'repository_mismatch';
  }
  if (repository.private !== true) {
    return 'repository_not_private';
  }
  return null;
}

function pullRequestRejection(pullRequest, pullNumber, expectedIdentity) {
  if (!pullRequest || pullRequest.number !== pullNumber) {
    return 'pull_request_malformed';
  }
  if (pullRequest.state !== 'open') {
    return 'pull_request_closed';
  }
  if (pullRequest.draft !== false) {
    return 'pull_request_draft';
  }
  if (!pullRequest.base || !RELEASE_BASE_PATTERN.test(pullRequest.base.ref)) {
    return 'base_not_release';
  }
  if (!isSha(pullRequest.base.sha)) {
    return 'pull_request_malformed';
  }
  if (
    expectedIdentity.baseRef !== undefined &&
    (pullRequest.base.ref !== expectedIdentity.baseRef ||
      pullRequest.base.sha !== expectedIdentity.baseSha)
  ) {
    return 'source_changed';
  }
  if (
    !pullRequest.head ||
    !pullRequest.head.repo ||
    typeof pullRequest.head.repo.full_name !== 'string' ||
    pullRequest.head.repo.full_name.length === 0 ||
    !isPositiveInteger(pullRequest.head.repo.id) ||
    !isSha(pullRequest.head.sha) ||
    !pullRequest.user ||
    typeof pullRequest.user.login !== 'string' ||
    pullRequest.user.login.length === 0
  ) {
    return 'pull_request_malformed';
  }
  if (pullRequest.head.sha !== expectedIdentity.headSha) {
    return 'source_changed';
  }
  if (
    expectedIdentity.headRepository !== undefined &&
    (pullRequest.head.repo.full_name !== expectedIdentity.headRepository ||
      pullRequest.head.repo.id !== expectedIdentity.headRepositoryId ||
      pullRequest.user.login !== expectedIdentity.author)
  ) {
    return 'source_changed';
  }
  return null;
}

function permissionIsWriteEquivalent(permissionResponse) {
  const permission = permissionResponse?.permission;
  return permission === 'write' || permission === 'admin';
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

async function assessPullRequest(input, expectedIdentity) {
  const repositoryParts = validateAdmissionInput(input);
  if (!repositoryParts) {
    return result('incomplete', 'invalid_input');
  }
  const { owner, repo } = repositoryParts;

  let repositoryResponse;
  try {
    repositoryResponse = await fetchRepository(input.github, owner, repo);
  } catch {
    return result('incomplete', 'repository_lookup_failed');
  }
  const repositoryReason = repositoryRejection(repositoryResponse?.data);
  if (repositoryReason) {
    return result('skipped', repositoryReason);
  }

  let pullResponse;
  try {
    pullResponse = await fetchPullRequest(input.github, owner, repo, input.pullNumber);
  } catch {
    return result('incomplete', 'pull_request_lookup_failed');
  }
  const pullRequest = pullResponse?.data;
  const pullReason = pullRequestRejection(pullRequest, input.pullNumber, expectedIdentity);
  if (pullReason) {
    return result('skipped', pullReason);
  }

  let permissionResponse;
  try {
    permissionResponse = await fetchAuthorPermission(
      input.github,
      owner,
      repo,
      pullRequest.user.login,
    );
  } catch {
    return result('incomplete', 'permission_lookup_failed');
  }
  if (!permissionIsWriteEquivalent(permissionResponse?.data)) {
    return result('skipped', 'permission_insufficient');
  }

  const request = {
    schema_version: 1,
    repository: EXPECTED_REPOSITORY,
    pr_number: pullRequest.number,
    head: {
      repository: pullRequest.head.repo.full_name,
      id: pullRequest.head.repo.id,
      sha: pullRequest.head.sha,
    },
    base: { ref: pullRequest.base.ref, sha: pullRequest.base.sha },
    controller_sha: input.controllerSha,
    run: { id: input.runId, attempt: input.runAttempt },
    author: pullRequest.user.login,
    admitted_at: input.admittedAt,
  };

  try {
    validateRequest(request);
  } catch {
    return result('incomplete', 'request_validation_failed');
  }
  return result('admitted', 'eligible', deepFreeze(request));
}

async function admitPullRequest(input) {
  return assessPullRequest(input, { headSha: input?.eventHeadSha });
}

async function recheckPullRequest({ github, request }) {
  try {
    validateRequest(request);
  } catch {
    return result('incomplete', 'invalid_request');
  }
  const input = {
    github,
    repository: request.repository,
    pullNumber: request.pr_number,
    eventHeadSha: request.head.sha,
    controllerSha: request.controller_sha,
    runId: request.run.id,
    runAttempt: request.run.attempt,
    admittedAt: request.admitted_at,
  };
  const checked = await assessPullRequest(input, {
    headSha: request.head.sha,
    headRepository: request.head.repository,
    headRepositoryId: request.head.id,
    baseRef: request.base.ref,
    baseSha: request.base.sha,
    author: request.author,
  });
  if (checked.status !== 'admitted') {
    return checked;
  }
  return result('admitted', 'eligible', request);
}

function runGeneration(run) {
  if (!isPositiveInteger(run?.id) || !isPositiveInteger(run?.run_attempt)) {
    return null;
  }
  return { id: run.id, attempt: run.run_attempt };
}

function compareGenerations(left, right) {
  const leftGeneration = runGeneration(left);
  const rightGeneration = runGeneration(right);
  if (!leftGeneration || !rightGeneration) {
    throw new ControllerError('invalid_run_generation', 'run id and attempt must be positive integers');
  }
  return leftGeneration.id === rightGeneration.id
    ? leftGeneration.attempt - rightGeneration.attempt
    : leftGeneration.id - rightGeneration.id;
}

function selectLatestGeneration(runs, identity) {
  formatRunName(identity);
  if (!Array.isArray(runs)) {
    throw new ControllerError('invalid_workflow_runs', 'workflow runs must be an array');
  }
  let latest = null;
  for (const run of runs) {
    const parsed = parseWorkflowRunIdentity(run);
    if (
      run?.event !== 'pull_request_target' ||
      run?.repository?.full_name !== EXPECTED_REPOSITORY ||
      !isTrustedWorkflowPath(run?.path) ||
      !parsed ||
      parsed.prNumber !== identity.prNumber ||
      parsed.headSha !== identity.headSha ||
      !runGeneration(run)
    ) {
      continue;
    }
    if (latest === null || compareGenerations(run, latest) > 0) {
      latest = run;
    }
  }
  return latest;
}

async function listCorrelatedWorkflowRuns({
  github,
  repository = EXPECTED_REPOSITORY,
  workflowId = AGENT_QA_WORKFLOW,
  prNumber,
  headSha,
}) {
  const { owner, repo } = splitExpectedRepository(repository);
  const identity = { prNumber, headSha };
  formatRunName(identity);
  if (workflowId !== AGENT_QA_WORKFLOW) {
    throw new ControllerError('invalid_workflow', `workflow must be ${AGENT_QA_WORKFLOW}`);
  }
  const listWorkflowRuns = apiMethod(github, 'actions', 'listWorkflowRuns');
  const matching = [];
  for (let page = 1; ; page += 1) {
    let response;
    try {
      response = await listWorkflowRuns({
        owner,
        repo,
        workflow_id: workflowId,
        event: 'pull_request_target',
        per_page: PAGE_SIZE,
        page,
      });
    } catch (error) {
      throw new ControllerError(
        'workflow_runs_lookup_failed',
        'failed to list trusted Agent QA workflow runs',
        { cause: error },
      );
    }
    const pageRuns = response?.data?.workflow_runs;
    if (!Array.isArray(pageRuns)) {
      throw new ControllerError(
        'workflow_runs_lookup_failed',
        'GitHub returned a malformed workflow-runs page',
      );
    }
    for (const run of pageRuns) {
      if (selectLatestGeneration([run], identity) !== null) {
        matching.push(run);
      }
    }
    if (pageRuns.length < PAGE_SIZE) {
      return matching;
    }
  }
}

async function findLatestGeneration(input) {
  const runs = await listCorrelatedWorkflowRuns(input);
  return selectLatestGeneration(runs, {
    prNumber: input.prNumber,
    headSha: input.headSha,
  });
}

function isLatestGeneration(currentRun, latestRun) {
  if (latestRun === null) {
    return false;
  }
  return compareGenerations(currentRun, latestRun) === 0;
}

module.exports = {
  AGENT_QA_WORKFLOW,
  AGENT_QA_WORKFLOW_NAME,
  AGENT_QA_WORKFLOW_PATH,
  ControllerError,
  EXPECTED_REPOSITORY,
  RELEASE_BASE_PATTERN,
  admitPullRequest,
  compareGenerations,
  findLatestGeneration,
  formatRunName,
  isLatestGeneration,
  isTrustedWorkflowPath,
  listCorrelatedWorkflowRuns,
  parseRunName,
  parseWorkflowRunIdentity,
  recheckPullRequest,
  selectLatestGeneration,
};
