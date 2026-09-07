'use strict';

const { createHash } = require('node:crypto');
const { readFileSync, lstatSync, realpathSync } = require('node:fs');
const path = require('node:path');

const LIMITS = Object.freeze({
  jsonBytes: 1024 * 1024,
  screenshotBytes: 10 * 1024 * 1024,
  evidenceFileBytes: 10 * 1024 * 1024,
  artifactBytes: 100 * 1024 * 1024,
  relativePathBytes: 240,
});

class ContractError extends Error {
  constructor(code, issues = []) {
    super(`Agent QA contract rejected input (${code})`);
    this.name = 'ContractError';
    this.code = code;
    this.issues = issues;
  }
}

function assertSafeRelativePath(relativePath) {
  if (typeof relativePath !== 'string'
      || Buffer.byteLength(relativePath) > LIMITS.relativePathBytes
      || relativePath.length === 0
      || path.isAbsolute(relativePath)
      || path.win32.isAbsolute(relativePath)
      || relativePath.includes('\\')
      || relativePath.split('/').some((part) => part === '' || part === '.' || part === '..')
      || /[\u0000-\u001f\u007f]/u.test(relativePath)) {
    throw new ContractError('unsafe_evidence_path');
  }
}

function lstatEvidence(filePath) {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      throw new ContractError('missing_evidence');
    }
    throw error;
  }
}

function validateEvidenceFile(root, relativePath, options = {}) {
  assertSafeRelativePath(relativePath);
  const rootReal = realpathSync(root);
  let cursor = rootReal;
  for (const component of relativePath.split('/')) {
    cursor = path.join(cursor, component);
    const stats = lstatEvidence(cursor);
    if (stats.isSymbolicLink()) throw new ContractError('symlink_evidence');
  }
  const fileReal = realpathSync(cursor);
  if (!fileReal.startsWith(`${rootReal}${path.sep}`)) throw new ContractError('unsafe_evidence_path');
  const stats = lstatEvidence(fileReal);
  if (!stats.isFile()) throw new ContractError('invalid_evidence_file');
  const maxBytes = options.maxBytes || LIMITS.evidenceFileBytes;
  if (stats.size < 1 || stats.size > maxBytes) throw new ContractError('oversized_evidence');
  const extension = path.extname(relativePath).toLowerCase();
  if (options.allowedExtensions && !options.allowedExtensions.includes(extension)) {
    throw new ContractError('invalid_evidence_type');
  }
  const contents = readFileSync(fileReal);
  if (extension === '.png' && !contents.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    throw new ContractError('invalid_png_evidence');
  }
  return Object.freeze({
    path: relativePath,
    size_bytes: stats.size,
    sha256: createHash('sha256').update(contents).digest('hex'),
  });
}

function validateEvidenceManifest(root, manifest) {
  let totalBytes = 0;
  const seen = new Set();
  for (const entry of manifest) {
    if (seen.has(entry.path)) throw new ContractError('duplicate_evidence');
    seen.add(entry.path);
    const expectedExtension = { screenshot: '.png', trace: '.zip', steps: '.json', summary: '.md' }[entry.kind];
    if (!expectedExtension) throw new ContractError('invalid_evidence_type');
    const actual = validateEvidenceFile(root, entry.path, {
      maxBytes: entry.kind === 'screenshot' ? LIMITS.screenshotBytes : LIMITS.evidenceFileBytes,
      allowedExtensions: [expectedExtension],
    });
    if (actual.size_bytes !== entry.size_bytes || actual.sha256 !== entry.sha256) {
      throw new ContractError('evidence_metadata_mismatch');
    }
    totalBytes += actual.size_bytes;
    if (totalBytes > LIMITS.artifactBytes) throw new ContractError('oversized_artifact');
  }
  return manifest;
}

function readBoundedJson(filePath, options = {}) {
  const stats = lstatSync(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) throw new ContractError('invalid_json_file');
  if (stats.size < 1 || stats.size > (options.maxBytes || LIMITS.jsonBytes)) {
    throw new ContractError('oversized_json');
  }
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new ContractError('invalid_json');
    throw error;
  }
}

module.exports = Object.freeze({
  ContractError,
  LIMITS,
  readBoundedJson,
  validateEvidenceFile,
  validateEvidenceManifest,
});
