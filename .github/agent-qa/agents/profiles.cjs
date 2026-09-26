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

const PROFILES = Object.freeze({
  copilot: define('copilot', 'Copilot'),
  claude: define('claude', 'Claude'),
});
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
