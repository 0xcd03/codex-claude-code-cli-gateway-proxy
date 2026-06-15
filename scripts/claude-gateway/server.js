#!/usr/bin/env node
/**
 * claude-gateway — OpenAI-compatible HTTP proxy through Claude Code CLI.
 *
 * Modes (CLAUDE_GATEWAY_MODE):
 *   bridge — Claude CLI stream-json with tool_use passthrough (default)
 *   legacy — plain `claude -p` text-only (backward compat)
 *
 * Endpoints:
 *   GET  /v1/models              — returns static model list
 *   POST /v1/chat/completions    — runs Claude and streams SSE
 *
 * Required env:
 *   ANTHROPIC_API_KEY   — vibecode API key
 *   ANTHROPIC_BASE_URL  — vibecode endpoint
 *   CLAUDE_BIN          — path to claude CLI binary
 *   GATEWAY_SECRET      — bearer token (recommended)
 *   GATEWAY_PORT        — listen port (default: 20130)
 *   CLAUDE_GATEWAY_MODE — "bridge" or "legacy" (default: bridge)
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { ClaudeToolBridge } from './claude-bridge.mjs';

const PORT             = process.env.GATEWAY_PORT     ?? 20130;
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL ?? 'https://claude-code-cli.vibecode-claude.online';
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY  ?? '';
const GATEWAY_SECRET     = process.env.GATEWAY_SECRET     ?? '';
const CLAUDE_BIN         = process.env.CLAUDE_BIN         ?? '/usr/local/bin/claude';
const DEFAULT_MODEL      = process.env.DEFAULT_MODEL      ?? 'claude-opus-4-7';
const SUBPROCESS_TIMEOUT_MS = Number(process.env.SUBPROCESS_TIMEOUT_MS ?? 120_000);
const GATEWAY_MODE        = (process.env.CLAUDE_GATEWAY_MODE ?? 'bridge').toLowerCase();
const CLAUDE_SYSTEM_PROMPT = process.env.CLAUDE_SYSTEM_PROMPT
  ?? 'Do not re-read files already read. After Write, do not verify — it is saved. Keep moving forward.';

if (!ANTHROPIC_API_KEY) {
  process.stderr.write('[FATAL] ANTHROPIC_API_KEY is not set\n');
  process.exit(1);
}

const MODELS = [
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
];

/** Minimal safe env for claude CLI subprocess — no parent secrets */
function buildClaudeEnv() {
  return {
    HOME:       process.env.HOME ?? '/root',
    PATH:       process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    TERM:       'dumb',
    ANTHROPIC_BASE_URL,
    ANTHROPIC_API_KEY,
    DISABLE_TELEMETRY:                        '1',
    DISABLE_ERROR_REPORTING:                  '1',
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK:'1',
    DISABLE_AUTOUPDATER:                      '1',
    DISABLE_BUG_COMMAND:                      '1',
    DISABLE_COST_WARNINGS:                    '1',
  };
}

function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end',  () => {
      try { resolve(JSON.parse(raw || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function checkAuth(req) {
  if (!GATEWAY_SECRET) return true;
  const auth = req.headers['authorization'] ?? '';
  return auth === `Bearer ${GATEWAY_SECRET}`;
}

/** Convert messages array to a prompt string for -p.
 *  system → prepended as [SYSTEM] block
 *  user / assistant → labelled turns
 */
function messagesToPrompt(messages) {
  const parts = [];
  for (const m of messages) {
    const content = Array.isArray(m.content)
      ? m.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
      : String(m.content ?? '');
    if (m.role === 'system') {
      parts.push(`[SYSTEM]\n${content}`);
    } else {
      const role = m.role === 'assistant' ? 'Assistant' : 'User';
      parts.push(`${role}: ${content}`);
    }
  }
  return parts.join('\n\n');
}

/** Run claude CLI and return full result text (non-streaming) */
function runClaude(prompt, model) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', prompt,
      '--model', model,
      '--output-format', 'json',
    ];

    const proc = spawn(CLAUDE_BIN, args, { env: buildClaudeEnv() });
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`claude CLI timed out after ${SUBPROCESS_TIMEOUT_MS}ms`));
    }, SUBPROCESS_TIMEOUT_MS);

    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.is_error) {
          reject(new Error(parsed.result ?? 'claude CLI error'));
        } else {
          resolve({ text: parsed.result ?? '', usage: parsed.usage ?? {} });
        }
      } catch {
        reject(new Error(`claude CLI exited ${code}. stderr: ${stderr.slice(0, 200)}`));
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Run claude CLI in stream-json mode and pipe SSE chunks to res */
function streamClaude(prompt, model, req, res, reqId) {
  const args = [
    '-p', prompt,
    '--model', model,
    '--output-format', 'stream-json',
    '--verbose',
  ];

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Send role chunk immediately
  const roleChunk = {
    id: reqId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  };
  res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

  const proc = spawn(CLAUDE_BIN, args, { env: buildClaudeEnv() });
  let buffer = '';
  let finished = false;

  const timer = setTimeout(() => {
    log(`WARN: stream timeout for ${reqId} — killing subprocess`);
    proc.kill('SIGTERM');
    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }, SUBPROCESS_TIMEOUT_MS);

  // If client disconnects, kill subprocess
  req.on('close', () => {
    if (!finished) {
      proc.kill('SIGTERM');
      clearTimeout(timer);
    }
  });

  function processLine(line) {
    if (!line.trim()) return;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch (e) {
      log(`WARN: processLine JSON parse error: ${e.message} — line: ${line.slice(0, 100)}`);
      return;
    }

    if (evt.type === 'assistant' && evt.message?.content) {
      for (const part of evt.message.content) {
        if (part.type === 'text' && part.text) {
          const chunk = {
            id: reqId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { content: part.text }, finish_reason: null }],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
      }
    }

    if (evt.type === 'result') {
      finished = true;
      clearTimeout(timer);
      const stopChunk = {
        id: reqId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      };
      res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }

  proc.stdout.on('data', chunk => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    lines.forEach(processLine);
  });

  proc.on('close', () => {
    clearTimeout(timer);
    if (buffer.trim()) processLine(buffer);
    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  });

  proc.on('error', err => {
    clearTimeout(timer);
    log(`spawn error: ${err.message}`);
    if (!res.writableEnded) res.end();
  });
}

// ── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (!checkAuth(req)) {
    return json(res, 401, { error: { message: 'Invalid gateway token', type: 'auth_error' } });
  }

  // GET /v1/models
  if (req.method === 'GET' && req.url === '/v1/models') {
    return json(res, 200, {
      object: 'list',
      data: MODELS.map(id => ({
        id,
        object: 'model',
        created: 1749600000,
        owned_by: 'claude',
      })),
    });
  }

  // POST /v1/chat/completions
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body;
    try { body = await parseBody(req); }
    catch { return json(res, 400, { error: { message: 'Invalid JSON', type: 'invalid_request' } }); }

    const messages = body.messages ?? [];
    if (!messages.length) {
      return json(res, 400, { error: { message: 'messages is required', type: 'invalid_request' } });
    }

    const model  = body.model ?? DEFAULT_MODEL;
    const stream = body.stream ?? false;
    const reqId  = `chatcmpl-${crypto.randomUUID()}`;

    // ── Bridge mode: tool_use passthrough ──
    if (GATEWAY_MODE === 'bridge') {
      const onWarn = msg => log(`WARN: ${msg}`);
      const bridge = new ClaudeToolBridge({
        bin:     CLAUDE_BIN,
        apiKey:  ANTHROPIC_API_KEY,
        baseUrl: ANTHROPIC_BASE_URL,
        homeDir: process.env.HOME ?? '/root',
        model,
        timeoutMs: SUBPROCESS_TIMEOUT_MS,
        appendSystemPrompt: CLAUDE_SYSTEM_PROMPT,
        onLog: log,
        onWarn,
      });

      const meta = {
        id: reqId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
      };

      try {
        await bridge.runTurn({
          messages,
          tools: body.tools ?? [],
          res,
          meta,
          clientReq: req,
        });
      } catch (err) {
        if (err.message?.includes('client')) {
          // Client disconnect — not an error
          log(`bridge client disconnect: ${err.message}`);
        } else {
          log(`BRIDGE ERROR: ${err.message}`);
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: err.message, type: 'server_error' } }));
          } else if (!res.writableEnded) {
            res.end();
          }
        }
      }
      return;
    }

    // ── Legacy mode: plain -p ──
    const prompt = messagesToPrompt(messages);
    log(`LEGACY ${stream ? 'STREAM' : 'SYNC '} model=${model} prompt_len=${prompt.length}`);

    if (stream) {
      return streamClaude(prompt, model, req, res, reqId);
    }

    try {
      const { text, usage } = await runClaude(prompt, model);
      return json(res, 200, {
        id: reqId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens:     usage.input_tokens  ?? 0,
          completion_tokens: usage.output_tokens ?? 0,
          total_tokens:      (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
        },
      });
    } catch (err) {
      log(`ERROR: ${err.message}`);
      return json(res, 500, { error: { message: err.message, type: 'server_error' } });
    }
  }

  return json(res, 404, { error: { message: 'Not found', type: 'not_found' } });
});

// Gateway runs inside the OmniRoute Docker container — bind 0.0.0.0 so the
// host can also reach it (via host.docker.internal if needed), but actual
// traffic only comes from OmniRoute on loopback inside the container.
server.listen(PORT, '0.0.0.0', () => {
  log(`claude-gateway listening on 0.0.0.0:${PORT} (mode=${GATEWAY_MODE})`);
  log(`ANTHROPIC_BASE_URL: ${ANTHROPIC_BASE_URL}`);
  log(`CLAUDE_BIN: ${CLAUDE_BIN}`);
  log(`Auth: ${GATEWAY_SECRET ? 'enabled' : 'DISABLED — set GATEWAY_SECRET to protect'}`);
});
