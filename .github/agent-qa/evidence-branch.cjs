'use strict';

/**
 * Publish accepted screenshots to a dedicated orphan branch so a reviewer can see them in the pull
 * request instead of downloading and unzipping an artifact.
 *
 * Trust notes, because this is the one part of Agent QA that writes to the repository:
 *
 *  - Only the reporter's own job calls this, from control code checked out at `github.workflow_sha`.
 *    Candidate code never runs in that job and never reaches this module.
 *  - The bytes come from a report whose evidence manifest has already been validated by size and
 *    sha256, so every file here is a PNG the harness itself accepted as proof.
 *  - The evidence branch named by the run's Agent Profile is an orphan with no relationship to any
 *    source branch, every path is composed here from integers and a scenario id matched against a
 *    strict pattern, and nothing outside
 *    `pr-<number>/` for the pull request being published is ever added or removed.
 */

const { PROFILES } = require('./agents/profiles.cjs');
const SCENARIO_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const MAX_FILES = 12;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class EvidenceBranchError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'EvidenceBranchError';
    this.code = code;
  }
}

function apiMethod(github, group, method) {
  const candidate = github?.rest?.[group]?.[method];
  if (typeof candidate !== 'function') {
    throw new EvidenceBranchError('invalid_github_client', `missing rest.${group}.${method}`);
  }
  return candidate;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isNotFound(error) {
  return error?.status === 404;
}

/** `pr-42/1234-1/blank-input.png` — every segment is an integer or a pattern-checked scenario id. */
function evidencePath({ prNumber, runId, runAttempt, scenarioId }) {
  if (!positiveInteger(prNumber) || !positiveInteger(runId) || !positiveInteger(runAttempt)) {
    throw new EvidenceBranchError('invalid_identity', 'evidence path requires positive integer identity');
  }
  if (typeof scenarioId !== 'string' || !SCENARIO_PATTERN.test(scenarioId)) {
    throw new EvidenceBranchError('invalid_scenario_id', 'evidence path requires a simple scenario id');
  }
  return `pr-${prNumber}/${runId}-${runAttempt}/${scenarioId}.png`;
}

function evidenceUrl(repository, branch, filePath) {
  return `https://github.com/${repository}/blob/${branch}/${filePath}?raw=true`;
}

function checkScreenshots(screenshots) {
  if (!Array.isArray(screenshots) || screenshots.length === 0) {
    throw new EvidenceBranchError('no_screenshots', 'nothing to publish');
  }
  if (screenshots.length > MAX_FILES) {
    throw new EvidenceBranchError('too_many_screenshots', `at most ${MAX_FILES} screenshots may be published`);
  }
  let total = 0;
  for (const item of screenshots) {
    if (!Buffer.isBuffer(item?.contents) || item.contents.length === 0) {
      throw new EvidenceBranchError('invalid_screenshot', 'screenshot contents must be non-empty bytes');
    }
    if (!item.contents.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
      throw new EvidenceBranchError('invalid_screenshot', 'screenshot is not a PNG');
    }
    total += item.contents.length;
  }
  if (total > MAX_TOTAL_BYTES) {
    throw new EvidenceBranchError('oversized_screenshots', 'screenshots exceed the publication budget');
  }
}

async function readHead(github, owner, repo, ref) {
  try {
    const response = await apiMethod(github, 'git', 'getRef')({ owner, repo, ref });
    const commitSha = response?.data?.object?.sha;
    if (typeof commitSha !== 'string' || !/^[0-9a-f]{40}$/u.test(commitSha)) {
      throw new EvidenceBranchError('invalid_ref', 'evidence branch ref is malformed');
    }
    const commit = await apiMethod(github, 'git', 'getCommit')({ owner, repo, commit_sha: commitSha });
    const treeSha = commit?.data?.tree?.sha;
    if (typeof treeSha !== 'string' || !/^[0-9a-f]{40}$/u.test(treeSha)) {
      throw new EvidenceBranchError('invalid_ref', 'evidence branch commit has no tree');
    }
    return { commitSha, treeSha };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * Older generations of the same pull request are removed as part of the same commit, so the branch
 * holds one directory per open pull request rather than one per push. Other pull requests' paths are
 * never listed as deletions.
 */
async function stalePathsForPullRequest(github, owner, repo, treeSha, prNumber, keepPrefix) {
  const response = await apiMethod(github, 'git', 'getTree')({
    owner, repo, tree_sha: treeSha, recursive: '1',
  });
  if (response?.data?.truncated === true) return [];
  const entries = Array.isArray(response?.data?.tree) ? response.data.tree : [];
  const prefix = `pr-${prNumber}/`;
  return entries
    .filter((entry) => entry?.type === 'blob'
      && typeof entry.path === 'string'
      && entry.path.startsWith(prefix)
      && !entry.path.startsWith(keepPrefix))
    .map((entry) => entry.path);
}

async function createTree(github, owner, repo, baseTree, files, deletions) {
  const tree = [
    ...files.map((file) => ({ path: file.path, mode: '100644', type: 'blob', sha: file.blobSha })),
    ...deletions.map((path) => ({ path, mode: '100644', type: 'blob', sha: null })),
  ];
  const response = await apiMethod(github, 'git', 'createTree')({
    owner, repo, tree, ...(baseTree ? { base_tree: baseTree } : {}),
  });
  const sha = response?.data?.sha;
  if (typeof sha !== 'string') throw new EvidenceBranchError('tree_write_failed', 'tree creation returned no sha');
  return sha;
}

/**
 * @param {object} input
 * @param {object} input.github authenticated Octokit-shaped client with `contents: write`
 * @param {string} input.repository `owner/repo`
 * @param {string} input.branch Agent Profile evidence branch
 * @param {number} input.prNumber pull request the evidence belongs to
 * @param {number} input.runId QA run that produced it
 * @param {number} input.runAttempt attempt of that run
 * @param {{scenarioId: string, contents: Buffer}[]} input.screenshots accepted proof only
 * @returns {Promise<{branch: string, commitSha: string, files: {scenario_id: string, path: string, url: string}[]}>}
 */
async function publishScreenshots({ github, repository, branch, prNumber, runId, runAttempt, screenshots }) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(repository)) {
    throw new EvidenceBranchError('invalid_repository', 'repository must be owner/repo');
  }
  const profile = Object.values(PROFILES).find((candidate) => candidate.evidenceBranch === branch);
  if (!profile) throw new EvidenceBranchError('invalid_branch', 'branch must be declared by an Agent Profile');
  const ref = `heads/${branch}`;
  checkScreenshots(screenshots);
  const [owner, repo] = repository.split('/');
  const keepPrefix = `pr-${prNumber}/${runId}-${runAttempt}/`;
  const planned = screenshots.map((item) => ({
    scenarioId: item.scenarioId,
    path: evidencePath({ prNumber, runId, runAttempt, scenarioId: item.scenarioId }),
    contents: item.contents,
  }));

  const files = [];
  for (const item of planned) {
    const blob = await apiMethod(github, 'git', 'createBlob')({
      owner, repo, content: item.contents.toString('base64'), encoding: 'base64',
    });
    const blobSha = blob?.data?.sha;
    if (typeof blobSha !== 'string') throw new EvidenceBranchError('blob_write_failed', 'blob creation returned no sha');
    files.push({ scenarioId: item.scenarioId, path: item.path, blobSha });
  }

  // One retry only, and it re-reads the head first: a concurrent publication for a different pull
  // request moves the ref, and losing that race must not drop the other one's commit.
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const head = await readHead(github, owner, repo, ref);
    const deletions = head
      ? await stalePathsForPullRequest(github, owner, repo, head.treeSha, prNumber, keepPrefix)
      : [];
    const treeSha = await createTree(github, owner, repo, head?.treeSha ?? null, files, deletions);
    const commit = await apiMethod(github, 'git', 'createCommit')({
      owner,
      repo,
      message: `${profile.title.replace(' (advisory)', '')} evidence for PR #${prNumber} run ${runId} attempt ${runAttempt}`,
      tree: treeSha,
      parents: head ? [head.commitSha] : [],
    });
    const commitSha = commit?.data?.sha;
    if (typeof commitSha !== 'string') throw new EvidenceBranchError('commit_write_failed', 'commit creation returned no sha');
    try {
      if (head) {
        await apiMethod(github, 'git', 'updateRef')({
          owner, repo, ref, sha: commitSha, force: false,
        });
      } else {
        await apiMethod(github, 'git', 'createRef')({
          owner, repo, ref: `refs/${ref}`, sha: commitSha,
        });
      }
      return Object.freeze({
        branch,
        commitSha,
        files: files.map((file) => Object.freeze({
          scenario_id: file.scenarioId,
          path: file.path,
          url: evidenceUrl(repository, branch, file.path),
        })),
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw new EvidenceBranchError('ref_update_failed', 'could not advance the evidence branch', { cause: lastError });
}

module.exports = Object.freeze({
  EvidenceBranchError,
  MAX_FILES,
  MAX_TOTAL_BYTES,
  evidencePath,
  evidenceUrl,
  publishScreenshots,
});
