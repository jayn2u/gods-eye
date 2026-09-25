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
