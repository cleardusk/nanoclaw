import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export const AGENT_AUTH_ENV_KEYS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_REASONING_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'API_TIMEOUT_MS',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
] as const;

export const AGENT_CREDENTIAL_KEYS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
] as const;

function readClaudeSettingsEnv(
  keys: readonly string[],
): Record<string, string> {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  let rawSettings: string;
  try {
    rawSettings = fs.readFileSync(settingsPath, 'utf-8');
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawSettings);
  } catch (err) {
    logger.warn({ err, settingsPath }, 'Invalid ~/.claude/settings.json');
    return {};
  }

  const env = (parsed as { env?: unknown }).env;
  if (!env || typeof env !== 'object') return {};

  const envObj = env as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const key of keys) {
    const value = envObj[key];
    if (typeof value === 'string' && value.trim()) {
      result[key] = value;
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      result[key] = String(value);
    }
  }
  return result;
}

/**
 * Read SDK auth/runtime variables used by the container-side Claude SDK.
 *
 * Precedence (later wins):
 *   1) ~/.claude/settings.json (cc-switch style)
 *   2) project .env
 *   3) current process.env
 */
export function readAgentAuthEnv(
  keys: readonly string[] = AGENT_AUTH_ENV_KEYS,
): Record<string, string> {
  const settingsEnv = readClaudeSettingsEnv(keys);
  const envFile = readEnvFile([...keys]);
  const merged: Record<string, string> = {
    ...settingsEnv,
    ...envFile,
  };

  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim()) {
      merged[key] = value;
    }
  }

  return merged;
}

export function hasConfiguredAgentCredentials(): boolean {
  const env = readAgentAuthEnv(AGENT_CREDENTIAL_KEYS);
  return AGENT_CREDENTIAL_KEYS.some((key) => Boolean(env[key]));
}
