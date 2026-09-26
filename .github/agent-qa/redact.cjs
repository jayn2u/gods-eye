'use strict';

function sanitizeText(value, fallback = 'Details unavailable.') {
  let text = typeof value === 'string' ? value : fallback;
  text = text
    .replace(/\b(?:sk|sess|ghp|github_pat)_[A-Za-z0-9_-]{6,}\b/gu, '[redacted]')
    .replace(/\bsk-ant-[A-Za-z0-9_-]{6,}/gu, '[redacted]')
    .replace(/"(?:OPENAI_API_KEY|AZURE_OPENAI_API_KEY|CODEX_API_KEY|GITHUB_TOKEN|GH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)"\s*:\s*"(?:\\.|[^"\\])*"/giu, '[redacted]')
    .replace(/\b(?:OPENAI_API_KEY|AZURE_OPENAI_API_KEY|CODEX_API_KEY|GITHUB_TOKEN|GH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)\s*[:=]\s*[^\s,;]+/giu, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{6,}/giu, 'Bearer [redacted]')
    .replace(/(?:TOKEN|SECRET|AUTH)[_-]?CANARY[A-Za-z0-9_-]*/giu, '[redacted]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
    .trim();
  return (text || fallback).slice(0, 4000);
}

module.exports = Object.freeze({ sanitizeText });
