import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildCodexSubprocessEnv,
  CODEX_SALE_BASE_URL,
  CODEX_SALE_PROVIDER_URL,
  newCallId,
  setupCodexSaleConfig,
} from '../codex-app-server-client.mjs';

describe('setupCodexSaleConfig', () => {
  let tmpHome;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('writes auth.json and config.toml with codex-sale provider', () => {
    const { codexDir, configPath } = setupCodexSaleConfig(tmpHome, 'sk-test');
    expect(fs.existsSync(path.join(codexDir, 'auth.json'))).toBe(true);
    expect(fs.readFileSync(configPath, 'utf8')).toContain(CODEX_SALE_PROVIDER_URL);
    expect(fs.readFileSync(configPath, 'utf8')).toContain('env_key = "CODEX_LB_API_KEY"');
    expect(fs.readFileSync(configPath, 'utf8')).toContain('model_provider = "codex-sale"');
  });
});

describe('buildCodexSubprocessEnv', () => {
  let tmpHome;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-env-'));
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('sets CODEX_LB_API_KEY and writes config under HOME/.codex', () => {
    const env = buildCodexSubprocessEnv({
      apiKey: 'sk-test',
      codexHome: tmpHome,
    });
    expect(env.CODEX_LB_API_KEY).toBe('sk-test');
    expect(env.OPENAI_API_KEY).toBe('sk-test');
    expect(env.HOME).toBe(tmpHome);
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(fs.existsSync(path.join(tmpHome, '.codex', 'config.toml'))).toBe(true);
  });

  it('uses codex.sale backend-api endpoint constant', () => {
    expect(CODEX_SALE_BASE_URL).toBe('https://codex.sale');
    expect(CODEX_SALE_PROVIDER_URL).toBe('https://codex.sale/backend-api/codex');
  });
});

describe('newCallId', () => {
  it('generates unique prefixed ids', () => {
    const a = newCallId('call');
    const b = newCallId('call');
    expect(a).toMatch(/^call_[0-9a-f]{24}$/);
    expect(b).not.toBe(a);
  });
});
