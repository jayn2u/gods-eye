const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const test = require('node:test');

const workflowPath = join(__dirname, '..', '..', 'workflows', 'tests.yml');
const suiteBaseline = {
  name: 'Unit and integration suite',
  'runs-on': 'ubuntu-24.04',
  'timeout-minutes': 20,
  steps: [
    { uses: 'actions/checkout@v4' },
    { uses: 'astral-sh/setup-uv@v5', with: { 'enable-cache': true } },
    { name: 'Install the test environment', run: 'uv sync --frozen --extra indexing' },
    { name: 'Run the suite', run: 'uv run --extra indexing pytest -q -rs' },
  ],
};

function parseWorkflow() {
  const parse = spawnSync(
    'ruby',
    ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.safe_load(STDIN.read, aliases: false))'],
    { encoding: 'utf8', input: readFileSync(workflowPath, 'utf8') },
  );

  assert.equal(parse.status, 0, `Ruby YAML parser failed: ${parse.stderr}`);
  return JSON.parse(parse.stdout);
}

function runsForEvent(predicate, eventName) {
  assert.equal(predicate, "github.event_name != 'pull_request'");
  return eventName !== 'pull_request';
}

test('Compose smoke skips pull requests and remains enabled for the configured develop push', () => {
  const workflow = parseWorkflow();
  const jobs = workflow.jobs;
  const compose = jobs['compose-smoke'];

  assert.equal(compose.if, "github.event_name != 'pull_request'");
  assert.equal(runsForEvent(compose.if, 'pull_request'), false);
  assert.equal(runsForEvent(compose.if, 'push'), true);
  assert.deepEqual(workflow.true.push.branches, ['develop']);
  assert.deepEqual(workflow.true.pull_request, null);
});

test('the Python suite retains its current job configuration', () => {
  const workflow = parseWorkflow();

  assert.deepEqual(workflow.jobs.suite, suiteBaseline);
});
