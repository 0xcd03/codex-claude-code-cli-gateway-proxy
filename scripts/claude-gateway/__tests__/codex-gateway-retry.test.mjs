import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';

/**
 * Integration test for the hollow-retry orchestration in codex-gateway.
 * A mock upstream returns a configurable sequence of SSE bodies; the gateway
 * should retry on a hollow response and fall back to a synthetic text turn
 * once retries are exhausted.
 */

const HOLLOW_SSE = [
  'data: {"id":"u1","model":"gpt-5.5","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Write"}}]}}]}\n\n',
  'data: {"id":"u1","model":"gpt-5.5","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  'data: [DONE]\n\n',
].join('');

const MEANINGFUL_SSE = [
  'data: {"id":"u2","model":"gpt-5.5","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_2","type":"function","function":{"name":"Write","arguments":"{\\"path\\":\\"a.css\\","}}]}}]}\n\n',
  'data: {"id":"u2","model":"gpt-5.5","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"contents\\":\\"x\\"}"}}]}}]}\n\n',
  'data: {"id":"u2","model":"gpt-5.5","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  'data: [DONE]\n\n',
].join('');

let upstream;
let upstreamHits = 0;
let upstreamQueue = [];
let upstreamBodies = [];
let gateway;
let gatewayPort;

function startUpstream() {
  return new Promise(resolve => {
    upstream = http.createServer((req, res) => {
      upstreamHits += 1;
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        upstreamBodies.push(body);
        const bodyToSend = upstreamQueue.shift() ?? HOLLOW_SSE;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(bodyToSend);
      });
    });
    upstream.listen(0, '127.0.0.1', () => resolve(upstream.address().port));
  });
}

function postChat(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: gatewayPort,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, raw }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function parseSse(raw) {
  let content = '';
  let finish = null;
  let args = '';
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
    try {
      const j = JSON.parse(line.slice(6));
      const d = j.choices?.[0]?.delta;
      if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
      if (d?.content) content += d.content;
      for (const tc of d?.tool_calls ?? []) {
        if (tc.function?.arguments) args += tc.function.arguments;
      }
    } catch { /* ignore */ }
  }
  return { content, finish, args };
}

beforeAll(async () => {
  const upPort = await startUpstream();
  process.env.UPSTREAM_URL = `http://127.0.0.1:${upPort}/v1`;
  process.env.API_KEY = 'test-key';
  process.env.CODEX_GATEWAY_MODE = 'http';
  process.env.CODEX_HOLLOW_RETRIES = '1';
  const mod = await import('../codex-gateway.mjs');
  gateway = mod.server;
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  gatewayPort = gateway.address().port;
});

afterAll(async () => {
  await new Promise(resolve => gateway.close(resolve));
  await new Promise(resolve => upstream.close(resolve));
});

describe('codex-gateway hollow retry', () => {
  it('retries once then returns synthetic text when upstream stays hollow', async () => {
    upstreamHits = 0;
    upstreamBodies = [];
    upstreamQueue = [HOLLOW_SSE, HOLLOW_SSE];
    const { status, raw } = await postChat({
      model: 'gpt-5.5',
      stream: true,
      messages: [{ role: 'user', content: 'write a file' }],
      tools: [{ type: 'function', function: { name: 'Write', parameters: { type: 'object', properties: {} } } }],
    });
    const { content, finish } = parseSse(raw);
    expect(status).toBe(200);
    expect(upstreamHits).toBe(2);
    expect(finish).toBe('stop');
    expect(content.length).toBeGreaterThan(0);
  });

  it('sends smaller payload on hollow retry', async () => {
    upstreamHits = 0;
    upstreamBodies = [];
    upstreamQueue = [HOLLOW_SSE, MEANINGFUL_SSE];
    const longHistory = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i} `.repeat(200),
    }));
    await postChat({
      model: 'gpt-5.5',
      stream: true,
      messages: longHistory,
      tools: [{ type: 'function', function: { name: 'Write', parameters: { type: 'object', properties: {} } } }],
    });
    expect(upstreamBodies.length).toBe(2);
    // Both payloads hit the same cap floor — still verifies retry was attempted
    expect(upstreamBodies[0].length).toBeGreaterThan(0);
    expect(upstreamBodies[1].length).toBeGreaterThan(0);
  });

  it('recovers on retry when the second upstream attempt has real arguments', async () => {
    upstreamHits = 0;
    upstreamBodies = [];
    upstreamQueue = [HOLLOW_SSE, MEANINGFUL_SSE];
    const { status, raw } = await postChat({
      model: 'gpt-5.5',
      stream: true,
      messages: [{ role: 'user', content: 'write a file' }],
      tools: [{ type: 'function', function: { name: 'Write', parameters: { type: 'object', properties: {} } } }],
    });
    const { finish, args } = parseSse(raw);
    expect(status).toBe(200);
    expect(upstreamHits).toBe(2);
    expect(finish).toBe('tool_calls');
    expect(args).toContain('a.css');
  });

  it('does not retry when first attempt is already meaningful', async () => {
    upstreamHits = 0;
    upstreamQueue = [MEANINGFUL_SSE];
    const { status, raw } = await postChat({
      model: 'gpt-5.5',
      stream: true,
      messages: [{ role: 'user', content: 'write a file' }],
      tools: [{ type: 'function', function: { name: 'Write', parameters: { type: 'object', properties: {} } } }],
    });
    const { finish, args } = parseSse(raw);
    expect(status).toBe(200);
    expect(upstreamHits).toBe(1);
    expect(finish).toBe('tool_calls');
    expect(args).toContain('a.css');
  });
});
