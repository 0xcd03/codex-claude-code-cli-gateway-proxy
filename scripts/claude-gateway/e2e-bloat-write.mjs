#!/usr/bin/env node
/**
 * E2E: Write tool with bloated history through codex-gateway (simulates long Cursor sessions).
 */
import http from 'node:http';
import fs from 'node:fs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:20132';
const API_KEY = process.argv[3]
  ?? process.env.CODEX_API_KEY
  ?? (() => {
    try {
      return fs.readFileSync('/run/secrets/codex_api_key', 'utf8').trim();
    } catch {
      return '';
    }
  })();
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 120_000);

if (!API_KEY) {
  process.stderr.write('Usage: CODEX_API_KEY=... node e2e-bloat-write.mjs [baseUrl]\n');
  process.exit(1);
}

const tools = [{
  type: 'function',
  function: {
    name: 'Write',
    description: 'Write a file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, contents: { type: 'string' } },
      required: ['path', 'contents'],
    },
  },
}];

const messages = [{ role: 'system', content: 'sys '.repeat(8000) }];
messages.push({ role: 'user', content: 'x'.repeat(42_000) });
for (let i = 0; i < 40; i += 1) {
  messages.push({ role: 'user', content: `step ${i}` });
  messages.push({ role: 'assistant', content: `ok ${i}` });
}
for (let i = 0; i < 8; i += 1) {
  messages.push({
    role: 'assistant',
    tool_calls: [{
      id: `c${i}`,
      type: 'function',
      function: { name: 'Read', arguments: '{"path":"/tmp/f"}' },
    }],
  });
  messages.push({ role: 'tool', tool_call_id: `c${i}`, content: 'out '.repeat(800) });
}
messages.push({
  role: 'user',
  content: 'Use Write once to create gpt-test/styles.css with body { margin: 0; color: #333; }',
});

const body = JSON.stringify({ model: 'gpt-5.5', stream: true, messages, tools });
const url = new URL('/v1/chat/completions', BASE);

const { status, raw } = await new Promise((resolve, reject) => {
  const req = http.request({
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
    timeout: TIMEOUT_MS,
  }, res => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, raw: data }));
  });
  req.on('timeout', () => req.destroy(new Error(`timeout after ${TIMEOUT_MS}ms`)));
  req.on('error', reject);
  req.write(body);
  req.end();
});

let args = '';
let names = [];
let finish = null;
let content = '';

for (const line of raw.split('\n')) {
  if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
  try {
    const j = JSON.parse(line.slice(6));
    const delta = j.choices?.[0]?.delta;
    if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
    if (delta?.content) content += delta.content;
    for (const tc of delta?.tool_calls ?? []) {
      if (tc.function?.name) names.push(tc.function.name);
      if (tc.function?.arguments) args += tc.function.arguments;
    }
  } catch {
    // ignore
  }
}

process.stdout.write(`HTTP ${status}\n`);
process.stdout.write(`finish_reason: ${finish}\n`);
process.stdout.write(`tool names: ${names.join('|') || '(none)'}\n`);
process.stdout.write(`args len: ${args.length}\n`);
process.stdout.write(`content len: ${content.length}\n`);

let ok = false;
if (status === 200 && args.length > 20) {
  try {
    const obj = JSON.parse(args);
    ok = typeof obj.path === 'string'
      && obj.path.includes('styles.css')
      && typeof obj.contents === 'string'
      && obj.contents.includes('margin');
    process.stdout.write(`json path: ${obj.path}\n`);
  } catch (err) {
    process.stdout.write(`json parse failed: ${err.message}\n`);
    process.stdout.write(`content head: ${content.slice(0, 200)}\n`);
  }
}

process.exit(ok ? 0 : 1);
