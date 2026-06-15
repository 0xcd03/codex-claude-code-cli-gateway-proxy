import { describe, it, expect } from 'vitest';
import {
  buildClaudeAllowedTools,
  CLAUDE_TO_CURSOR_TOOL,
  remapClaudeArgs,
} from '../tool-mapping.mjs';
import { ClaudeToolBridge } from '../claude-bridge.mjs';

describe('buildClaudeAllowedTools', () => {
  it('maps Cursor tool names to Claude tool names', () => {
    const tools = [
      { type: 'function', function: { name: 'Write' } },
      { type: 'function', function: { name: 'Shell' } },
      { type: 'function', function: { name: 'ReadFile' } },
      { type: 'function', function: { name: 'Glob' } },
    ];
    const result = buildClaudeAllowedTools(tools);
    expect(result).toContain('Write');
    expect(result).toContain('Bash');
    expect(result).toContain('Read');
    expect(result).toContain('Glob');
  });

  it('returns defaults for empty/null tools', () => {
    const result = buildClaudeAllowedTools(null);
    expect(result).toContain('Write');
    expect(result).toContain('Read');
  });

  it('excludes unknown tools like SemanticSearch', () => {
    const tools = [
      { type: 'function', function: { name: 'Write' } },
      { type: 'function', function: { name: 'SemanticSearch' } },
    ];
    const result = buildClaudeAllowedTools(tools);
    expect(result).toContain('Write');
    expect(result).not.toContain('SemanticSearch');
  });

  it('maps StrReplace → Edit', () => {
    const result = buildClaudeAllowedTools([{ type: 'function', function: { name: 'StrReplace' } }]);
    expect(result).toBe('Edit');
  });
});

describe('CLAUDE_TO_CURSOR_TOOL', () => {
  it('maps all Claude tools to correct Cursor names', () => {
    expect(CLAUDE_TO_CURSOR_TOOL.Write).toBe('Write');
    expect(CLAUDE_TO_CURSOR_TOOL.Bash).toBe('Shell');
    expect(CLAUDE_TO_CURSOR_TOOL.Read).toBe('Read');
    expect(CLAUDE_TO_CURSOR_TOOL.Edit).toBe('StrReplace');
    expect(CLAUDE_TO_CURSOR_TOOL.Glob).toBe('Glob');
    expect(CLAUDE_TO_CURSOR_TOOL.Grep).toBe('Grep');
  });
});

describe('remapClaudeArgs', () => {
  it('remaps Write: file_path→path, content→contents', () => {
    const result = remapClaudeArgs('Write', '{"file_path":"/a/b","content":"hi"}');
    const obj = JSON.parse(result);
    expect(obj.path).toBe('/a/b');
    expect(obj.contents).toBe('hi');
    expect(obj.file_path).toBeUndefined();
    expect(obj.content).toBeUndefined();
  });

  it('remaps Read: file_path→path', () => {
    const result = remapClaudeArgs('Read', '{"file_path":"/a/b"}');
    const obj = JSON.parse(result);
    expect(obj.path).toBe('/a/b');
    expect(obj.file_path).toBeUndefined();
  });

  it('remaps Edit: file_path→path, keeps old_string, new_string', () => {
    const result = remapClaudeArgs('Edit', '{"file_path":"/a/b","old_string":"x","new_string":"y"}');
    const obj = JSON.parse(result);
    expect(obj.path).toBe('/a/b');
    expect(obj.old_string).toBe('x');
    expect(obj.new_string).toBe('y');
  });

  it('remaps Glob: pattern→glob_pattern', () => {
    const result = remapClaudeArgs('Glob', '{"pattern":"*.js"}');
    const obj = JSON.parse(result);
    expect(obj.glob_pattern).toBe('*.js');
    expect(obj.pattern).toBeUndefined();
  });

  it('passes through unknown tools unchanged', () => {
    const result = remapClaudeArgs('UnknownTool', '{"x":1}');
    expect(result).toBe('{"x":1}');
  });
});

describe('ClaudeToolBridge', () => {
  it('builds correct env', () => {
    const bridge = new ClaudeToolBridge({
      bin: '/usr/bin/claude',
      apiKey: 'sk-test',
      baseUrl: 'https://test.example.com',
      homeDir: '/home/test',
    });
    const env = bridge.buildEnv();
    expect(env.HOME).toBe('/home/test');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://test.example.com');
    expect(env.DISABLE_TELEMETRY).toBe('1');
  });
});
