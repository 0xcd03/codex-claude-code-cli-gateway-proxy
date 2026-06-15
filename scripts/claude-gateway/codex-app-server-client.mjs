/**
 * JSON-RPC client for `codex app-server --stdio`.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 120_000;

/** Codex Sale endpoints (see codex.sale install script). */
export const CODEX_SALE_BASE_URL = 'https://codex.sale';
export const CODEX_SALE_PROVIDER_URL = `${CODEX_SALE_BASE_URL}/backend-api/codex`;

/**
 * Write ~/.codex/auth.json + config.toml for codex-sale provider.
 * Mirrors https://codex.sale install script layout.
 */
export function setupCodexSaleConfig(homeDir, apiKey, options = {}) {
  if (!apiKey) throw new Error('setupCodexSaleConfig: apiKey required');
  const codexDir = path.join(homeDir, '.codex');
  fs.mkdirSync(codexDir, { recursive: true, mode: 0o700 });

  const authPath = path.join(codexDir, 'auth.json');
  fs.writeFileSync(authPath, `${JSON.stringify({
    auth_mode: 'apikey',
    OPENAI_API_KEY: apiKey,
  }, null, 2)}\n`, { mode: 0o600 });

  const model = options.model ?? 'gpt-5.4';
  const configPath = path.join(codexDir, 'config.toml');
  fs.writeFileSync(configPath, `model = "${model}"
model_reasoning_effort = "high"
model_provider = "codex-sale"

[model_providers.codex-sale]
name = "Codex Sale"
base_url = "${CODEX_SALE_PROVIDER_URL}"
wire_api = "responses"
env_key = "CODEX_LB_API_KEY"
supports_websockets = true
requires_openai_auth = true
`, { mode: 0o600 });

  return { codexDir, authPath, configPath };
}

export class CodexAppServerClient {
  #proc = null;
  #buffer = '';
  #nextId = 1;
  #pending = new Map();
  #notificationHandlers = new Map();
  #requestHandlers = new Map();
  #ready = null;
  #closed = false;

  constructor(options = {}) {
    this.bin = options.bin ?? 'codex';
    this.env = options.env ?? {};
    this.cwd = options.cwd ?? process.cwd();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onLog = options.onLog ?? (() => {});
    this.onWarn = options.onWarn ?? (() => {});
  }

  async start() {
    if (this.#proc) return;
    this.#proc = spawn(this.bin, ['app-server', '--stdio'], {
      env: this.env,
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.#proc.stdout.on('data', chunk => this.#onStdout(chunk));
    this.#proc.stderr.on('data', chunk => {
      const text = chunk.toString().trim();
      if (text) this.onWarn(`codex stderr: ${text.slice(0, 400)}`);
    });
    this.#proc.on('error', err => this.#failAll(err));
    this.#proc.on('close', code => {
      this.#closed = true;
      this.#failAll(new Error(`codex app-server exited ${code ?? 'signal'}`));
    });

    await this.initialize();
  }

  onNotification(method, handler) {
    this.#notificationHandlers.set(method, handler);
  }

  onRequest(method, handler) {
    this.#requestHandlers.set(method, handler);
  }

  async request(method, params = {}, timeoutMs = this.timeoutMs) {
    await this.start();
    const id = this.#nextId++;
    const line = `${JSON.stringify({ method, id, params })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`codex RPC timeout: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      this.#proc.stdin.write(line);
    });
  }

  notify(method, params = {}) {
    const line = `${JSON.stringify({ method, params })}\n`;
    this.#proc?.stdin?.write(line);
  }

  async initialize() {
    if (this.#ready) return this.#ready;
    this.#ready = (async () => {
      await this.request('initialize', {
        clientInfo: {
          name: 'cdslgw_bridge',
          title: 'Codex Sale Gateway',
          version: '1.0.0',
        },
        capabilities: { experimentalApi: true },
      });
      this.notify('initialized', {});
    })();
    return this.#ready;
  }

  async stop() {
    this.#closed = true;
    if (this.#proc && !this.#proc.killed) {
      this.#proc.kill('SIGTERM');
    }
    this.#proc = null;
    this.#ready = null;
  }

  #failAll(err) {
    for (const { reject } of this.#pending.values()) reject(err);
    this.#pending.clear();
  }

  #onStdout(chunk) {
    this.#buffer += chunk.toString();
    const lines = this.#buffer.split('\n');
    this.#buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.onWarn(`invalid JSON from codex: ${line.slice(0, 120)}`);
        continue;
      }
      this.#dispatch(msg);
    }
  }

  #dispatch(msg) {
    if (msg.method && msg.id !== undefined) {
      const handler = this.#requestHandlers.get(msg.method);
      if (handler) {
        Promise.resolve(handler(msg.params, msg))
          .then(result => this.#writeResponse(msg.id, result ?? {}))
          .catch(err => this.#writeError(msg.id, err));
      } else {
        this.onWarn(`unhandled codex request: ${msg.method}`);
        this.#writeError(msg.id, new Error(`unsupported request ${msg.method}`));
      }
      return;
    }

    if (msg.method) {
      const handler = this.#notificationHandlers.get(msg.method);
      if (handler) handler(msg.params ?? {}, msg);
      else this.onLog(`notify ${msg.method}`);
      return;
    }

    if (msg.id !== undefined) {
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else pending.resolve(msg.result);
    }
  }

  #writeResponse(id, result) {
    this.#proc?.stdin?.write(`${JSON.stringify({ id, result })}\n`);
  }

  #writeError(id, err) {
    this.#proc?.stdin?.write(`${JSON.stringify({
      id,
      error: { message: err instanceof Error ? err.message : String(err) },
    })}\n`);
  }
}

export function buildCodexSubprocessEnv({ apiKey, codexHome, model }) {
  const homeDir = codexHome ?? process.env.CODEX_HOME ?? '/opt/omniroute/codex-home';
  setupCodexSaleConfig(homeDir, apiKey, { model });
  return {
    HOME: homeDir,
    PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    TERM: 'dumb',
    CODEX_LB_API_KEY: apiKey,
    OPENAI_API_KEY: apiKey,
    DISABLE_TELEMETRY: '1',
    RUST_LOG: 'error',
  };
}

export function newCallId(prefix = 'call') {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}
