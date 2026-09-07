#!/usr/bin/env node
'use strict';

const { runLiveWithSignals } = require('../../verify-live.cjs');
const { LiveMatrixAdapter } = require('./live-adapter.cjs');

const evidence = process.argv[2];
const adapter = new LiveMatrixAdapter();
const createPull = adapter.createPull.bind(adapter);
adapter.createPull = async (input) => {
  const pull = await createPull(input);
  adapter.stalled = true;
  process.stdout.write('READY\n');
  return pull;
};
const workflowRuns = adapter.workflowRuns.bind(adapter);
adapter.workflowRuns = async () => adapter.stalled ? [] : workflowRuns();

runLiveWithSignals({
  adapter,
  repository: 'jayn2u/gods-eye',
  evidence,
  prefix: 'agent-qa-live-1000-abcdef',
  poll: { interval: 60_000 },
}).then((result) => {
  process.stdout.write(`${JSON.stringify({
    status: result.status,
    failure: result.failure,
    cleanup: result.cleanup,
    remaining_branches: [...adapter.branches.keys()],
    open_pulls: [...adapter.pulls.values()].filter(({ state }) => state === 'open').map(({ number }) => number),
  })}\n`);
  process.exitCode = result.status === 'passed' ? 0 : 1;
}, (error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 2;
});
