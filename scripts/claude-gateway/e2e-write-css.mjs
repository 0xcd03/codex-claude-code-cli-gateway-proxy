#!/usr/bin/env node
/**
 * Smoke E2E: Write tool with CSS through cdslgw route (via OmniRoute or direct gateway).
 * Usage: node e2e-write-css.mjs [baseUrl] [apiKey]
 */
import http from 'node:http';

const BASE_URL = process.argv[2] ?? 'http://127.0.0.1:20129';
const API_KEY = process.argv[3] ?? process.env.OMNIROUTE_API_KEY ?? '';
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 120_000);

if (!API_KEY) {
  process.stderr.write('Usage: OMNIROUTE_API_KEY=sk-... node e2e-write-css.mjs [baseUrl]\n');
  process.exit(1);
}

const tools = [
  {
    type: 'function',
    function: {
      name: 'Write',
      description: 'Write a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          contents: { type: 'string' },
        },
        required: ['path', 'contents'],
      },
    },
  },
];

const body = JSON.stringify({
  model: 'cdslgw/gpt-5.5',
  stream: true,
  messages: [{
    role: 'user',
    content: 'Use the Write tool once to create gpt-test/styles.css with exactly: body { margin: 0; color: #333; }',
  }],
  tools,
});

const url = new URL('/v1/chat/completions', BASE_URL);

function parseSse(raw) {
  let content = '';
  let names = [];
  let args = '';
  let finish = null;

  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') continue;
    try {
      const j = JSON.parse(payload);
      const delta = j.choices?.[0]?.delta;
      const fr = j.choices?.[0]?.finish_reason;
      if (fr) finish = fr;
      if (!delta) continue;
      if (delta.content) content += delta.content;
      for (const tc of delta.tool_calls ?? []) {
        if (tc.function?.name) names.push(tc.function.name);
        if (tc.function?.arguments) args += tc.function.arguments;
      }
    } catch {
      // ignore partial lines in aggregated output
    }
  }

  return { content, names, args, finish };
}

const payload = await new Promise((resolve, reject) => {
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
    let raw = '';
    res.setEncoding('utf8');
    res.on('data', chunk => { raw += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, raw }));
  });

  req.on('timeout', () => {
    req.destroy(new Error(`timeout after ${TIMEOUT_MS}ms`));
  });
  req.on('error', reject);
  req.write(body);
  req.end();
});

const { status, raw } = payload;
const parsed = parseSse(raw);

process.stdout.write(`HTTP ${status}\n`);
process.stdout.write(`finish_reason: ${parsed.finish}\n`);
process.stdout.write(`content: ${JSON.stringify(parsed.content.slice(0, 80))}\n`);
process.stdout.write(`tool names: ${parsed.names.join('|') || '(none)'}\n`);
process.stdout.write(`args len: ${parsed.args.length}\n`);
process.stdout.write(`args head: ${parsed.args.slice(0, 240)}\n`);

let ok = false;
if (status === 200 && parsed.names.join('').includes('Write') && parsed.args.length > 20) {
  try {
    const obj = JSON.parse(parsed.args);
    ok = typeof obj.path === 'string'
      && obj.path.includes('styles.css')
      && typeof obj.contents === 'string'
      && obj.contents.includes('margin');
    process.stdout.write(`json path: ${obj.path}\n`);
    process.stdout.write(`json contents len: ${obj.contents.length}\n`);
  } catch (err) {
    process.stdout.write(`json parse failed: ${err.message}\n`);
  }
}

process.exit(ok ? 0 : 1);
