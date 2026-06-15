import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { pipeStream } from '../codex-gateway.mjs';
import { TOOL_CALL_STREAM_PLACEHOLDER } from '../codex-sanitize.mjs';

const CURSOR_TOOLS = [
  { type: 'function', function: { name: 'Shell', parameters: { type: 'object', properties: {} } } },
];

function createMockResponse() {
  const chunks = [];
  const res = new EventEmitter();
  res.writableEnded = false;
  res.destroyed = false;
  res.write = vi.fn(data => {
    chunks.push(String(data));
    return true;
  });
  res.end = vi.fn(() => {
    res.writableEnded = true;
  });
  return { res, chunks, output: () => chunks.join('') };
}

function runPipeStream(upstreamBody, toolNames = new Set(['Shell'])) {
  const upstream = Readable.from([upstreamBody]);
  const clientReq = new EventEmitter();
  const { res, output } = createMockResponse();
  pipeStream(upstream, res, upstream, clientReq, toolNames);
  return new Promise(resolve => {
    upstream.on('end', () => setTimeout(() => resolve(output()), 0));
  });
}

describe('pipeStream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes finalizeStream chunks before [DONE]', async () => {
    const upstreamBody = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Shell","arguments":"{}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');

    const out = await runPipeStream(upstreamBody);
    const doneIndex = out.indexOf('data: [DONE]');
    const finishIndex = out.indexOf('"finish_reason":"tool_calls"');

    expect(finishIndex).toBeGreaterThan(-1);
    expect(doneIndex).toBeGreaterThan(finishIndex);
    expect(out).toContain(TOOL_CALL_STREAM_PLACEHOLDER);
  });

  it('preserves upstream finish chunk before [DONE] when finish_reason is present', async () => {
    const upstreamBody = [
      'data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Shell","arguments":"{}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');

    const out = await runPipeStream(upstreamBody);
    const doneIndex = out.indexOf('data: [DONE]');
    const finishIndex = out.indexOf('"finish_reason":"tool_calls"');

    expect(finishIndex).toBeGreaterThan(-1);
    expect(doneIndex).toBeGreaterThan(finishIndex);
    expect(out).toContain(TOOL_CALL_STREAM_PLACEHOLDER);
  });
});
