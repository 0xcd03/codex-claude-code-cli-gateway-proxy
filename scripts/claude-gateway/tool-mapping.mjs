/**
 * Shared tool mapping: Cursor (OpenAI) ↔ Claude CLI / Codex CLI.
 *
 * Cursor tool names and required params are the source of truth.
 * Claude CLI has its own naming; this module remaps both directions.
 * Codex CLI uses dynamicTools — tool names are passed through as-is,
 * but argument remapping may be needed if Codex uses different param keys.
 */

// ── Cursor tool spec (source of truth) ──────────────────────────────────────

export const CURSOR_TOOL_PARAMS = {
  Write:          ['path', 'contents'],
  Read:           ['path'],
  ReadFile:       ['path'],
  StrReplace:     ['path', 'old_string', 'new_string'],
  Edit:           ['path', 'old_string', 'new_string'],
  Delete:         ['path'],
  Glob:           ['glob_pattern'],
  Grep:           ['pattern'],
  Shell:          ['command'],
  Bash:           ['command'],
  Task:           ['description', 'prompt'],
  SemanticSearch: ['query'],
  CallMcpTool:    ['server', 'toolName', 'arguments'],
  TodoWrite:      ['todos', 'merge'],
  AskQuestion:    ['questions'],
  SwitchMode:     ['target_mode_id'],
  GenerateImage:  ['description'],
  EditNotebook:   ['target_notebook', 'cell_idx', 'new_string'],
  WebSearch:      ['search_term'],
  WebFetch:       ['url'],
};

// ── Claude → Cursor: tool name mapping ─────────────────────────────────────

export const CLAUDE_TO_CURSOR_TOOL = {
  Write:        'Write',
  Bash:         'Shell',
  Read:         'Read',
  Edit:         'StrReplace',
  Glob:         'Glob',
  Grep:         'Grep',
  WebSearch:    'WebSearch',
  WebFetch:     'WebFetch',
  Task:         'Task',
  AskUserQuestion: 'AskQuestion',
  TodoWrite:    'TodoWrite',
};

// ── Claude → Cursor: argument key remapping ────────────────────────────────

const CLAUDE_ARG_REMAP = {
  Write:           { file_path: 'path',     content: 'contents' },
  Read:            { file_path: 'path' },
  Edit:            { file_path: 'path' },   // old_string, new_string stay same
  Glob:            { pattern: 'glob_pattern' },
  WebSearch:       { searchTerm: 'search_term' },
  AskUserQuestion: { prompt: 'prompt',      options: 'options' },
};

/**
 * Remap Claude tool_use arguments to Cursor-compatible keys.
 * Deletes old keys after remapping.
 */
export function remapClaudeArgs(claudeToolName, argsJson) {
  if (!argsJson) return '{}';
  let obj;
  try { obj = JSON.parse(argsJson); } catch { return argsJson; }
  const map = CLAUDE_ARG_REMAP[claudeToolName];
  if (!map) return argsJson;
  for (const [from, to] of Object.entries(map)) {
    if (obj[from] !== undefined) {
      obj[to] = obj[from];
      if (from !== to) delete obj[from];
    }
  }
  return JSON.stringify(obj);
}

// ── Cursor → Claude: for --allowedTools ────────────────────────────────────

const CURSOR_TO_CLAUDE_ALLOWED = {
  Write:        'Write',
  Shell:        'Bash',
  Read:         'Read',
  ReadFile:     'Read',
  StrReplace:   'Edit',
  Edit:         'Edit',
  Glob:         'Glob',
  Grep:         'Grep',
  WebSearch:    'WebSearch',
  WebFetch:     'WebFetch',
  Task:         'Task',
  AskQuestion:  'AskUserQuestion',
  TodoWrite:    'TodoWrite',
  CallMcpTool:  'Write',  // MCP tools → Claude Write (closest equivalent)
  SemanticSearch: null,   // Claude has no equivalent — skip
  Delete:       'Bash',   // Claude has no Delete — use Bash rm
  SwitchMode:   null,
  GenerateImage: null,
  EditNotebook: null,
};

/**
 * Build --allowedTools list from Cursor tool definitions.
 * Unknown tools (null in mapping) are silently excluded.
 */
export function buildClaudeAllowedTools(cursorTools) {
  if (!Array.isArray(cursorTools)) {
    return 'Write,Read,Edit,Glob,Grep,Bash,WebSearch,WebFetch,Task,AskUserQuestion';
  }
  const names = new Set();
  for (const t of cursorTools) {
    const name = t?.function?.name;
    const mapped = name ? CURSOR_TO_CLAUDE_ALLOWED[name] : undefined;
    if (mapped) names.add(mapped);
  }
  return names.size > 0 ? [...names].join(',') : 'Write,Read';
}
