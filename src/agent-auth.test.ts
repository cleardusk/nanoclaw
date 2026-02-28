import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  hasConfiguredAgentCredentials,
  readAgentAuthEnv,
} from './agent-auth.js';

function writeSettings(homeDir: string, env: Record<string, unknown>): void {
  const claudeDir = path.join(homeDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({ env }, null, 2),
  );
}

describe('agent auth env', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  const originalEnv = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  };

  let tempRoot: string;
  let tempHome: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-auth-'));
    tempHome = path.join(tempRoot, 'home');
    fs.mkdirSync(tempHome, { recursive: true });
    process.chdir(tempRoot);
    process.env.HOME = tempHome;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_BASE_URL;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalEnv.ANTHROPIC_API_KEY === undefined)
      delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalEnv.ANTHROPIC_API_KEY;
    if (originalEnv.ANTHROPIC_AUTH_TOKEN === undefined)
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = originalEnv.ANTHROPIC_AUTH_TOKEN;
    if (originalEnv.ANTHROPIC_BASE_URL === undefined)
      delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = originalEnv.ANTHROPIC_BASE_URL;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('reads credentials from ~/.claude/settings.json', () => {
    writeSettings(tempHome, {
      ANTHROPIC_AUTH_TOKEN: 'token-from-settings',
      ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic',
      ANTHROPIC_MODEL: 'MiniMax-M2.5',
    });

    const env = readAgentAuthEnv();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('token-from-settings');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.minimaxi.com/anthropic');
    expect(env.ANTHROPIC_MODEL).toBe('MiniMax-M2.5');
  });

  it('.env overrides ~/.claude/settings.json', () => {
    writeSettings(tempHome, {
      ANTHROPIC_AUTH_TOKEN: 'token-from-settings',
      ANTHROPIC_BASE_URL: 'https://settings.example',
    });
    fs.writeFileSync(
      path.join(tempRoot, '.env'),
      [
        'ANTHROPIC_AUTH_TOKEN=token-from-env-file',
        'ANTHROPIC_BASE_URL=https://env-file.example',
      ].join('\n'),
    );

    const env = readAgentAuthEnv();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('token-from-env-file');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://env-file.example');
  });

  it('process.env overrides both settings and .env', () => {
    writeSettings(tempHome, {
      ANTHROPIC_AUTH_TOKEN: 'token-from-settings',
      ANTHROPIC_BASE_URL: 'https://settings.example',
    });
    fs.writeFileSync(
      path.join(tempRoot, '.env'),
      [
        'ANTHROPIC_AUTH_TOKEN=token-from-env-file',
        'ANTHROPIC_BASE_URL=https://env-file.example',
      ].join('\n'),
    );
    process.env.ANTHROPIC_AUTH_TOKEN = 'token-from-process-env';
    process.env.ANTHROPIC_BASE_URL = 'https://process-env.example';

    const env = readAgentAuthEnv();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('token-from-process-env');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://process-env.example');
  });

  it('detects configured credentials via ANTHROPIC_AUTH_TOKEN', () => {
    writeSettings(tempHome, {
      ANTHROPIC_AUTH_TOKEN: 'token-from-settings',
    });

    expect(hasConfiguredAgentCredentials()).toBe(true);
  });

  it('returns false when no credentials are configured', () => {
    expect(hasConfiguredAgentCredentials()).toBe(false);
  });
});
