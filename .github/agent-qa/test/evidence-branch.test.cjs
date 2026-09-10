'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  EVIDENCE_BRANCH,
  EvidenceBranchError,
  MAX_FILES,
  evidencePath,
  evidenceUrl,
  publishScreenshots,
} = require('../evidence-branch.cjs');

const REPOSITORY = 'jayn2u/gods-eye';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function sha(seed) {
  return seed.toString(16).padStart(40, '0');
}

/**
 * A Git Data API double that keeps just enough state to observe what a publication actually writes:
 * which blobs were created, which paths a tree added or deleted, and how the ref moved.
 */
function fakeGithub({ existingTree = null, refRaces = 0 } = {}) {
  const state = {
    blobs: [], trees: [], commits: [], refUpdates: [], refCreates: [],
    head: existingTree ? { commitSha: sha(1), treeSha: sha(2) } : null,
    tree: existingTree ?? [],
    truncated: false,
    races: refRaces,
  };
  let counter = 10;
  const nextSha = () => sha((counter += 1));
  const github = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          assert.equal(ref, `heads/${EVIDENCE_BRANCH}`);
          if (!state.head) {
            const error = new Error('Not Found');
            error.status = 404;
            throw error;
          }
          return { data: { object: { sha: state.head.commitSha } } };
        },
        getCommit: async ({ commit_sha: commitSha }) => {
          assert.equal(commitSha, state.head.commitSha);
          return { data: { tree: { sha: state.head.treeSha } } };
        },
        getTree: async ({ tree_sha: treeSha, recursive }) => {
          assert.equal(recursive, '1');
          assert.equal(treeSha, state.head.treeSha);
          return { data: { tree: state.tree, truncated: state.truncated } };
        },
        createBlob: async ({ content, encoding }) => {
          assert.equal(encoding, 'base64');
          state.blobs.push(Buffer.from(content, 'base64'));
          return { data: { sha: nextSha() } };
        },
        createTree: async ({ tree, base_tree: baseTree }) => {
          state.trees.push({ tree, baseTree: baseTree ?? null });
          return { data: { sha: nextSha() } };
        },
        createCommit: async ({ tree, parents, message }) => {
          state.commits.push({ tree, parents, message });
          return { data: { sha: nextSha() } };
        },
        updateRef: async ({ sha: commitSha, force }) => {
          assert.equal(force, false);
          if (state.races > 0) {
            state.races -= 1;
            const error = new Error('Update is not a fast forward');
            error.status = 422;
            throw error;
          }
          state.refUpdates.push(commitSha);
          return { data: {} };
        },
        createRef: async ({ ref, sha: commitSha }) => {
          state.refCreates.push({ ref, commitSha });
          return { data: {} };
        },
      },
    },
  };
  return { github, state };
}

function screenshots(ids) {
  return ids.map((scenarioId) => ({ scenarioId, contents: PNG }));
}

test('Given a run identity, when a path is composed, then every segment is machine-generated', () => {
  assert.equal(
    evidencePath({ prNumber: 42, runId: 987, runAttempt: 2, scenarioId: 'blank-input' }),
    'pr-42/987-2/blank-input.png',
  );
  assert.equal(
    evidenceUrl(REPOSITORY, 'pr-42/987-2/blank-input.png'),
    `https://github.com/${REPOSITORY}/blob/${EVIDENCE_BRANCH}/pr-42/987-2/blank-input.png?raw=true`,
  );
});

test('Given a scenario id that could escape its directory, when a path is composed, then it is refused', () => {
  for (const scenarioId of ['../etc', 'a/b', 'UPPER', '', '.hidden', 'x'.repeat(65)]) {
    assert.throws(
      () => evidencePath({ prNumber: 1, runId: 1, runAttempt: 1, scenarioId }),
      (error) => error instanceof EvidenceBranchError && error.code === 'invalid_scenario_id',
      `scenario id ${JSON.stringify(scenarioId)} must be refused`,
    );
  }
  for (const identity of [{ prNumber: 0 }, { prNumber: -3 }, { runId: 1.5 }, { runAttempt: 0 }]) {
    assert.throws(
      () => evidencePath({ prNumber: 1, runId: 1, runAttempt: 1, ...identity, scenarioId: 'ok' }),
      (error) => error.code === 'invalid_identity',
    );
  }
});

test('Given no existing branch, when screenshots publish, then an orphan commit creates it', async () => {
  const { github, state } = fakeGithub();
  const published = await publishScreenshots({
    github, repository: REPOSITORY, prNumber: 7, runId: 100, runAttempt: 1,
    screenshots: screenshots(['blank-input', 'recover-409']),
  });
  assert.equal(state.blobs.length, 2);
  assert.equal(state.trees[0].baseTree, null);
  // No parent: the evidence branch must not share history with any source branch.
  assert.deepEqual(state.commits[0].parents, []);
  assert.equal(state.refCreates.length, 1);
  assert.equal(state.refCreates[0].ref, `refs/heads/${EVIDENCE_BRANCH}`);
  assert.deepEqual(published.files.map((file) => file.path), [
    'pr-7/100-1/blank-input.png', 'pr-7/100-1/recover-409.png',
  ]);
  assert.equal(published.branch, EVIDENCE_BRANCH);
});

test('Given earlier generations, when a newer one publishes, then only this PR\'s older paths are removed', async () => {
  const { github, state } = fakeGithub({
    existingTree: [
      { type: 'blob', path: 'pr-7/90-1/blank-input.png' },
      { type: 'blob', path: 'pr-7/90-1/recover-409.png' },
      { type: 'blob', path: 'pr-7/100-1/blank-input.png' },
      { type: 'blob', path: 'pr-8/95-1/blank-input.png' },
      { type: 'tree', path: 'pr-7/90-1' },
    ],
  });
  await publishScreenshots({
    github, repository: REPOSITORY, prNumber: 7, runId: 100, runAttempt: 1,
    screenshots: screenshots(['blank-input']),
  });
  const written = state.trees[0];
  assert.equal(written.baseTree, sha(2));
  const deletions = written.tree.filter((entry) => entry.sha === null).map((entry) => entry.path);
  assert.deepEqual(deletions.sort(), ['pr-7/90-1/blank-input.png', 'pr-7/90-1/recover-409.png']);
  // Another pull request's evidence and this run's own directory both survive.
  assert.equal(deletions.some((path) => path.startsWith('pr-8/')), false);
  assert.equal(deletions.includes('pr-7/100-1/blank-input.png'), false);
  assert.deepEqual(state.commits[0].parents, [sha(1)]);
});

test('Given a truncated tree listing, when publishing, then nothing is deleted', async () => {
  const { github, state } = fakeGithub({ existingTree: [{ type: 'blob', path: 'pr-7/90-1/x.png' }] });
  state.truncated = true;
  await publishScreenshots({
    github, repository: REPOSITORY, prNumber: 7, runId: 100, runAttempt: 1,
    screenshots: screenshots(['blank-input']),
  });
  assert.equal(state.trees[0].tree.some((entry) => entry.sha === null), false);
});

test('Given a concurrent publication, when the ref moves, then the commit is rebuilt once and retried', async () => {
  const { github, state } = fakeGithub({ existingTree: [], refRaces: 1 });
  await publishScreenshots({
    github, repository: REPOSITORY, prNumber: 7, runId: 100, runAttempt: 1,
    screenshots: screenshots(['blank-input']),
  });
  assert.equal(state.commits.length, 2, 'the losing attempt must not be reused');
  assert.equal(state.refUpdates.length, 1);
  // Blobs are uploaded once; only the tree and commit are rebuilt on the re-read head.
  assert.equal(state.blobs.length, 1);
});

test('Given a ref that keeps moving, when both attempts lose, then publication fails loudly', async () => {
  const { github } = fakeGithub({ existingTree: [], refRaces: 5 });
  await assert.rejects(
    publishScreenshots({
      github, repository: REPOSITORY, prNumber: 7, runId: 100, runAttempt: 1,
      screenshots: screenshots(['blank-input']),
    }),
    (error) => error instanceof EvidenceBranchError && error.code === 'ref_update_failed',
  );
});

test('Given content that is not an accepted screenshot, when publishing, then it never reaches a blob', async () => {
  const cases = [
    [[], 'no_screenshots'],
    [screenshots(Array.from({ length: MAX_FILES + 1 }, (_, index) => `s${index}`)), 'too_many_screenshots'],
    [[{ scenarioId: 'blank-input', contents: Buffer.from('GIF89a') }], 'invalid_screenshot'],
    [[{ scenarioId: 'blank-input', contents: Buffer.alloc(0) }], 'invalid_screenshot'],
    [[{ scenarioId: 'blank-input', contents: 'not bytes' }], 'invalid_screenshot'],
  ];
  for (const [payload, code] of cases) {
    const { github, state } = fakeGithub();
    await assert.rejects(
      publishScreenshots({
        github, repository: REPOSITORY, prNumber: 7, runId: 100, runAttempt: 1, screenshots: payload,
      }),
      (error) => error instanceof EvidenceBranchError && error.code === code,
      `expected ${code}`,
    );
    assert.equal(state.blobs.length, 0);
  }
});

test('Given a repository that is not owner/repo, when publishing, then it is refused before any call', async () => {
  const { github, state } = fakeGithub();
  await assert.rejects(
    publishScreenshots({
      github, repository: 'https://example.invalid/evil', prNumber: 7, runId: 1, runAttempt: 1,
      screenshots: screenshots(['blank-input']),
    }),
    (error) => error.code === 'invalid_repository',
  );
  assert.equal(state.blobs.length, 0);
});
