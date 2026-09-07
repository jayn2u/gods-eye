'use strict';

const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { inflateRawSync, crc32 } = require('node:zlib');

const {
  LIMITS,
  readBoundedJson,
  validateEvidenceManifest,
  validateReport,
} = require('./contracts.cjs');
const {
  AGENT_QA_WORKFLOW,
  AGENT_QA_WORKFLOW_NAME,
  EXPECTED_REPOSITORY,
  admitPullRequest,
  findLatestGeneration,
  isLatestGeneration,
  parseRunName,
  recheckPullRequest,
} = require('./controller.cjs');

const COMMENT_MARKER = '<!-- gods-eye-agent-qa:v1 -->';
const BOT_LOGIN = 'github-actions[bot]';
const WORKFLOW_PATH = `.github/workflows/${AGENT_QA_WORKFLOW}`;
const PAGE_SIZE = 100;
const MAX_ENTRIES = 250;
const MAX_COMMENT_BYTES = 60 * 1024;
const ZIP_EOCD = 0x06054b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;

class ReporterError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'ReporterError';
    this.code = code;
  }
}

function result(status, reason, values = {}) {
  return Object.freeze({ status, reason, ...values });
}

function splitRepository(repository) {
  if (repository !== EXPECTED_REPOSITORY) {
    throw new ReporterError('repository_mismatch', `repository must be ${EXPECTED_REPOSITORY}`);
  }
  return { owner: 'jayn2u', repo: 'gods-eye' };
}

function apiMethod(github, group, method) {
  const candidate = github?.rest?.[group]?.[method];
  if (typeof candidate !== 'function') {
    throw new ReporterError('invalid_github_client', `missing rest.${group}.${method}`);
  }
  return candidate;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isTrustedWorkflowPath(value) {
  return value === WORKFLOW_PATH
    || (typeof value === 'string'
      && value.startsWith(`${WORKFLOW_PATH}@`)
      && value.length > WORKFLOW_PATH.length + 1);
}

function safeArchivePath(name) {
  return typeof name === 'string'
    && Buffer.byteLength(name) <= LIMITS.relativePathBytes
    && name.length > 0
    && !path.posix.isAbsolute(name)
    && !path.win32.isAbsolute(name)
    && !name.includes('\\')
    && !/[\u0000-\u001f\u007f]/u.test(name)
    && name.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function findEndOfCentralDirectory(archive) {
  const minimum = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === ZIP_EOCD) return offset;
  }
  throw new ReporterError('invalid_zip', 'ZIP end-of-central-directory record is missing');
}

function parseArchiveEntries(archive) {
  if (!Buffer.isBuffer(archive) || archive.length < 22 || archive.length > LIMITS.artifactBytes) {
    throw new ReporterError('oversized_artifact', 'artifact archive is empty or exceeds 100 MiB');
  }
  const eocd = findEndOfCentralDirectory(archive);
  const disk = archive.readUInt16LE(eocd + 4);
  const centralDisk = archive.readUInt16LE(eocd + 6);
  const diskEntries = archive.readUInt16LE(eocd + 8);
  const entryCount = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  const commentLength = archive.readUInt16LE(eocd + 20);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount
      || entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff
      || entryCount < 1 || entryCount > MAX_ENTRIES
      || eocd + 22 + commentLength !== archive.length
      || centralOffset + centralSize !== eocd) {
    throw new ReporterError('unsupported_zip', 'multi-disk, ZIP64, malformed, or oversized-entry ZIP rejected');
  }

  const entries = [];
  const names = new Set();
  let expandedBytes = 0;
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocd || archive.readUInt32LE(cursor) !== ZIP_CENTRAL) {
      throw new ReporterError('invalid_zip', 'malformed central-directory entry');
    }
    const madeBy = archive.readUInt16LE(cursor + 4);
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const expectedCrc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const entryCommentLength = archive.readUInt16LE(cursor + 32);
    const startDisk = archive.readUInt16LE(cursor + 34);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + entryCommentLength;
    if (end > eocd || nameLength === 0 || startDisk !== 0
        || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff
        || (flags & ~0x0808) !== 0 || (method !== 0 && method !== 8)) {
      throw new ReporterError('unsupported_zip', 'encrypted, split, ZIP64, or unsupported compression rejected');
    }
    const rawName = archive.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = rawName.toString('utf8');
    if (!Buffer.from(name, 'utf8').equals(rawName) || names.has(name)) {
      throw new ReporterError(names.has(name) ? 'duplicate_entry' : 'invalid_zip_path', 'duplicate or invalid UTF-8 ZIP entry');
    }
    names.add(name);
    const unixMode = madeBy >> 8 === 3 ? (externalAttributes >>> 16) & 0xffff : 0;
    const fileType = unixMode & 0xf000;
    const directory = name.endsWith('/');
    if (fileType === 0xa000) throw new ReporterError('symlink_entry', 'symbolic-link ZIP entry rejected');
    if (directory) {
      throw new ReporterError('unsupported_entry', 'directory ZIP entries are not artifact files');
    }
    if (!safeArchivePath(name) || (fileType !== 0 && fileType !== 0x8000)
        || ((externalAttributes & 0x10) !== 0 && fileType === 0)) {
      throw new ReporterError('invalid_zip_path', 'unsafe or unsupported ZIP file entry');
    }
    const extension = path.posix.extname(name).toLowerCase();
    const maxBytes = name === 'report.json' ? LIMITS.jsonBytes
      : extension === '.png' ? LIMITS.screenshotBytes : LIMITS.evidenceFileBytes;
    if (!['.json', '.md', '.png', '.zip'].includes(extension)
        || uncompressedSize < 1 || uncompressedSize > maxBytes) {
      throw new ReporterError('unsupported_entry', 'unknown, empty, or oversized artifact file');
    }
    expandedBytes += uncompressedSize;
    if (expandedBytes > LIMITS.artifactBytes) {
      throw new ReporterError('oversized_artifact', 'expanded artifact exceeds 100 MiB');
    }
    entries.push({
      name, flags, method, expectedCrc, compressedSize, uncompressedSize, localOffset,
    });
    cursor = end;
  }
  if (cursor !== eocd || entries.length < 1) throw new ReporterError('invalid_zip', 'invalid central-directory bounds');
  return entries;
}

function expandArchiveEntry(archive, entry, centralOffset) {
  const offset = entry.localOffset;
  if (offset + 30 > centralOffset || archive.readUInt32LE(offset) !== ZIP_LOCAL) {
    throw new ReporterError('invalid_zip', 'missing local ZIP header');
  }
  const flags = archive.readUInt16LE(offset + 6);
  const method = archive.readUInt16LE(offset + 8);
  const nameLength = archive.readUInt16LE(offset + 26);
  const extraLength = archive.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  const localName = archive.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
  if (flags !== entry.flags || method !== entry.method || localName !== entry.name || dataEnd > centralOffset) {
    throw new ReporterError('invalid_zip', 'central and local ZIP headers disagree');
  }
  const compressed = archive.subarray(dataStart, dataEnd);
  let contents;
  try {
    contents = entry.method === 0
      ? Buffer.from(compressed)
      : inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize });
  } catch (error) {
    throw new ReporterError('invalid_zip', 'artifact entry could not be safely expanded', { cause: error });
  }
  if (contents.length !== entry.uncompressedSize
      || crc32(contents) !== entry.expectedCrc
      || (entry.method === 0 && entry.compressedSize !== entry.uncompressedSize)) {
    throw new ReporterError('invalid_zip', 'artifact entry size or checksum is invalid');
  }
  return contents;
}

function inspectArtifactZip(archive, expectedIdentity) {
  const entries = parseArchiveEntries(archive);
  const eocd = findEndOfCentralDirectory(archive);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  const contentsByName = new Map(entries.map((entry) => [
    entry.name,
    expandArchiveEntry(archive, entry, centralOffset),
  ]));
  if (!contentsByName.has('report.json')) {
    throw new ReporterError('missing_report', 'artifact does not contain report.json');
  }

  const extractionRoot = mkdtempSync(path.join(tmpdir(), 'gods-eye-agent-qa-report-'));
  try {
    for (const [name, contents] of contentsByName) {
      const target = path.join(extractionRoot, ...name.split('/'));
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, contents, { mode: 0o600, flag: 'wx' });
    }
    const report = readBoundedJson(path.join(extractionRoot, 'report.json'));
    validateReport(report, expectedIdentity);
    const expectedFiles = new Set(['report.json', ...report.evidence.map(({ path: evidencePath }) => evidencePath)]);
    if (contentsByName.size !== expectedFiles.size
        || [...contentsByName.keys()].some((name) => !expectedFiles.has(name))) {
      throw new ReporterError('unexpected_artifact_entry', 'artifact contains a file outside its validated manifest');
    }
    validateEvidenceManifest(extractionRoot, report.evidence);
    return Object.freeze({ report, files: Object.freeze([...contentsByName.keys()].sort()) });
  } finally {
    rmSync(extractionRoot, { recursive: true, force: true });
  }
}

function escapeText(value, maxLength = 1000) {
  const text = typeof value === 'string' ? value : '';
  return text
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{12,})\b/gu, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/giu, 'Bearer [redacted]')
    .slice(0, maxLength)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('@', '&#64;')
    .replace(/([\\`*_{}\[\]()#!|])/gu, '\\$1')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
}

function verifiedRunUrl(run) {
  return `https://github.com/${EXPECTED_REPOSITORY}/actions/runs/${run.id}/attempts/${run.run_attempt}`;
}

function verifiedArtifactUrl(run, artifact) {
  return artifact ? `https://github.com/${EXPECTED_REPOSITORY}/actions/runs/${run.id}/artifacts/${artifact.id}` : null;
}

function renderComment({ identity, run, status, reason, report, artifact, notApplicableReason }) {
  const lines = [
    COMMENT_MARKER,
    '## Agent QA (advisory)',
    '',
    `**Status:** ${escapeText(notApplicableReason ? 'not_applicable' : status, 40)}`,
    `**Tested head:** \`${identity.headSha}\``,
    `**Run:** [${run.id} attempt ${run.run_attempt}](${verifiedRunUrl(run)})`,
  ];
  const artifactUrl = verifiedArtifactUrl(run, artifact);
  if (artifactUrl) lines.push(`**Artifact:** [bounded evidence](${artifactUrl})`);
  lines.push('');
  if (notApplicableReason) {
    lines.push(`This pull request is no longer eligible: ${escapeText(notApplicableReason, 120)}.`);
  } else if (status === 'cancelled') {
    lines.push('The current QA generation was cancelled. No successful browser result is claimed.');
  } else if (status === 'incomplete') {
    lines.push(`QA did not complete: ${escapeText(reason, 120)}. No successful browser result is claimed.`);
  } else if (status === 'no_findings') {
    lines.push('The bounded fixture scenarios completed without findings. This is advisory research-demo QA.');
  } else {
    lines.push(`Found ${report?.findings?.length || 0} advisory issue(s):`);
    for (const finding of (report?.findings || []).slice(0, 20)) {
      lines.push(`- **${escapeText(finding.severity, 20)} — ${escapeText(finding.title, 200)}:** ${escapeText(finding.description, 800)}`);
    }
  }
  lines.push('', '_Agent QA is advisory and does not establish identity or real-gallery quality._');
  let body = lines.join('\n');
  if (Buffer.byteLength(body) > MAX_COMMENT_BYTES) {
    const suffix = '\n\n_Details truncated to the publication limit._';
    body = `${Buffer.from(body).subarray(0, MAX_COMMENT_BYTES - Buffer.byteLength(suffix) - 4).toString('utf8')}${suffix}`;
  }
  return body;
}

async function fetchAuthoritativeRun(github, eventRun, repository) {
  const { owner, repo } = splitRepository(repository);
  if (!positiveInteger(eventRun?.id) || !positiveInteger(eventRun?.run_attempt)
      || eventRun?.repository?.full_name !== repository) {
    throw new ReporterError('invalid_workflow_run_event', 'invalid workflow_run event identity');
  }
  const response = await apiMethod(github, 'actions', 'getWorkflowRunAttempt')({
    owner,
    repo,
    run_id: eventRun.id,
    attempt_number: eventRun.run_attempt,
  });
  const run = response?.data;
  if (!run || run.id !== eventRun.id || run.run_attempt !== eventRun.run_attempt
      || run.repository?.full_name !== repository || run.name !== AGENT_QA_WORKFLOW_NAME
      || !isTrustedWorkflowPath(run.path) || run.event !== 'pull_request_target' || run.status !== 'completed') {
    throw new ReporterError('workflow_run_mismatch', 'authoritative run metadata does not match the trusted workflow');
  }
  const identity = parseRunName(run.display_title);
  if (!identity) throw new ReporterError('invalid_run_name', 'trusted workflow run name is not correlated');
  return { run, identity };
}

async function listComments(github, pullNumber) {
  const { owner, repo } = splitRepository(EXPECTED_REPOSITORY);
  const method = apiMethod(github, 'issues', 'listComments');
  const comments = [];
  for (let page = 1; ; page += 1) {
    const response = await method({ owner, repo, issue_number: pullNumber, per_page: PAGE_SIZE, page });
    if (!Array.isArray(response?.data)) throw new ReporterError('comments_lookup_failed', 'malformed comment page');
    comments.push(...response.data);
    if (response.data.length < PAGE_SIZE) return comments;
  }
}

function findManagedComment(comments) {
  const matches = comments.filter((comment) => comment?.user?.login === BOT_LOGIN
    && typeof comment.body === 'string'
    && (comment.body === COMMENT_MARKER || comment.body.startsWith(`${COMMENT_MARKER}\n`)));
  if (matches.length > 1) throw new ReporterError('duplicate_managed_comments', 'multiple managed comments found');
  return matches[0] || null;
}

async function listExactArtifact(github, run, identity) {
  const { owner, repo } = splitRepository(EXPECTED_REPOSITORY);
  const expectedName = `agent-qa-${identity.prNumber}-${run.id}-${run.run_attempt}`;
  const method = apiMethod(github, 'actions', 'listWorkflowRunArtifacts');
  const matches = [];
  for (let page = 1; ; page += 1) {
    const response = await method({ owner, repo, run_id: run.id, per_page: PAGE_SIZE, page });
    const artifacts = response?.data?.artifacts;
    if (!Array.isArray(artifacts)) throw new ReporterError('artifact_lookup_failed', 'malformed artifact page');
    matches.push(...artifacts.filter((artifact) => artifact?.name === expectedName
      && positiveInteger(artifact.id) && artifact.expired !== true
      && (!artifact.workflow_run || artifact.workflow_run.id === run.id)));
    if (artifacts.length < PAGE_SIZE) break;
  }
  if (matches.length > 1) throw new ReporterError('duplicate_artifact', 'multiple exact artifacts found');
  return matches[0] || null;
}

async function downloadArtifact(github, artifact) {
  const { owner, repo } = splitRepository(EXPECTED_REPOSITORY);
  const response = await apiMethod(github, 'actions', 'downloadArtifact')({
    owner, repo, artifact_id: artifact.id, archive_format: 'zip',
  });
  const value = response?.data;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new ReporterError('artifact_download_failed', 'artifact download did not return ZIP bytes');
}

function expectedRequestFromReport(report, run, identity) {
  if (report.request.repository !== EXPECTED_REPOSITORY
      || report.request.pr_number !== identity.prNumber
      || report.request.head.sha !== identity.headSha
      || report.request.run.id !== run.id
      || report.request.run.attempt !== run.run_attempt) {
    throw new ReporterError('artifact_identity_mismatch', 'artifact identity does not match GitHub run identity');
  }
  return report.request;
}

async function synthesizeCurrentRequest(github, run, identity) {
  const controllerSha = typeof run.head_sha === 'string' ? run.head_sha : '';
  const admittedAt = typeof run.created_at === 'string' ? run.created_at : '';
  return admitPullRequest({
    github,
    repository: EXPECTED_REPOSITORY,
    pullNumber: identity.prNumber,
    eventHeadSha: identity.headSha,
    controllerSha,
    runId: run.id,
    runAttempt: run.run_attempt,
    admittedAt,
  });
}

async function mutateComment(github, pullNumber, comment, body) {
  const { owner, repo } = splitRepository(EXPECTED_REPOSITORY);
  if (comment) {
    const response = await apiMethod(github, 'issues', 'updateComment')({
      owner, repo, comment_id: comment.id, body,
    });
    return response?.data?.id || comment.id;
  }
  const response = await apiMethod(github, 'issues', 'createComment')({
    owner, repo, issue_number: pullNumber, body,
  });
  if (!positiveInteger(response?.data?.id)) throw new ReporterError('comment_write_failed', 'comment create returned no id');
  return response.data.id;
}

async function publishWorkflowRun({ github, workflowRun, repository = EXPECTED_REPOSITORY }) {
  let authoritative;
  try {
    authoritative = await fetchAuthoritativeRun(github, workflowRun, repository);
  } catch (error) {
    return result('incomplete', error instanceof ReporterError ? error.code : 'run_lookup_failed');
  }
  const { run, identity } = authoritative;
  const safeIdentity = { prNumber: identity.prNumber, headSha: identity.headSha };
  const currentGeneration = { id: run.id, run_attempt: run.run_attempt };

  try {
    const initialLatest = await findLatestGeneration({
      github, prNumber: identity.prNumber, headSha: identity.headSha,
    });
    if (!isLatestGeneration(currentGeneration, initialLatest)) {
      return result('stale', 'superseded_generation', { prNumber: identity.prNumber });
    }
  } catch {
    return result('incomplete', 'generation_lookup_failed', { prNumber: identity.prNumber });
  }

  let artifact = null;
  let report = null;
  let publicationStatus;
  let publicationReason;
  try {
    artifact = await listExactArtifact(github, run, identity);
    if (artifact) {
      const archive = await downloadArtifact(github, artifact);
      const inspected = inspectArtifactZip(archive);
      expectedRequestFromReport(inspected.report, run, identity);
      validateReport(inspected.report, inspected.report.request);
      report = inspected.report;
      publicationStatus = report.status;
      publicationReason = report.reason;
    } else if (run.conclusion === 'cancelled') {
      publicationStatus = 'cancelled';
      publicationReason = 'none';
    } else {
      publicationStatus = 'incomplete';
      publicationReason = run.conclusion === 'success' ? 'invalid_output' : 'runner_failed';
    }
  } catch {
    artifact = null;
    report = null;
    publicationStatus = 'incomplete';
    publicationReason = 'invalid_output';
  }

  let comments;
  let managedComment;
  try {
    comments = await listComments(github, identity.prNumber);
    managedComment = findManagedComment(comments);
  } catch (error) {
    return result('incomplete', error instanceof ReporterError ? error.code : 'comments_lookup_failed', {
      prNumber: identity.prNumber,
    });
  }

  let eligibility;
  try {
    eligibility = report
      ? await recheckPullRequest({ github, request: report.request })
      : await synthesizeCurrentRequest(github, run, identity);
  } catch {
    return result('incomplete', 'eligibility_lookup_failed', { prNumber: identity.prNumber });
  }
  if (eligibility.status === 'incomplete') {
    return result('incomplete', 'eligibility_lookup_failed', { prNumber: identity.prNumber });
  }

  try {
    const latest = await findLatestGeneration({
      github, prNumber: identity.prNumber, headSha: identity.headSha,
    });
    if (!isLatestGeneration(currentGeneration, latest)) {
      return result('stale', 'superseded_generation', { prNumber: identity.prNumber });
    }
  } catch {
    return result('incomplete', 'generation_lookup_failed', { prNumber: identity.prNumber });
  }

  if (eligibility.status !== 'admitted') {
    if (!managedComment) {
      return result('skipped', 'ineligible_no_existing_comment', { prNumber: identity.prNumber });
    }
    const body = renderComment({
      identity: safeIdentity, run, status: publicationStatus, reason: publicationReason,
      report, artifact: null, notApplicableReason: eligibility.reason,
    });
    let commentId;
    try {
      commentId = await mutateComment(github, identity.prNumber, managedComment, body);
    } catch {
      return result('incomplete', 'comment_write_failed', { prNumber: identity.prNumber });
    }
    return result('published', 'not_applicable', {
      prNumber: identity.prNumber, commentId, reportStatus: 'not_applicable',
    });
  }

  const body = renderComment({
    identity: safeIdentity, run, status: publicationStatus, reason: publicationReason, report, artifact,
  });
  let commentId;
  try {
    commentId = await mutateComment(github, identity.prNumber, managedComment, body);
  } catch {
    return result('incomplete', 'comment_write_failed', { prNumber: identity.prNumber });
  }
  return result('published', 'current_generation', {
    prNumber: identity.prNumber, commentId, reportStatus: publicationStatus,
  });
}

module.exports = Object.freeze({
  BOT_LOGIN,
  COMMENT_MARKER,
  MAX_COMMENT_BYTES,
  ReporterError,
  WORKFLOW_PATH,
  escapeText,
  inspectArtifactZip,
  parseRunName,
  publishWorkflowRun,
  renderComment,
});
