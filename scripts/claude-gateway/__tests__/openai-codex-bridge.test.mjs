import { describe, it, expect } from 'vitest';
import {
  openAiToolsToDynamicTools,
  messagesToTurnText,
} from '../openai-codex-bridge.mjs';

describe('openAiToolsToDynamicTools', () => {
  it('maps OpenAI function tools to Codex dynamicTools', () => {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'Write',
          description: 'Write a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      },
      { type: 'function', function: { name: 'Shell' } },
      { type: 'retrieval' },
    ];
    const out = openAiToolsToDynamicTools(tools);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      name: 'Write',
      description: 'Write a file',
      deferLoading: false,
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    });
    expect(out[1].name).toBe('Shell');
  });

  it('returns empty array for missing tools', () => {
    expect(openAiToolsToDynamicTools(null)).toEqual([]);
    expect(openAiToolsToDynamicTools([])).toEqual([]);
  });
});

describe('messagesToTurnText', () => {
  it('builds transcript with roles and tool calls', () => {
    const text = messagesToTurnText([
      { role: 'system', content: 'Be helpful' },
      { role: 'user', content: 'Create file' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'Write', arguments: '{"path":"a.txt"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
    ]);
    expect(text).toContain('[SYSTEM]\nBe helpful');
    expect(text).toContain('[USER]\nCreate file');
    expect(text).toContain('[ASSISTANT TOOL_CALL Write]');
    expect(text).toContain('{"path":"a.txt"}');
    expect(text).toContain('[TOOL RESULT call_1]\nok');
  });

  it('handles multimodal text parts', () => {
    const text = messagesToTurnText([
      { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image_url', url: 'x' }] },
    ]);
    expect(text).toBe('[USER]\nhello');
  });
});
