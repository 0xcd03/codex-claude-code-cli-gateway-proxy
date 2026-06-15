import { describe, it, expect, vi } from 'vitest';
import {
  sanitizeRequest,
  profileForAttempt,
  SANITIZE_PROFILES,
  estimateRequestPayloadChars,
  sanitizeMessage,
  normalizeContent,
  messageFieldSummary,
  redactRequestSummary,
  cleanJsonSchema,
  shortenToolCallId,
  MAX_TOOL_CALL_ID_LENGTH,
  createStreamSanitizer,
  sanitizeCompletionPayload,
  TOOL_CALL_STREAM_PLACEHOLDER,
  trimRequestHistory,
  compactAssistantToolHistory,
  ensureMinMaxTokens,
  DEFAULT_MAX_HISTORY_MESSAGES,
  DEFAULT_MAX_TOOL_CONTENT_CHARS,
  DEFAULT_MAX_SYSTEM_CHARS,
  DEFAULT_MAX_TOTAL_SYSTEM_CHARS,
  DEFAULT_TOOL_CALL_TOKEN_FLOOR,
  capRequestPayload,
  compactSystemMessages,
  slimToolsForUpstream,
  normalizeCursorPathsInArgs,
  isMeaningfulToolArguments,
  stripHollowToolHistory,
  createHollowResponseDetector,
  buildAssistantTextSseChunks,
  compactToolsForPayload,
  estimateRequestPayloadChars,
  truncateToolArguments,
  pruneOldToolTurns,
} from '../codex-sanitize.mjs';

const CURSOR_TOOLS = [
  { type: 'function', function: { name: 'Shell', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'ApplyPatch', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'ReadFile', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'Write', parameters: { type: 'object', properties: {} } } },
];

describe('sanitizeRequest', () => {
  it('strips refusal:null and model prefix', () => {
    const warn = vi.fn();
    const out = sanitizeRequest({
      model: 'cdslgw/gpt-5.5',
      stream: true,
      store: true,
      messages: [{
        role: 'assistant',
        content: 'ok',
        refusal: null,
        annotations: [],
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{"path":"/tmp/f"}' } }],
      }],
      tools: [{ type: 'function', function: { name: 'Read', parameters: { type: 'object', properties: {} } } }],
    }, warn);

    expect(out.model).toBe('gpt-5.5');
    expect(out.store).toBeUndefined();
    expect(out.messages[0].refusal).toBeUndefined();
    expect(out.messages[0].annotations).toBeUndefined();
    expect(out.messages[0].tool_calls).toHaveLength(1);
  });

  it('stringifies object tool content (codex.sale rejects object tool messages)', () => {
    const warn = vi.fn();
    const out = sanitizeRequest({
      model: 'gpt-5.5',
      messages: [
        { role: 'user', content: 'run tool' },
        {
          role: 'assistant',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Shell', arguments: '{"command":"ls"}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: { stdout: 'ok', stderr: '' } },
      ],
    }, warn);

    expect(out.messages[2].content).toBe('{"stdout":"ok","stderr":""}');
    expect(warn).toHaveBeenCalledWith('stringified non-string tool content for codex.sale compatibility');
  });

  it('collapses array tool content to string without stringify fallback warn', () => {
    const warn = vi.fn();
    const out = sanitizeRequest({
      model: 'gpt-5.5',
      messages: [
        {
          role: 'assistant',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{"path":"/tmp/f"}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: 'file contents' }] },
      ],
    }, warn);

    expect(out.messages[1].content).toBe('file contents');
    expect(warn).not.toHaveBeenCalledWith('stringified non-string tool content for codex.sale compatibility');
  });

  it('stringifies multi-turn history with object tool result and strict tools', () => {
    const warn = vi.fn();
    const tools = Array.from({ length: 18 }, (_, i) => ({
      type: 'function',
      function: {
        name: `tool_${i}`,
        strict: true,
        parameters: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false },
      },
    }));

    const out = sanitizeRequest({
      model: 'cdslgw/gpt-5.5',
      stream: true,
      effort: 'medium',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'u1' },
        { role: 'user', content: 'u2' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u3' },
        { role: 'assistant', content: 'a2' },
        {
          role: 'assistant',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'tool_0', arguments: '{"path":"/tmp"}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: { stdout: 'ok', stderr: '' } },
      ],
      tools,
    }, warn);

    expect(out.messages).toHaveLength(8);
    expect(out.messages[7].content).toBe('{"stdout":"ok","stderr":""}');
    expect(out.tools).toHaveLength(18);
    expect(out.tools[0].function.strict).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('stringified non-string tool content for codex.sale compatibility');
  });

  it('replaces unserializable tool content with placeholder', () => {
    const warn = vi.fn();
    const circular = { stdout: 'ok' };
    circular.self = circular;

    const out = sanitizeRequest({
      model: 'gpt-5.5',
      messages: [
        {
          role: 'assistant',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Shell', arguments: '{"command":"ls"}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: circular },
      ],
    }, warn);

    expect(out.messages[1].content).toBe('[unserializable tool result]');
    expect(warn).toHaveBeenCalledWith('tool content is not JSON-serializable — replaced with placeholder');
  });

  it('strips strict:true from tool definitions (codex.sale rejects strict on multi-turn)', () => {
    const out = sanitizeRequest({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{
        type: 'function',
        function: {
          name: 'Read',
          strict: true,
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      }],
    });
    expect(out.tools[0].function.strict).toBeUndefined();
    expect(out.tools[0].function.name).toBe('Read');
  });

  it('recursively strips $schema and strict from tool parameters', () => {
    const warn = vi.fn();
    const out = sanitizeRequest({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{
        type: 'function',
        function: {
          name: 'Shell',
          parameters: {
            type: 'object',
            strict: true,
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            properties: {
              command: { type: 'string' },
              meta: {
                type: 'object',
                propertyNames: { type: 'string' },
                properties: { x: { type: 'string' } },
              },
            },
          },
        },
      }],
    }, warn);

    expect(JSON.stringify(out.tools[0].function.parameters)).not.toContain('$schema');
    expect(JSON.stringify(out.tools[0].function.parameters)).not.toContain('strict');
    expect(JSON.stringify(out.tools[0].function.parameters)).not.toContain('propertyNames');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('slimmed tool definitions'));
  });

  it('stringifies object tool call arguments', () => {
    const out = sanitizeRequest({
      model: 'gpt-5.5',
      messages: [{
        role: 'assistant',
        tool_calls: [{
          id: 'c1',
          type: 'function',
          function: { name: 'Shell', arguments: { command: 'ls' } },
        }],
      }],
    });

    expect(out.messages[0].tool_calls[0].function.arguments).toBe('{"command":"ls"}');
  });

  it('shortens tool_call ids longer than 64 chars and remaps tool messages', () => {
    const longId = `call_${'a'.repeat(80)}`;
    const warn = vi.fn();
    const out = sanitizeRequest({
      model: 'gpt-5.5',
      messages: [
        {
          role: 'assistant',
          tool_calls: [{ id: longId, type: 'function', function: { name: 'ReadFile', arguments: '{"path":"/tmp/f"}' } }],
        },
        { role: 'tool', tool_call_id: longId, content: 'ok' },
      ],
    }, warn);

    expect(out.messages[0].tool_calls[0].id.length).toBeLessThanOrEqual(MAX_TOOL_CALL_ID_LENGTH);
    expect(out.messages[1].tool_call_id).toBe(out.messages[0].tool_calls[0].id);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('shortened tool_call id'));
  });

  it('collapses multi-part user content arrays to a single string', () => {
    const out = sanitizeRequest({
      model: 'gpt-5.5',
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'part one' }, { type: 'text', text: 'part two' }],
      }],
    });

    expect(out.messages[0].content).toBe('part one\n\npart two');
  });

  it('parses serialized tool content arrays to plain text', () => {
    const warn = vi.fn();
    const out = sanitizeRequest({
      model: 'gpt-5.5',
      messages: [
        {
          role: 'assistant',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Shell', arguments: '{"command":"ls"}' } }],
        },
        {
          role: 'tool',
          tool_call_id: 'c1',
          content: '[{"type":"input_text","text":"tool failed"}]',
        },
      ],
    }, warn);

    expect(out.messages[1].content).toBe('tool failed');
    expect(warn).toHaveBeenCalledWith('parsed serialized tool content array to plain text for codex.sale compatibility');
  });

  it('fixes doubled tool_call names against known tools', () => {
    const warn = vi.fn();
    const out = sanitizeRequest({
      model: 'gpt-5.5',
      tools: [{ type: 'function', function: { name: 'ReadFile', parameters: { type: 'object', properties: {} } } }],
      messages: [{
        role: 'assistant',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ReadFileReadFile', arguments: '{"path":"/tmp/f"}' } }],
      }],
    }, warn);

    expect(out.messages[0].tool_calls[0].function.name).toBe('ReadFile');
    expect(warn).toHaveBeenCalledWith('fixed doubled tool_call name "ReadFileReadFile" → "ReadFile"');
  });

  it('drops invalid tool_calls with warning', () => {
    const warn = vi.fn();
    sanitizeRequest({
      model: 'gpt-5.5',
      messages: [{
        role: 'assistant',
        content: 'x',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read' } }, { id: 'bad' }],
      }],
    }, warn);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid tool_calls'));
  });

  it('filters out null/invalid messages from history', () => {
    const out = sanitizeRequest({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hi' }, null, 'badstuff'],
    });
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].content).toBe('hi');
  });

  it('trims long history and raises max_tokens when tools are present', () => {
    const warn = vi.fn();
    const messages = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < DEFAULT_MAX_HISTORY_MESSAGES + 10; i += 1) {
      messages.push({ role: 'user', content: `msg ${i}` });
      messages.push({
        role: 'assistant',
        content: 'I will save the file now.',
        tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'Write', arguments: '{}' } }],
      });
      messages.push({ role: 'tool', tool_call_id: `c${i}`, content: 'ok' });
    }

    const out = sanitizeRequest({
      model: 'gpt-5.5',
      stream: true,
      max_tokens: 256,
      tools: [{ type: 'function', function: { name: 'Write', parameters: { type: 'object', properties: {} } } }],
      messages,
    }, warn);

    expect(out.messages.length).toBeLessThan(messages.length);
    expect(out.max_tokens).toBeGreaterThanOrEqual(DEFAULT_TOOL_CALL_TOKEN_FLOOR);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('trimmed'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stripped assistant prose'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('raised max_tokens'));
  });
});

describe('capRequestPayload', () => {
  it('truncates system messages and caps total payload size', () => {
    const warn = vi.fn();
    const tools = Array.from({ length: 18 }, (_, i) => ({
      type: 'function',
      function: {
        name: `Tool${i}`,
        parameters: { type: 'object', properties: { x: { type: 'string' } } },
      },
    }));
    const messages = [{ role: 'system', content: 'mem '.repeat(20_000) }];
    for (let i = 0; i < 40; i += 1) {
      messages.push({ role: 'user', content: `u${i}` });
    }
    messages.push({ role: 'user', content: 'Write gpt-test/styles.css now' });

    const out = sanitizeRequest({ model: 'gpt-5.5', messages, tools }, warn);
    expect(out.messages[0].content.length).toBeLessThanOrEqual(DEFAULT_MAX_TOTAL_SYSTEM_CHARS);
    expect(estimateRequestPayloadChars(out)).toBeLessThanOrEqual(45_000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('truncated system content'));
    expect(out.messages.at(-1).content).toBe('Write gpt-test/styles.css now');
  });

  it('merges many system messages into one within total system budget', () => {
    const warn = vi.fn();
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: 'system',
      content: `memory-${i} `.repeat(500),
    }));
    messages.push({ role: 'user', content: 'task' });

    const out = sanitizeRequest({ model: 'gpt-5.5', messages }, warn);
    const systemMsgs = out.messages.filter(m => m.role === 'system');
    expect(systemMsgs).toHaveLength(1);
    expect(systemMsgs[0].content.length).toBeLessThanOrEqual(DEFAULT_MAX_TOTAL_SYSTEM_CHARS);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('merged 20 system messages'));
  });

  it('replaces oversize tool arguments with valid JSON', () => {
    const warn = vi.fn();
    const hugeArgs = JSON.stringify({ contents: 'x'.repeat(10_000), path: 'styles.css' });
    const out = truncateToolArguments(hugeArgs, 512, warn);
    expect(() => JSON.parse(out)).not.toThrow();
    expect(out.length).toBeLessThanOrEqual(512);
    expect(warn).toHaveBeenCalled();
  });

  it('compacts oversized tool definitions when tools dominate payload', () => {
    const warn = vi.fn();
    const tools = [{
      type: 'function',
      function: {
        name: 'Write',
        description: 'd'.repeat(20_000),
        parameters: {
          type: 'object',
          properties: {
            contents: { type: 'string', description: 'x'.repeat(20_000) },
            path: { type: 'string' },
          },
        },
      },
    }];
    const messages = [{ role: 'user', content: 'Write styles.css' }];

    const out = capRequestPayload({ model: 'gpt-5.5', messages, tools }, 5_000, warn);
    expect(estimateRequestPayloadChars(out)).toBeLessThanOrEqual(5_000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('compacted tool definitions'));
  });

  it('slims fat Cursor tool schemas before upstream', () => {
    const warn = vi.fn();
    const tools = [{
      type: 'function',
      function: {
        name: 'Write',
        description: 'x'.repeat(5_000),
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'p'.repeat(500) },
            contents: { type: 'string', description: 'c'.repeat(500) },
          },
          required: ['path', 'contents'],
          additionalProperties: false,
        },
      },
    }];
    const out = slimToolsForUpstream(tools, warn);
    expect(JSON.stringify(out).length).toBeLessThan(JSON.stringify(tools).length);
    expect(out[0].function.parameters.required).toEqual(['path', 'contents']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('slimmed tool definitions'));
  });

  it('strips /workspace/ prefix only from path field in streamed tool arguments', () => {
    expect(normalizeCursorPathsInArgs('{"path":"/workspace/gpt-test/a.css"}'))
      .toBe('{"path":"gpt-test/a.css"}');
    expect(normalizeCursorPathsInArgs('{"contents":"see /workspace/docs"}'))
      .toBe('{"contents":"see /workspace/docs"}');
  });

  it('detects hollow tool arguments', () => {
    expect(isMeaningfulToolArguments('')).toBe(false);
    expect(isMeaningfulToolArguments('{}')).toBe(false);
    expect(isMeaningfulToolArguments('{"path":"a.css"}')).toBe(true);
  });

  it('strips hollow assistant tool history from poisoned sessions', () => {
    const warn = vi.fn();
    const messages = [
      { role: 'user', content: 'write css' },
      {
        role: 'assistant',
        content: '.',
        tool_calls: [{ id: 'call_bad', type: 'function', function: { name: 'Write', arguments: '' } }],
      },
      { role: 'tool', tool_call_id: 'call_bad', content: 'error' },
      { role: 'user', content: 'try again' },
    ];
    const out = stripHollowToolHistory(messages, warn);
    expect(out).toHaveLength(2);
    expect(out.map(m => m.role)).toEqual(['user', 'user']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('hollow tool history'));
  });

  it('strips tool-only assistant turns with no content and hollow args', () => {
    const warn = vi.fn();
    const messages = [
      { role: 'user', content: 'run shell' },
      {
        role: 'assistant',
        tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'Shell', arguments: '{}' } }],
      },
      { role: 'user', content: 'retry' },
    ];
    const out = stripHollowToolHistory(messages, warn);
    expect(out).toHaveLength(2);
    expect(out.every(m => m.role === 'user')).toBe(true);
  });
});

describe('createHollowResponseDetector', () => {
  it('flags hollow when only placeholder content and empty args stream', () => {
    const d = createHollowResponseDetector();
    d.observeChunk({ choices: [{ delta: { role: 'assistant', content: '.', tool_calls: [{ index: 0, function: { name: 'Write' } }] } }] });
    d.observeChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '' } }] } }] });
    d.observeChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    expect(d.isMeaningful()).toBe(false);
    expect(d.sawToolCalls()).toBe(true);
  });

  it('flags meaningful once tool arguments accumulate into a real object', () => {
    const d = createHollowResponseDetector();
    d.observeChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'Write' } }] } }] });
    expect(d.isMeaningful()).toBe(false);
    d.observeChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] });
    d.observeChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.css"}' } }] } }] });
    expect(d.isMeaningful()).toBe(true);
  });

  it('flags meaningful on real assistant text content', () => {
    const d = createHollowResponseDetector();
    d.observeChunk({ choices: [{ delta: { content: 'Here is the answer.' } }] });
    expect(d.isMeaningful()).toBe(true);
    expect(d.sawToolCalls()).toBe(false);
  });
});

describe('buildAssistantTextSseChunks', () => {
  it('emits a content chunk and a finish:stop chunk', () => {
    const [contentLine, finishLine] = buildAssistantTextSseChunks(
      { id: 'chatcmpl_x', model: 'gpt-5.5', created: 123 },
      'fallback message',
    );
    const content = JSON.parse(contentLine.slice(6));
    const finish = JSON.parse(finishLine.slice(6));
    expect(content.choices[0].delta.content).toBe('fallback message');
    expect(content.choices[0].delta.role).toBe('assistant');
    expect(content.choices[0].finish_reason).toBeNull();
    expect(finish.choices[0].finish_reason).toBe('stop');
    expect(content.id).toBe('chatcmpl_x');
    expect(content.model).toBe('gpt-5.5');
  });

  it('synthesizes an id when meta is missing', () => {
    const [contentLine] = buildAssistantTextSseChunks(null, 'x');
    const content = JSON.parse(contentLine.slice(6));
    expect(typeof content.id).toBe('string');
    expect(content.id.length).toBeGreaterThan(0);
  });
});

describe('trimRequestHistory', () => {
  it('keeps system messages and newest turns', () => {
    const warn = vi.fn();
    const messages = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 80; i += 1) {
      messages.push({ role: 'user', content: `u${i}` });
    }

    const out = trimRequestHistory(messages, { maxMessages: 20 }, warn);
    expect(out[0]).toEqual({ role: 'system', content: 'sys' });
    expect(out.at(-1)).toEqual({ role: 'user', content: 'u79' });
    expect(out.length).toBe(21);
  });

  it('preserves the last user message untruncated', () => {
    const warn = vi.fn();
    const tail = 'WRITE styles.css NOW';
    const out = trimRequestHistory([
      { role: 'system', content: 'sys' },
      { role: 'user', content: `${'rules '.repeat(900)}${tail}` },
      { role: 'user', content: 'final task' },
    ], { maxMessageChars: 1000 }, warn);

    expect(out.at(-1).content).toBe('final task');
    expect(out[1].content.length).toBeLessThanOrEqual(1000);
    expect(out[1].content).toContain('WRITE styles.css NOW');
  });

  it('replaces extremely oversized non-last user messages with placeholder', () => {
    const warn = vi.fn();
    const out = trimRequestHistory([
      { role: 'user', content: 'x'.repeat(20_000) },
      { role: 'user', content: 'final task' },
    ], { maxMessageChars: 1000 }, warn);

    expect(out[0].content).toBe('[prior user context omitted for upstream limit]');
    expect(out.at(-1).content).toBe('final task');
  });

  it('drops orphan tool messages at trim boundary', () => {
    const warn = vi.fn();
    const out = trimRequestHistory([
      { role: 'system', content: 'sys' },
      { role: 'tool', tool_call_id: 'c1', content: 'orphan' },
      { role: 'user', content: 'continue' },
    ], { maxMessages: 2 }, warn);

    expect(out).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'continue' },
    ]);
    expect(warn).toHaveBeenCalledWith('dropped orphan tool message at trimmed history boundary');
  });
});

describe('pruneOldToolTurns', () => {
  it('keeps only recent tool turns', () => {
    const warn = vi.fn();
    const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'start' }];
    for (let i = 0; i < 20; i += 1) {
      messages.push({
        role: 'assistant',
        tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'Read', arguments: '{}' } }],
      });
      messages.push({ role: 'tool', tool_call_id: `c${i}`, content: 'x'.repeat(DEFAULT_MAX_TOOL_CONTENT_CHARS + 100) });
    }
    messages.push({ role: 'user', content: 'write css' });

    const out = pruneOldToolTurns(messages, 5, warn);
    expect(out.length).toBeLessThan(messages.length);
    expect(out.at(-1)).toEqual({ role: 'user', content: 'write css' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pruned'));
  });
});

describe('compactAssistantToolHistory', () => {
  it('removes prose from assistant tool history entries', () => {
    const warn = vi.fn();
    const out = compactAssistantToolHistory({
      role: 'assistant',
      content: 'Saving styles.css now',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Write', arguments: '{}' } }],
    }, warn);

    expect(out.content).toBeUndefined();
    expect(out.tool_calls).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith('stripped assistant prose from historical tool_calls message');
  });
});

describe('ensureMinMaxTokens', () => {
  it('raises unset max_tokens to DEFAULT_MIN_MAX_TOKENS when tools are configured', () => {
    const warn = vi.fn();
    const out = ensureMinMaxTokens({ tools: [{}] }, warn);
    expect(out.max_tokens).toBe(16384);
    expect(out.max_completion_tokens).toBe(16384);
    expect(warn).toHaveBeenCalledWith('raised max_tokens unset → 16384 for tool-call headroom');
  });

  it('raises very low max_tokens to token floor only', () => {
    const warn = vi.fn();
    const out = ensureMinMaxTokens({ tools: [{}], max_tokens: 64 }, warn);
    expect(out.max_tokens).toBe(DEFAULT_TOOL_CALL_TOKEN_FLOOR);
    expect(out.max_completion_tokens).toBe(DEFAULT_TOOL_CALL_TOKEN_FLOOR);
    expect(warn).toHaveBeenCalledWith(`raised max_tokens 64 → ${DEFAULT_TOOL_CALL_TOKEN_FLOOR} for tool-call headroom`);
  });

  it('respects explicit max_tokens at or above token floor', () => {
    const warn = vi.fn();
    const out = ensureMinMaxTokens({ tools: [{}], max_tokens: 8192 }, warn);
    expect(out.max_tokens).toBe(8192);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('shortenToolCallId', () => {
  it('keeps ids within limit unchanged', () => {
    expect(shortenToolCallId('call_short')).toBe('call_short');
  });

  it('hashes ids longer than 64 chars', () => {
    const longId = `call_${'x'.repeat(80)}`;
    const shortened = shortenToolCallId(longId);
    expect(shortened.length).toBeLessThanOrEqual(MAX_TOOL_CALL_ID_LENGTH);
    expect(shortened).toMatch(/^call_[0-9a-f]{32}$/);
  });
});

describe('cleanJsonSchema', () => {
  it('returns primitives unchanged', () => {
    expect(cleanJsonSchema('x')).toBe('x');
    expect(cleanJsonSchema(1)).toBe(1);
  });
});

describe('sanitizeMessage', () => {
  it('coerces unknown role to user', () => {
    const warn = vi.fn();
    const out = sanitizeMessage({ role: 'function', content: 'legacy' }, warn);
    expect(out).toEqual({ role: 'user', content: 'legacy' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown message role'));
  });

  it('coerces unknown role with empty content to placeholder', () => {
    const warn = vi.fn();
    const out = sanitizeMessage({ role: 'function' }, warn);
    expect(out).toEqual({ role: 'user', content: '' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown message role'));
  });

  it('returns null for non-object message', () => {
    expect(sanitizeMessage(null)).toBeNull();
    expect(sanitizeMessage('hello')).toBeNull();
  });
});

describe('normalizeContent', () => {
  it('collapses single text part to string', () => {
    expect(normalizeContent([{ type: 'text', text: 'hello' }])).toBe('hello');
  });

  it('warns on dropped part types', () => {
    const warn = vi.fn();
    const out = normalizeContent([{ type: 'input_audio', input_audio: { data: 'x' } }], warn);
    expect(out).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('input_audio'));
  });
});

describe('messageFieldSummary', () => {
  it('detects extra fields before sanitize', () => {
    const summary = messageFieldSummary([{
      role: 'assistant',
      content: 'x',
      refusal: null,
      tool_calls: [],
    }]);
    expect(summary[0].extra).toContain('refusal');
  });
});

describe('redactRequestSummary', () => {
  it('does not include message content', () => {
    const summary = redactRequestSummary({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'secret-token-12345' }],
    });
    expect(JSON.stringify(summary)).not.toContain('secret-token');
    expect(summary.messages[0].contentLength).toBeGreaterThan(0);
  });
});

describe('createStreamSanitizer', () => {
  it('fixes doubled tool name in a single SSE chunk', () => {
    const warn = vi.fn();
    const { sanitizeChunk } = createStreamSanitizer(CURSOR_TOOLS, warn);

    const out = sanitizeChunk({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'ShellShell', arguments: '' },
          }],
        },
      }],
    });

    expect(out.choices[0].delta.tool_calls[0].function.name).toBe('Shell');
    expect(warn).toHaveBeenCalledWith('fixed doubled tool_call name "ShellShell" → "Shell"');
  });

  it('suppresses duplicate name fragments that would double the tool name', () => {
    const warn = vi.fn();
    const { sanitizeChunk } = createStreamSanitizer(CURSOR_TOOLS, warn);

    const first = sanitizeChunk({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'Shell' } }] } }],
    });
    const second = sanitizeChunk({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'Shell' } }] } }],
    });

    expect(first.choices[0].delta.tool_calls[0].function.name).toBe('Shell');
    expect(second.choices[0].delta.tool_calls).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('forwards arguments-only delta after tool name is complete', () => {
    const { sanitizeChunk } = createStreamSanitizer(CURSOR_TOOLS, vi.fn());

    sanitizeChunk({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'Shell' } }] } }],
    });
    const second = sanitizeChunk({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'Shell', arguments: '{' } }] } }],
    });

    expect(second.choices[0].delta.tool_calls[0].function).toEqual({ arguments: '{' });
  });

  it('omits empty tool_calls delta entries via sanitizeSseLine', () => {
    const warn = vi.fn();
    const { sanitizeSseLine } = createStreamSanitizer(CURSOR_TOOLS, warn);

    const firstLine = sanitizeSseLine('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"Shell"}}]}}]}');
    const secondLine = sanitizeSseLine('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"Shell"}}]}}]}');

    expect(JSON.parse(firstLine.slice(6)).choices[0].delta.tool_calls[0].function.name).toBe('Shell');
    expect(JSON.parse(secondLine.slice(6)).choices[0].delta.tool_calls).toBeUndefined();
  });

  it('passes through [DONE] SSE lines unchanged', () => {
    const { sanitizeSseLine } = createStreamSanitizer(CURSOR_TOOLS, vi.fn());
    expect(sanitizeSseLine('data: [DONE]')).toBe('data: [DONE]');
  });

  it('injects placeholder content on first tool_calls delta and forwards finish even without args', () => {
    const warn = vi.fn();
    const { sanitizeChunk } = createStreamSanitizer(CURSOR_TOOLS, warn);

    const first = sanitizeChunk({
      choices: [{
        delta: {
          role: 'assistant',
          tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Shell' } }],
        },
      }],
    });

    expect(first.choices[0].delta.content).toBe(TOOL_CALL_STREAM_PLACEHOLDER);
    expect(first.choices[0].finish_reason).toBeUndefined();

    const earlyFinish = sanitizeChunk({
      choices: [{ delta: {}, finish_reason: 'stop' }],
    });
    expect(earlyFinish.choices[0].finish_reason).toBe('tool_calls');
    expect(warn).toHaveBeenCalledWith(
      'forwarding tool_calls finish despite empty upstream arguments (avoid client hang)',
    );

    sanitizeChunk({
      choices: [{
        delta: {
          tool_calls: [{ index: 0, function: { arguments: '{}' } }],
        },
      }],
    });

    const finish = sanitizeChunk({
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
    });

    expect(finish.choices[0].finish_reason).toBe('tool_calls');
    expect(first.choices[0].delta.content).toBe(TOOL_CALL_STREAM_PLACEHOLDER);
  });

  it('handles codex two-chunk finish pattern (null finish then tool_calls)', () => {
    const { sanitizeChunk } = createStreamSanitizer(CURSOR_TOOLS, vi.fn());

    sanitizeChunk({
      choices: [{
        delta: {
          role: 'assistant',
          tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Shell', arguments: '{}' } }],
        },
      }],
    });

    const penultimate = sanitizeChunk({
      choices: [{ delta: {}, finish_reason: null }],
    });
    const finish = sanitizeChunk({
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
    });

    expect(penultimate.choices[0].finish_reason).toBeNull();
    expect(finish.choices[0].finish_reason).toBe('tool_calls');
  });

  it('sanitizes every choice in multi-choice chunks', () => {
    const { sanitizeChunk } = createStreamSanitizer(CURSOR_TOOLS, vi.fn());

    const out = sanitizeChunk({
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'ShellShell' } }] } },
        { index: 1, delta: { tool_calls: [{ index: 0, function: { name: 'ReadFileReadFile' } }] } },
      ],
    });

    expect(out.choices).toHaveLength(2);
    expect(out.choices[0].delta.tool_calls[0].function.name).toBe('Shell');
    expect(out.choices[1].delta.tool_calls[0].function.name).toBe('ReadFile');
  });

  it('drops conflicting tool_call ids from later upstream chunks', () => {
    const warn = vi.fn();
    const { sanitizeChunk } = createStreamSanitizer(CURSOR_TOOLS, warn);

    const first = sanitizeChunk({
      choices: [{
        delta: {
          tool_calls: [{ index: 0, id: 'call_first', type: 'function', function: { name: 'Shell' } }],
        },
      }],
    });
    const second = sanitizeChunk({
      choices: [{
        delta: {
          tool_calls: [{ index: 0, id: 'fc_second', type: 'function', function: { arguments: '{' } }],
        },
      }],
    });

    expect(first.choices[0].delta.tool_calls[0].id).toBe('call_first');
    expect(second.choices[0].delta.tool_calls[0].id).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('dropped conflicting tool_call id "fc_second" (keeping "call_first")');
  });

  it('promotes call_* id when fc_* arrived first', () => {
    const warn = vi.fn();
    const { sanitizeChunk } = createStreamSanitizer(CURSOR_TOOLS, warn);

    const first = sanitizeChunk({
      choices: [{
        delta: {
          tool_calls: [{ index: 0, id: 'fc_first', type: 'function', function: { name: 'Shell' } }],
        },
      }],
    });
    const second = sanitizeChunk({
      choices: [{
        delta: {
          tool_calls: [{ index: 0, id: 'call_better', type: 'function', function: { arguments: '{' } }],
        },
      }],
    });

    expect(first.choices[0].delta.tool_calls[0].id).toBe('fc_first');
    expect(second.choices[0].delta.tool_calls[0].id).toBeUndefined();
    expect(second.choices[0].delta.tool_calls[0].function.arguments).toBe('{');
    expect(warn).toHaveBeenCalledWith('promoted tool_call id "fc_first" → "call_better"');
  });

  it('synthesizes a single finish chunk when stream ends without finish_reason', () => {
    const warn = vi.fn();
    const { sanitizeChunk, finalizeStream } = createStreamSanitizer(CURSOR_TOOLS, warn);

    sanitizeChunk({
      id: 'chatcmpl_test',
      model: 'gpt-5.5',
      choices: [{
        delta: {
          tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Shell', arguments: '{}' } }],
        },
      }],
    });

    const trailing = finalizeStream();
    expect(trailing).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith('synthesized tool_calls finish chunk for tool-only stream');
    const parsed = JSON.parse(trailing[0].slice(6));
    expect(parsed.choices[0].finish_reason).toBe('tool_calls');
    expect(parsed.choices[0].delta.content).toBe(TOOL_CALL_STREAM_PLACEHOLDER);
  });

  it('detects [DONE] SSE lines', () => {
    const { isDoneSseLine } = createStreamSanitizer(CURSOR_TOOLS, vi.fn());
    expect(isDoneSseLine('data: [DONE]')).toBe(true);
    expect(isDoneSseLine('data:[DONE]')).toBe(true);
    expect(isDoneSseLine('data: {"choices":[]}')).toBe(false);
  });

  it('drops assistant prose after tool_calls stream has started', () => {
    const { sanitizeChunk } = createStreamSanitizer(CURSOR_TOOLS, vi.fn());

    sanitizeChunk({
      choices: [{
        delta: {
          tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Write' } }],
        },
      }],
    });

    const prose = sanitizeChunk({
      choices: [{ delta: { content: 'Сохраняю styles.css сейчас.' } }],
    });

    expect(prose.choices[0].delta.content).toBeUndefined();
  });
});

describe('sanitizeCompletionPayload', () => {
  it('fixes doubled tool names in non-stream completion messages', () => {
    const warn = vi.fn();
    const out = sanitizeCompletionPayload({
      choices: [{
        message: {
          role: 'assistant',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'ApplyPatchApplyPatch', arguments: '{}' },
          }],
        },
      }],
    }, CURSOR_TOOLS, warn);

    expect(out.choices[0].message.tool_calls[0].function.name).toBe('ApplyPatch');
    expect(warn).toHaveBeenCalledWith('fixed doubled tool_call name "ApplyPatchApplyPatch" → "ApplyPatch"');
  });
});

describe('sanitizeRequest retry profiles', () => {
  it('shrinks bloated history more aggressively on emergency profile', () => {
    const warn = vi.fn();
    const tools = CURSOR_TOOLS;
    const messages = [{ role: 'system', content: 's'.repeat(20_000) }];
    messages.push({ role: 'user', content: 'u'.repeat(30_000) });
    for (let i = 0; i < 20; i += 1) {
      messages.push({ role: 'user', content: `step ${i}` });
      messages.push({ role: 'assistant', content: `ok ${i}` });
    }
    for (let i = 0; i < 6; i += 1) {
      messages.push({
        role: 'assistant',
        tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'Read', arguments: '{"path":"/tmp/f"}' } }],
      });
      messages.push({ role: 'tool', tool_call_id: `c${i}`, content: 'x'.repeat(5_000) });
    }
    messages.push({ role: 'user', content: 'write styles.css now' });

    const normal = sanitizeRequest({ model: 'gpt-5.5', messages, tools }, warn, {
      attemptNum: 0,
      profile: SANITIZE_PROFILES.normal,
    });
    const emergency = sanitizeRequest({ model: 'gpt-5.5', messages, tools }, warn, {
      attemptNum: 2,
      profile: SANITIZE_PROFILES.emergency,
    });

    expect(estimateRequestPayloadChars(emergency)).toBeLessThan(estimateRequestPayloadChars(normal));
    expect(emergency.messages.length).toBeLessThan(normal.messages.length);
    expect(emergency.tools.length).toBeLessThanOrEqual(8);
    expect(emergency.parallel_tool_calls).toBe(false);
    expect(profileForAttempt(0)).toBe(SANITIZE_PROFILES.normal);
    expect(profileForAttempt(2)).toBe(SANITIZE_PROFILES.emergency);
  });
});
