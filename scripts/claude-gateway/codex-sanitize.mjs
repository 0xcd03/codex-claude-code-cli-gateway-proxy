/**
 * Request sanitization for codex.sale upstream compatibility.
 */
import crypto from 'node:crypto';

function envPositiveInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const MAX_TOOL_CALL_ID_LENGTH = 64;
export const DEFAULT_MAX_HISTORY_MESSAGES = envPositiveInt('CODEX_MAX_HISTORY_MESSAGES', 32);
export const DEFAULT_MAX_MESSAGE_CHARS = envPositiveInt('CODEX_MAX_MESSAGE_CHARS', 8_000);
export const DEFAULT_MAX_SYSTEM_CHARS = envPositiveInt('CODEX_MAX_SYSTEM_CHARS', 4_096);
export const DEFAULT_MAX_TOTAL_SYSTEM_CHARS = envPositiveInt('CODEX_MAX_TOTAL_SYSTEM_CHARS', 8_192);
export const DEFAULT_MAX_TOOL_CONTENT_CHARS = envPositiveInt('CODEX_MAX_TOOL_CONTENT_CHARS', 2_048);
export const DEFAULT_MAX_TOOL_TURNS = envPositiveInt('CODEX_MAX_TOOL_TURNS', 4);
export const DEFAULT_OVERSIZED_USER_PLACEHOLDER = '[prior user context omitted for upstream limit]';
export const DEFAULT_OVERSIZED_USER_REPLACE_CHARS = envPositiveInt('CODEX_OVERSIZED_USER_REPLACE_CHARS', 12_000);
export const DEFAULT_MAX_REQUEST_PAYLOAD_CHARS = envPositiveInt('CODEX_MAX_REQUEST_PAYLOAD_CHARS', 45_000);
export const DEFAULT_MIN_MAX_TOKENS = envPositiveInt('CODEX_MIN_MAX_TOKENS', 16_384);
export const DEFAULT_TOOL_CALL_TOKEN_FLOOR = envPositiveInt('CODEX_TOOL_CALL_TOKEN_FLOOR', 4_096);
export const DEFAULT_MAX_TOOL_DESCRIPTION_CHARS = envPositiveInt('CODEX_MAX_TOOL_DESCRIPTION_CHARS', 120);
export const DEFAULT_TOOL_PAYLOAD_BUDGET_CHARS = envPositiveInt('CODEX_TOOL_PAYLOAD_BUDGET_CHARS', 12_000);

/** Core Cursor tools kept on emergency hollow-retry profile. */
export const ESSENTIAL_CURSOR_TOOL_NAMES = new Set([
  'Write',
  'Read',
  'Shell',
  'StrReplace',
  'Grep',
  'Glob',
  'Delete',
  'SemanticSearch',
]);

/** Progressive sanitization when codex.sale returns hollow tool_calls (out=1). */
export const SANITIZE_PROFILES = {
  normal: {
    maxHistoryMessages: DEFAULT_MAX_HISTORY_MESSAGES,
    maxToolTurns: DEFAULT_MAX_TOOL_TURNS,
    maxPayloadChars: DEFAULT_MAX_REQUEST_PAYLOAD_CHARS,
    systemMaxChars: DEFAULT_MAX_SYSTEM_CHARS,
    totalSystemMaxChars: DEFAULT_MAX_TOTAL_SYSTEM_CHARS,
    essentialToolsOnly: false,
    retryNudge: false,
  },
  retry: {
    maxHistoryMessages: envPositiveInt('CODEX_RETRY_MAX_HISTORY_MESSAGES', 10),
    maxToolTurns: envPositiveInt('CODEX_RETRY_MAX_TOOL_TURNS', 2),
    maxPayloadChars: envPositiveInt('CODEX_RETRY_MAX_PAYLOAD_CHARS', 22_000),
    systemMaxChars: envPositiveInt('CODEX_RETRY_MAX_SYSTEM_CHARS', 2_048),
    totalSystemMaxChars: envPositiveInt('CODEX_RETRY_MAX_TOTAL_SYSTEM_CHARS', 4_096),
    essentialToolsOnly: false,
    retryNudge: true,
  },
  emergency: {
    maxHistoryMessages: envPositiveInt('CODEX_EMERGENCY_MAX_HISTORY_MESSAGES', 6),
    maxToolTurns: envPositiveInt('CODEX_EMERGENCY_MAX_TOOL_TURNS', 1),
    maxPayloadChars: envPositiveInt('CODEX_EMERGENCY_MAX_PAYLOAD_CHARS', 12_000),
    systemMaxChars: envPositiveInt('CODEX_EMERGENCY_MAX_SYSTEM_CHARS', 1_024),
    totalSystemMaxChars: envPositiveInt('CODEX_EMERGENCY_MAX_TOTAL_SYSTEM_CHARS', 2_048),
    essentialToolsOnly: true,
    retryNudge: true,
  },
};

export function profileForAttempt(attemptNum) {
  if (attemptNum <= 0) return SANITIZE_PROFILES.normal;
  if (attemptNum === 1) return SANITIZE_PROFILES.retry;
  return SANITIZE_PROFILES.emergency;
}

const RETRY_TOOL_NUDGE = '\n\n[Use one tool_call with complete JSON arguments.]';

function appendRetryNudge(messages, onWarn) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role !== 'user') continue;
    if (typeof msg.content === 'string' && msg.content.includes(RETRY_TOOL_NUDGE.trim())) {
      return messages;
    }
    const out = [...messages];
    out[i] = {
      ...msg,
      content: `${msg.content}${RETRY_TOOL_NUDGE}`,
    };
    onWarn?.('appended retry nudge to last user message for hollow upstream recovery');
    return out;
  }
  return messages;
}

function filterEssentialTools(tools, onWarn) {
  if (!Array.isArray(tools) || !tools.length) return tools;
  const kept = tools.filter(tool => ESSENTIAL_CURSOR_TOOL_NAMES.has(tool?.function?.name));
  if (kept.length < tools.length) {
    onWarn?.(
      `emergency profile: kept ${kept.length}/${tools.length} essential tools for upstream recovery`,
    );
  }
  return kept.length ? kept : tools;
}

/** Minimal upstream schemas for Cursor agent tools — keeps codex.sale from choking on 70KB+ tool JSON. */
const CURSOR_TOOL_REQUIRED_PARAMS = {
  Write: ['path', 'contents'],
  Read: ['path'],
  StrReplace: ['path', 'old_string', 'new_string'],
  Delete: ['path'],
  Glob: ['glob_pattern'],
  Grep: ['pattern'],
  Shell: ['command'],
  Task: ['description', 'prompt'],
  SemanticSearch: ['query'],
  CallMcpTool: ['server', 'toolName', 'arguments'],
  TodoWrite: ['todos', 'merge'],
  AskQuestion: ['questions'],
  SwitchMode: ['target_mode_id'],
  GenerateImage: ['description'],
  EditNotebook: ['target_notebook', 'cell_idx', 'new_string'],
  FetchMcpResource: ['server', 'uri'],
  Await: ['task_id'],
  WebSearch: ['search_term'],
};

export const MESSAGE_KEYS = {
  system: new Set(['role', 'content', 'name']),
  user: new Set(['role', 'content', 'name']),
  assistant: new Set(['role', 'content', 'tool_calls']),
  tool: new Set(['role', 'content', 'tool_call_id']),
  developer: new Set(['role', 'content']),
};

export const REQUEST_KEYS = new Set([
  'model', 'messages', 'stream', 'tools', 'tool_choice', 'max_tokens',
  'max_completion_tokens',
  'temperature', 'top_p', 'n', 'stop', 'presence_penalty', 'frequency_penalty',
  'response_format', 'seed', 'logit_bias', 'user', 'reasoning_effort', 'effort',
  'parallel_tool_calls',
]);

const TOOL_CALL_KEYS = new Set(['id', 'type', 'function']);
const FUNCTION_KEYS = new Set(['name', 'arguments']);
const TOOL_DEF_KEYS = new Set(['type', 'function']);
const FUNCTION_DEF_KEYS = new Set(['name', 'description', 'parameters']);

const SCHEMA_STRIP_KEYS = new Set([
  '$schema',
  '$id',
  '$defs',
  '$ref',
  'strict',
  'propertyNames',
]);

export function shortenToolCallId(id) {
  if (typeof id !== 'string' || id.length <= MAX_TOOL_CALL_ID_LENGTH) return id;
  const hash = crypto.createHash('sha256').update(id).digest('hex').slice(0, 32);
  return `call_${hash}`;
}

function buildToolCallIdMap(messages, onWarn) {
  const map = new Map();
  for (const msg of messages ?? []) {
    if (!msg || typeof msg !== 'object') continue;
    for (const tc of msg.tool_calls ?? []) {
      if (typeof tc?.id === 'string' && tc.id.length > MAX_TOOL_CALL_ID_LENGTH) {
        map.set(tc.id, shortenToolCallId(tc.id));
        onWarn?.(`shortened tool_call id from ${tc.id.length} to ${map.get(tc.id).length} chars for codex.sale compatibility`);
      }
    }
    if (typeof msg.tool_call_id === 'string' && msg.tool_call_id.length > MAX_TOOL_CALL_ID_LENGTH) {
      if (!map.has(msg.tool_call_id)) {
        map.set(msg.tool_call_id, shortenToolCallId(msg.tool_call_id));
        onWarn?.(`shortened tool_call_id from ${msg.tool_call_id.length} to ${map.get(msg.tool_call_id).length} chars for codex.sale compatibility`);
      }
    }
  }
  return map;
}

export function collectToolNames(tools) {
  return new Set(
    (tools ?? [])
      .map(tool => tool?.function?.name)
      .filter((name) => typeof name === 'string' && name.length),
  );
}

function fixToolCallName(name, toolNames, onWarn, { responseMode = false } = {}) {
  if (!toolNames.size || toolNames.has(name)) return name;

  for (const toolName of toolNames) {
    if (name === `${toolName}${toolName}`) {
      onWarn?.(`fixed doubled tool_call name "${name}" → "${toolName}"`);
      return toolName;
    }
  }

  if (!responseMode) {
    for (const toolName of toolNames) {
      if (name.endsWith(toolName) && name.length > toolName.length) {
        onWarn?.(`fixed unknown tool_call name "${name}" → "${toolName}"`);
        return toolName;
      }
    }
  }

  return name;
}

function sanitizeResponseToolCalls(toolCalls, toolNames, onWarn) {
  const ctx = { toolNames, onWarn, idMap: new Map(), responseMode: true };
  return (toolCalls ?? [])
    .map(tc => sanitizeToolCall(tc, ctx))
    .filter(Boolean);
}

/**
 * Rewrites OpenAI chat completion payloads so Cursor receives valid tool names.
 */
export function sanitizeCompletionPayload(payload, tools, onWarn) {
  if (!payload || typeof payload !== 'object') return payload;

  const toolNames = tools instanceof Set ? tools : collectToolNames(tools);
  if (!toolNames.size) return payload;

  const out = payload;
  for (const choice of out.choices ?? []) {
    if (choice?.message?.tool_calls?.length) {
      choice.message.tool_calls = sanitizeResponseToolCalls(
        choice.message.tool_calls,
        toolNames,
        onWarn,
      );
    }
  }
  return out;
}

function hasForwardableToolCallDelta(tc) {
  if (!tc || typeof tc !== 'object') return false;
  if (tc.id || tc.type) return true;
  if (tc.function && Object.keys(tc.function).length > 0) return true;
  return false;
}

/** Visible placeholder so OmniRoute content buffer stays non-empty after tool_calls. */
export const TOOL_CALL_STREAM_PLACEHOLDER = '.';

function isDoneSseLine(line) {
  if (!line.startsWith('data:')) return false;
  const payload = line.slice(5).trimStart().replace(/\r$/, '');
  return payload === '[DONE]';
}

function preferToolCallId(current, incoming) {
  if (!current) return incoming;
  if (!incoming) return current;
  const currentIsCall = current.startsWith('call_');
  const incomingIsCall = incoming.startsWith('call_');
  if (incomingIsCall && !currentIsCall) return incoming;
  return current;
}

function stripToolCallDeltaFields(tc, { id } = {}) {
  const out = {};
  if (tc.index !== undefined) out.index = tc.index;
  if (id) out.id = id;
  if (tc.type) out.type = tc.type;
  return out;
}

function createToolCallFinishChunk(sourceChunk) {
  return {
    id: sourceChunk?.id,
    object: sourceChunk?.object ?? 'chat.completion.chunk',
    created: sourceChunk?.created,
    model: sourceChunk?.model,
    choices: [{
      index: 0,
      delta: { content: TOOL_CALL_STREAM_PLACEHOLDER },
      finish_reason: 'tool_calls',
    }],
  };
}

/**
 * Stateful SSE response sanitizer for codex.sale → Cursor:
 * - fixes doubled tool names in streaming deltas
 * - stabilizes tool_call ids (prefers call_* over fc_*)
 * - normalizes finish_reason and injects placeholder content for tool-only turns
 */
export function createStreamSanitizer(tools, onWarn) {
  const toolNames = tools instanceof Set ? tools : collectToolNames(tools);
  const byIndex = new Map();
  const streamState = {
    hasToolCalls: false,
    hasContent: false,
    hasReasoning: false,
    roleSent: false,
    finishReasonSeen: false,
    lastChunkMeta: null,
  };

  function stripSpuriousContentDelta(delta) {
    if (!delta || typeof delta !== 'object') return delta;
    const content = delta.content;
    if (
      streamState.hasToolCalls
      && typeof content === 'string'
      && content.length > 0
      && content !== TOOL_CALL_STREAM_PLACEHOLDER
    ) {
      const next = { ...delta };
      delete next.content;
      return next;
    }
    return delta;
  }

  function noteDeltaText(delta) {
    if (!delta || typeof delta !== 'object') return;
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      streamState.hasContent = true;
    }
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      streamState.hasReasoning = true;
    }
    if (delta.role === 'assistant') {
      streamState.roleSent = true;
    }
  }

  function hasAnyToolArguments() {
    for (const state of byIndex.values()) {
      if (isMeaningfulToolArguments(state.argBuf)) return true;
    }
    return false;
  }

  function warnEmptyToolArguments() {
    for (const [key, state] of byIndex.entries()) {
      if (state.nameSent && !isMeaningfulToolArguments(state.argBuf)) {
        onWarn?.(`tool call "${state.nameSent}" finished with empty arguments (index ${key})`);
      }
    }
  }

  function ensureToolCallContent(delta) {
    const next = { ...delta };
    if (next.content == null || next.content === '') {
      next.content = TOOL_CALL_STREAM_PLACEHOLDER;
      streamState.hasContent = true;
    }
    return next;
  }

  function resolveToolCallId(state, rawId) {
    if (!rawId) return undefined;

    if (!state.canonicalId) {
      state.canonicalId = rawId;
      return rawId;
    }

    const preferred = preferToolCallId(state.canonicalId, rawId);
    if (preferred !== state.canonicalId) {
      onWarn?.(`promoted tool_call id "${state.canonicalId}" → "${preferred}"`);
      state.canonicalId = preferred;
      return state.idEmitted ? undefined : preferred;
    }

    if (rawId === state.canonicalId) {
      return state.idEmitted ? undefined : rawId;
    }

    onWarn?.(
      `dropped conflicting tool_call id "${rawId}" (keeping "${state.canonicalId}")`,
    );
    return undefined;
  }

  function processToolCallDelta(tc, choiceIndex = 0) {
    if (!tc || typeof tc !== 'object') return undefined;

    const index = tc.index ?? 0;
    const stateKey = `${choiceIndex}:${index}`;
    if (!byIndex.has(stateKey)) {
      byIndex.set(stateKey, {
        nameBuf: '', nameSent: '', canonicalId: undefined, idEmitted: false, argBuf: '',
      });
    }
    const state = byIndex.get(stateKey);
    const resolvedId = resolveToolCallId(state, tc.id);
    const out = stripToolCallDeltaFields(tc, { id: resolvedId });
    if (resolvedId) state.idEmitted = true;

    if (!tc.function || typeof tc.function !== 'object') {
      if (hasForwardableToolCallDelta(out)) {
        streamState.hasToolCalls = true;
        return out;
      }
      return undefined;
    }

    const fnOut = {};
    const hasArguments = tc.function.arguments !== undefined && tc.function.arguments !== null;

    if (typeof tc.function.name === 'string' && tc.function.name.length) {
      const frag = tc.function.name;

      if (state.nameSent && toolNames.has(state.nameSent) && frag === state.nameSent) {
        if (!hasArguments) return undefined;
      } else {
        state.nameBuf += frag;
        const fixed = fixToolCallName(state.nameBuf, toolNames, onWarn, { responseMode: true });
        state.nameBuf = fixed;
        const deltaName = fixed.slice(state.nameSent.length);
        state.nameSent = fixed;
        if (deltaName) fnOut.name = deltaName;
      }
    }

    if (hasArguments) {
      fnOut.arguments = normalizeCursorPathsInArgs(tc.function.arguments);
      state.argBuf = (state.argBuf ?? '') + tc.function.arguments;
    }

    if (Object.keys(fnOut).length) {
      out.function = fnOut;
    }

    if (!hasForwardableToolCallDelta(out)) return undefined;

    streamState.hasToolCalls = true;
    return out;
  }

  function normalizeFinishChoice(outChoice) {
    if (outChoice.finish_reason === undefined || outChoice.finish_reason === null) {
      return;
    }

    if (!streamState.hasToolCalls) {
      streamState.finishReasonSeen = true;
      return;
    }

    streamState.finishReasonSeen = true;
    if (!hasAnyToolArguments()) {
      onWarn?.('forwarding tool_calls finish despite empty upstream arguments (avoid client hang)');
    } else {
      warnEmptyToolArguments();
    }

    if (outChoice.finish_reason !== 'tool_calls') {
      onWarn?.(
        `normalized finish_reason "${outChoice.finish_reason}" → "tool_calls" after tool_calls stream`,
      );
      outChoice.finish_reason = 'tool_calls';
    }

    if (!streamState.hasContent && !streamState.hasReasoning) {
      outChoice.delta = ensureToolCallContent(outChoice.delta ?? {});
    }
  }

  function sanitizeChoice(choice) {
    if (!choice) return choice;

    const outChoice = { ...choice };
    const choiceIndex = outChoice.index ?? 0;

    if (outChoice.delta && typeof outChoice.delta === 'object') {
      outChoice.delta = stripSpuriousContentDelta(outChoice.delta);
    }
    noteDeltaText(outChoice.delta);

    if (outChoice.delta?.tool_calls?.length) {
      const toolCalls = outChoice.delta.tool_calls
        .map(tc => processToolCallDelta(tc, choiceIndex))
        .filter(Boolean);

      const delta = { ...outChoice.delta };
      if (toolCalls.length) {
        delta.tool_calls = toolCalls;
        if (
          typeof delta.content === 'string'
          && delta.content !== TOOL_CALL_STREAM_PLACEHOLDER
        ) {
          delete delta.content;
        }
        if (!streamState.hasContent && !streamState.hasReasoning) {
          Object.assign(delta, ensureToolCallContent({}));
        }
        if (!streamState.roleSent) {
          delta.role = 'assistant';
          streamState.roleSent = true;
        }
      } else {
        delete delta.tool_calls;
      }
      outChoice.delta = delta;
      if (toolCalls.length) {
        outChoice.delta = stripSpuriousContentDelta(outChoice.delta);
      }
    }

    if (outChoice.message?.tool_calls?.length) {
      streamState.hasToolCalls = true;
      outChoice.message = {
        ...outChoice.message,
        tool_calls: sanitizeResponseToolCalls(
          outChoice.message.tool_calls,
          toolNames,
          onWarn,
        ),
      };
      if (
        typeof outChoice.message.content === 'string'
        && outChoice.message.content.length > 0
      ) {
        streamState.hasContent = true;
      }
    }

    normalizeFinishChoice(outChoice);
    return outChoice;
  }

  function sanitizeChunk(chunk) {
    if (!chunk?.choices?.length) return chunk;
    if (!toolNames.size) return chunk;

    streamState.lastChunkMeta = chunk;

    return {
      ...chunk,
      choices: chunk.choices.map(sanitizeChoice),
    };
  }

  function sanitizeSseLine(line) {
    if (!line.startsWith('data:')) return line;
    if (isDoneSseLine(line)) return line;

    const payload = line.slice(5).trimStart().replace(/\r$/, '');
    if (!payload) return line;

    try {
      const parsed = JSON.parse(payload);
      return `data: ${JSON.stringify(sanitizeChunk(parsed))}`;
    } catch {
      onWarn?.(`failed to parse SSE JSON payload (${payload.slice(0, 80)})`);
      return line;
    }
  }

  function finalizeStream() {
    if (!streamState.hasToolCalls || streamState.finishReasonSeen) {
      return [];
    }

    if (!hasAnyToolArguments()) {
      onWarn?.('synthesized tool_calls finish chunk with empty upstream arguments (avoid client hang)');
    } else {
      warnEmptyToolArguments();
    }
    onWarn?.('synthesized tool_calls finish chunk for tool-only stream');
    return [`data: ${JSON.stringify(createToolCallFinishChunk(streamState.lastChunkMeta))}`];
  }

  return { sanitizeChunk, sanitizeSseLine, finalizeStream, isDoneSseLine };
}

function stringifyToolArguments(value) {
  if (value === null || value === undefined) return '{}';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

/** True when streamed/historical tool arguments contain real JSON payload, not just "{}" or whitespace. */
export function isMeaningfulToolArguments(raw) {
  if (raw == null) return false;
  const text = typeof raw === 'string' ? raw.trim() : stringifyToolArguments(raw).trim();
  if (!text || text === '{}' || text === 'null') return false;
  try {
    const parsed = JSON.parse(text);
    if (parsed == null || typeof parsed !== 'object') return text.length > 2;
    if (Array.isArray(parsed)) return parsed.length > 0;
    return Object.keys(parsed).length > 0;
  } catch {
    return text.length > 2;
  }
}

/**
 * Detects whether a streamed upstream response is "hollow" — i.e. it never produces
 * meaningful assistant content nor meaningful tool-call arguments (the codex.sale out=1
 * failure mode). Fed the RAW upstream chunks (before sanitization / placeholder injection).
 */
export function createHollowResponseDetector() {
  let meaningfulContent = false;
  let sawToolCalls = false;
  const argByIndex = new Map();

  function observeChunk(parsed) {
    const choices = parsed?.choices;
    if (!Array.isArray(choices)) return;
    for (const choice of choices) {
      const delta = choice?.delta ?? choice?.message;
      if (!delta || typeof delta !== 'object') continue;

      if (
        typeof delta.content === 'string'
        && delta.content.length > 0
        && delta.content !== TOOL_CALL_STREAM_PLACEHOLDER
      ) {
        meaningfulContent = true;
      }
      if (
        typeof delta.reasoning_content === 'string'
        && delta.reasoning_content.trim().length > 0
      ) {
        // reasoning alone is not a usable answer for Cursor, but mark tool intent absent
      }

      const toolCalls = delta.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          if (!tc || typeof tc !== 'object') continue;
          sawToolCalls = true;
          const index = tc.index ?? 0;
          const frag = typeof tc.function?.arguments === 'string' ? tc.function.arguments : '';
          if (frag) argByIndex.set(index, (argByIndex.get(index) ?? '') + frag);
        }
      }
    }
  }

  function hasMeaningfulArgs() {
    for (const buf of argByIndex.values()) {
      if (isMeaningfulToolArguments(buf)) return true;
    }
    return false;
  }

  return {
    observeChunk,
    isMeaningful: () => meaningfulContent || hasMeaningfulArgs(),
    sawToolCalls: () => sawToolCalls,
  };
}

/** Builds SSE lines for a plain assistant text turn that ends with finish_reason:"stop". */
export function buildAssistantTextSseChunks(meta, text) {
  const base = {
    id: meta?.id ?? `chatcmpl_${crypto.randomBytes(8).toString('hex')}`,
    object: 'chat.completion.chunk',
    created: meta?.created ?? Math.floor(Date.now() / 1000),
    model: meta?.model ?? 'gpt-5.5',
  };
  const contentChunk = {
    ...base,
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
  };
  const finishChunk = {
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  };
  return [
    `data: ${JSON.stringify(contentChunk)}`,
    `data: ${JSON.stringify(finishChunk)}`,
  ];
}

/** Drop assistant/tool pairs from history where upstream returned hollow tool_calls (out=1 poison). */
export function stripHollowToolHistory(messages, onWarn) {
  if (!Array.isArray(messages) || !messages.length) return messages;

  const out = [];
  let removed = 0;

  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg?.role !== 'assistant' || !msg.tool_calls?.length) {
      out.push(msg);
      continue;
    }

    const content = typeof msg.content === 'string' ? msg.content.trim() : '';
    const looksLikeFailedToolOnlyTurn = !content || content === TOOL_CALL_STREAM_PLACEHOLDER;
    const hollow = msg.tool_calls.every(tc => !isMeaningfulToolArguments(tc?.function?.arguments));
    if (!looksLikeFailedToolOnlyTurn || !hollow) {
      out.push(msg);
      continue;
    }

    const ids = new Set(msg.tool_calls.map(tc => tc?.id).filter(Boolean));
    removed += 1;
    while (i + 1 < messages.length && messages[i + 1]?.role === 'tool' && ids.has(messages[i + 1].tool_call_id)) {
      i += 1;
      removed += 1;
    }
  }

  if (removed) {
    onWarn?.(`stripped ${removed} hollow tool history messages (upstream out=1 poison)`);
  }
  return out;
}

export function cleanJsonSchema(value, onWarn) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map(item => cleanJsonSchema(item, onWarn));
  }
  if (typeof value !== 'object') return value;

  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (SCHEMA_STRIP_KEYS.has(key)) {
      onWarn?.(`stripped unsupported JSON Schema key "${key}" from tool parameters`);
      continue;
    }
    out[key] = cleanJsonSchema(child, onWarn);
  }
  return out;
}

export function normalizeContent(content, onWarn) {
  if (content === null || content === undefined) return undefined;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const dropped = [];
    const parts = content
      .map(part => {
        if (!part || typeof part !== 'object') return undefined;
        if (part.type === 'text' && typeof part.text === 'string') {
          return { type: 'text', text: part.text };
        }
        if (part.type === 'image_url' && part.image_url) {
          return { type: 'image_url', image_url: part.image_url };
        }
        if (typeof part.text === 'string') return { type: 'text', text: part.text };
        dropped.push(part.type ?? 'unknown');
        return undefined;
      })
      .filter(Boolean);
    if (dropped.length) {
      onWarn?.(`dropped unsupported content parts: ${[...new Set(dropped)].join(', ')}`);
    }
    if (!parts.length) return undefined;
    const textParts = parts.filter(part => part.type === 'text');
    if (textParts.length === parts.length) {
      return textParts.map(part => part.text).join('\n\n');
    }
    if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
    return parts;
  }
  if (typeof content === 'object') {
    onWarn?.('dropped non-string object content');
    return undefined;
  }
  return String(content);
}

function parseSerializedToolContent(content, onWarn) {
  const trimmed = content.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return content;

  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return content;

    const texts = parsed
      .map(part => (part && typeof part === 'object' && typeof part.text === 'string' ? part.text : undefined))
      .filter(Boolean);
    if (!texts.length) return content;

    onWarn?.('parsed serialized tool content array to plain text for codex.sale compatibility');
    return texts.join('\n\n');
  } catch {
    return content;
  }
}

function sanitizeToolCall(tc, ctx) {
  if (!tc || typeof tc !== 'object') return undefined;
  const out = {};
  for (const key of TOOL_CALL_KEYS) {
    if (!(key in tc) || tc[key] === null || tc[key] === undefined) continue;
    if (key === 'function') {
      const fn = tc.function;
      if (!fn || typeof fn !== 'object') continue;
      const fnOut = {};
      for (const fk of FUNCTION_KEYS) {
        if (fn[fk] === null || fn[fk] === undefined) continue;
        fnOut[fk] = fk === 'arguments' ? stringifyToolArguments(fn[fk]) : fn[fk];
      }
      if (fnOut.name) {
        fnOut.name = fixToolCallName(
          fnOut.name,
          ctx?.toolNames ?? new Set(),
          ctx?.onWarn,
          { responseMode: Boolean(ctx?.responseMode) },
        );
        out.function = fnOut;
      }
      continue;
    }
    if (key === 'id') {
      const rawId = tc.id;
      out.id = ctx?.idMap?.get(rawId) ?? rawId;
      continue;
    }
    out[key] = tc[key];
  }
  return out.id && out.function?.name ? out : undefined;
}

function sanitizeToolDef(tool, onWarn) {
  if (!tool || typeof tool !== 'object') return undefined;
  const out = {};
  for (const key of TOOL_DEF_KEYS) {
    if (!(key in tool) || tool[key] === null || tool[key] === undefined) continue;
    if (key === 'function') {
      const fn = tool.function;
      if (!fn || typeof fn !== 'object') continue;
      const fnOut = {};
      for (const fk of FUNCTION_DEF_KEYS) {
        if (fn[fk] === null || fn[fk] === undefined) continue;
        fnOut[fk] = fk === 'parameters'
          ? cleanJsonSchema(fn[fk], onWarn)
          : fn[fk];
      }
      if (fnOut.name) out.function = fnOut;
      continue;
    }
    out[key] = tool[key];
  }
  return out.type === 'function' && out.function?.name ? out : undefined;
}

function coerceUnknownRole(msg, onWarn) {
  const role = msg.role;
  onWarn?.(`unknown message role "${role}" — coerced to user`);
  const content = normalizeContent(msg.content, onWarn);
  return { role: 'user', content: content ?? '' };
}

function stringifyToolContent(value, onWarn) {
  try {
    const serialized = JSON.stringify(value);
    onWarn?.('stringified non-string tool content for codex.sale compatibility');
    return serialized;
  } catch {
    onWarn?.('tool content is not JSON-serializable — replaced with placeholder');
    return '[unserializable tool result]';
  }
}

function sanitizeToolContent(content, onWarn) {
  if (typeof content === 'string') {
    return parseSerializedToolContent(content, onWarn);
  }

  const normalized = normalizeContent(content, onWarn);
  if (typeof normalized === 'string') return normalized;

  return stringifyToolContent(content, onWarn);
}

export function sanitizeMessage(msg, onWarn, ctx = {}) {
  if (!msg || typeof msg !== 'object') return null;

  const role = msg.role;
  const allowed = MESSAGE_KEYS[role];
  if (!allowed) return coerceUnknownRole(msg, onWarn);

  const messageCtx = { ...ctx, onWarn };

  const out = { role };
  for (const key of allowed) {
    if (key === 'role') continue;
    if (!(key in msg)) continue;

    if (key === 'content') {
      if (role === 'tool' && msg.content !== null && msg.content !== undefined) {
        out.content = sanitizeToolContent(msg.content, onWarn);
        continue;
      }
      const content = normalizeContent(msg.content, onWarn);
      if (content !== undefined) out.content = content;
      continue;
    }
    if (key === 'tool_calls') {
      const raw = msg.tool_calls ?? [];
      const tcs = raw.map(tc => sanitizeToolCall(tc, messageCtx)).filter(Boolean);
      if (raw.length && tcs.length !== raw.length) {
        onWarn?.(`dropped ${raw.length - tcs.length} invalid tool_calls in assistant message`);
      }
      if (tcs.length) out.tool_calls = tcs;
      continue;
    }
    if (key === 'tool_call_id') {
      const rawId = msg.tool_call_id;
      out.tool_call_id = ctx.idMap?.get(rawId) ?? rawId;
      continue;
    }
    if (msg[key] !== null && msg[key] !== undefined) {
      out[key] = msg[key];
    }
  }

  if (role === 'assistant' && out.content === undefined && !out.tool_calls?.length) {
    out.content = '';
  }
  if (role === 'tool' && out.content === undefined) {
    out.content = '';
  }

  return out;
}

function truncateText(text, maxChars, onWarn, label) {
  if (typeof text !== 'string' || text.length <= maxChars) return text;
  onWarn?.(`truncated ${label} from ${text.length} to ${maxChars} chars for upstream budget`);
  const head = Math.floor(maxChars * 0.35);
  const tail = maxChars - head - 40;
  return `${text.slice(0, head)}\n\n[…truncated ${text.length - maxChars} chars…]\n\n${text.slice(-tail)}`;
}

function shrinkObjectStrings(value, maxLen) {
  if (typeof value === 'string') {
    return value.length <= maxLen ? value : value.slice(0, maxLen);
  }
  if (Array.isArray(value)) {
    return value.map(item => shrinkObjectStrings(item, maxLen));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = shrinkObjectStrings(item, maxLen);
    }
    return out;
  }
  return value;
}

export function truncateToolArguments(raw, maxChars, onWarn) {
  if (typeof raw !== 'string' || raw.length <= maxChars) return raw;

  try {
    const parsed = JSON.parse(raw);
    const fieldLimit = Math.max(64, Math.floor(maxChars / 4));
    const shrunk = JSON.stringify(shrinkObjectStrings(parsed, fieldLimit));
    if (shrunk.length <= maxChars) {
      onWarn?.(`shrunk assistant tool arguments from ${raw.length} to ${shrunk.length} chars`);
      return shrunk;
    }
  } catch {
    // fall through — replace with empty object
  }

  onWarn?.(`replaced oversize assistant tool arguments (${raw.length} chars) with {}`);
  return '{}';
}

function shrinkSchemaDescriptions(value, maxLen) {
  if (Array.isArray(value)) {
    return value.map(item => shrinkSchemaDescriptions(item, maxLen));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === 'description' && typeof item === 'string' && item.length > maxLen) {
        out[key] = item.slice(0, maxLen);
      } else {
        out[key] = shrinkSchemaDescriptions(item, maxLen);
      }
    }
    return out;
  }
  return value;
}

export function normalizeCursorPathsInArgs(frag) {
  if (typeof frag !== 'string' || !frag.includes('/workspace/')) return frag;
  return frag.replace(/"path"\s*:\s*"\/workspace\//g, '"path":"');
}

function minimalToolParameters(name, sourceParams) {
  const required = CURSOR_TOOL_REQUIRED_PARAMS[name];
  if (!required?.length) return null;

  const sourceProps = sourceParams?.properties ?? {};
  const properties = {};
  for (const key of required) {
    const existing = sourceProps[key];
    properties[key] = existing?.type
      ? { type: existing.type }
      : { type: 'string' };
  }
  return { type: 'object', properties, required };
}

export function slimToolsForUpstream(tools, onWarn) {
  if (!Array.isArray(tools) || !tools.length) return tools;

  const slimmed = tools.map(tool => {
    if (!tool?.function?.name) return tool;
    const name = tool.function.name;
    const params = minimalToolParameters(name, tool.function.parameters)
      ?? tool.function.parameters;
    const trimmedParams = params && typeof params === 'object'
      ? cleanJsonSchema(shrinkSchemaDescriptions(params, DEFAULT_MAX_TOOL_DESCRIPTION_CHARS), () => {})
      : params;

    return {
      type: 'function',
      function: {
        name,
        description: typeof tool.function.description === 'string'
          ? tool.function.description.slice(0, DEFAULT_MAX_TOOL_DESCRIPTION_CHARS)
          : '',
        parameters: trimmedParams,
      },
    };
  });

  const before = JSON.stringify(tools).length;
  const after = JSON.stringify(slimmed).length;
  if (after < before) {
    onWarn?.(`slimmed tool definitions from ${before} to ${after} chars for upstream`);
  }
  return slimmed;
}

export function compactToolsForPayload(tools, onWarn, maxDescChars = DEFAULT_MAX_TOOL_DESCRIPTION_CHARS) {
  if (!Array.isArray(tools) || !tools.length) return tools;

  let anyChanged = false;
  const out = tools.map(tool => {
    if (!tool?.function) return tool;
    const fn = { ...tool.function };
    let toolChanged = false;

    if (typeof fn.description === 'string' && fn.description.length > maxDescChars) {
      fn.description = fn.description.slice(0, maxDescChars);
      toolChanged = true;
    }
    if (fn.parameters) {
      const trimmed = cleanJsonSchema(shrinkSchemaDescriptions(fn.parameters, maxDescChars), () => {});
      if (JSON.stringify(trimmed).length < JSON.stringify(fn.parameters).length) {
        fn.parameters = trimmed;
        toolChanged = true;
      }
    }
    if (toolChanged) {
      anyChanged = true;
      return { ...tool, function: fn };
    }
    return tool;
  });

  if (anyChanged) {
    onWarn?.(`compacted tool definitions (descriptions ≤ ${maxDescChars} chars) for payload budget`);
  }
  return out;
}

export function compactSystemMessages(systemMessages, options = {}, onWarn) {
  if (!Array.isArray(systemMessages) || !systemMessages.length) return [];

  const perMax = options.systemMaxChars ?? DEFAULT_MAX_SYSTEM_CHARS;
  const totalMax = options.totalSystemMaxChars ?? DEFAULT_MAX_TOTAL_SYSTEM_CHARS;
  const limit = Math.min(perMax, totalMax);

  let merged;
  if (systemMessages.length === 1) {
    merged = { ...systemMessages[0] };
  } else {
    onWarn?.(`merged ${systemMessages.length} system messages into one for upstream budget`);
    const parts = systemMessages.map(m => {
      if (typeof m?.content === 'string') return m.content;
      if (m?.content !== null && m?.content !== undefined) {
        try {
          return JSON.stringify(m.content);
        } catch {
          return '';
        }
      }
      return '';
    }).filter(Boolean);
    merged = { role: 'system', content: parts.join('\n\n') };
    if (systemMessages[0]?.name) merged.name = systemMessages[0].name;
  }

  if (typeof merged.content === 'string' && merged.content.length > limit) {
    merged.content = truncateText(merged.content, limit, onWarn, 'system content');
  }

  return [merged];
}

export function compactAssistantToolHistory(msg, onWarn) {
  if (msg?.role !== 'assistant' || !msg.tool_calls?.length) return msg;
  if (
    typeof msg.content === 'string'
    && msg.content.trim()
    && msg.content !== TOOL_CALL_STREAM_PLACEHOLDER
  ) {
    onWarn?.('stripped assistant prose from historical tool_calls message');
    const { content, ...rest } = msg;
    return rest;
  }
  return msg;
}

export function truncateMessageForUpstream(msg, maxChars, onWarn, ctx = {}) {
  if (!msg || typeof msg !== 'object') return msg;
  if (msg.role === 'user' && ctx.isLastUser) return msg;

  const out = { ...msg };
  const limit = msg.role === 'system'
    ? (ctx.systemMaxChars ?? DEFAULT_MAX_SYSTEM_CHARS)
    : msg.role === 'tool'
      ? (ctx.toolMaxChars ?? DEFAULT_MAX_TOOL_CONTENT_CHARS)
      : maxChars;

  if (typeof out.content === 'string') {
    if (
      out.role === 'user'
      && !ctx.isLastUser
      && out.content.length > DEFAULT_OVERSIZED_USER_REPLACE_CHARS
    ) {
      onWarn?.(
        `replaced oversized user content from ${out.content.length} chars with placeholder for upstream budget`,
      );
      out.content = DEFAULT_OVERSIZED_USER_PLACEHOLDER;
    } else {
      out.content = truncateText(out.content, limit, onWarn, `${out.role} content`);
    }
  }

  if (out.role === 'assistant' && out.tool_calls?.length) {
    const argLimit = ctx.toolMaxChars ?? DEFAULT_MAX_TOOL_CONTENT_CHARS;
    out.tool_calls = out.tool_calls.map(tc => {
      if (!tc?.function || typeof tc.function.arguments !== 'string') return tc;
      if (tc.function.arguments.length <= argLimit) return tc;
      return {
        ...tc,
        function: {
          ...tc.function,
          arguments: truncateToolArguments(tc.function.arguments, argLimit, onWarn),
        },
      };
    });
  }

  return out;
}

function findLastUserIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return i;
  }
  return -1;
}

function dropLeadingOrphanTools(messages, onWarn) {
  let start = 0;
  while (start < messages.length && messages[start]?.role === 'tool') {
    onWarn?.('dropped orphan tool message at trimmed history boundary');
    start += 1;
  }
  return start ? messages.slice(start) : messages;
}

function repairSliceBoundary(messages, onWarn) {
  if (!messages.length) return messages;
  const out = [...messages];

  if (out[0]?.role === 'assistant' && out[0].tool_calls?.length) {
    const ids = new Set(out[0].tool_calls.map(tc => tc.id).filter(Boolean));
    const hasToolFollowUp = out.slice(1).some(
      m => m?.role === 'tool' && ids.has(m.tool_call_id),
    );
    if (!hasToolFollowUp) {
      onWarn?.('stripped dangling tool_calls at trimmed history boundary');
      const { tool_calls, ...rest } = out[0];
      out[0] = rest.content === undefined ? { ...rest, content: '' } : rest;
    }
  }

  return out;
}

export function pruneOldToolTurns(messages, maxTurns, onWarn) {
  if (!Array.isArray(messages) || maxTurns <= 0) return messages;

  const system = messages.filter(m => m?.role === 'system');
  const rest = messages.filter(m => m?.role !== 'system');

  let toolTurns = 0;
  let cutBefore = 0;
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    if (rest[i]?.role !== 'tool') continue;
    toolTurns += 1;
    if (toolTurns > maxTurns) {
      cutBefore = i;
      break;
    }
  }

  if (!cutBefore) return messages;

  const kept = rest.slice(cutBefore);
  onWarn?.(
    `pruned ${cutBefore} older history messages after ${maxTurns} tool turns (${messages.length} → ${system.length + kept.length})`,
  );
  return [...system, ...repairTrimmedHistory(kept, onWarn)];
}

function repairTrimmedHistory(messages, onWarn) {
  return repairSliceBoundary(dropLeadingOrphanTools(messages, onWarn), onWarn);
}

export function trimRequestHistory(messages, options = {}, onWarn) {
  if (!Array.isArray(messages) || !messages.length) return messages;

  const maxMessages = options.maxMessages ?? DEFAULT_MAX_HISTORY_MESSAGES;
  const maxChars = options.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS;
  const maxToolTurns = options.maxToolTurns ?? DEFAULT_MAX_TOOL_TURNS;
  const toolMaxChars = options.toolMaxChars ?? DEFAULT_MAX_TOOL_CONTENT_CHARS;

  let working = stripHollowToolHistory(messages, onWarn);
  working = pruneOldToolTurns(working, maxToolTurns, onWarn);

  let system = working.filter(m => m?.role === 'system');
  let rest = working.filter(m => m?.role !== 'system');
  const lastUserIndex = findLastUserIndex(rest);

  system = compactSystemMessages(system, {
    systemMaxChars: options.systemMaxChars ?? DEFAULT_MAX_SYSTEM_CHARS,
    totalSystemMaxChars: options.totalSystemMaxChars ?? DEFAULT_MAX_TOTAL_SYSTEM_CHARS,
  }, onWarn);

  rest = rest.map((m, index) => truncateMessageForUpstream(
    compactAssistantToolHistory(m, onWarn),
    maxChars,
    onWarn,
    { isLastUser: index === lastUserIndex, toolMaxChars },
  ));

  rest = dropLeadingOrphanTools(rest, onWarn);

  const budget = Math.max(maxMessages, 6);
  if (rest.length > budget) {
    const dropped = rest.length - budget;
    rest = dropLeadingOrphanTools(rest.slice(-budget), onWarn);
    rest = repairSliceBoundary(rest, onWarn);
    onWarn?.(
      `trimmed ${dropped} older history messages (${messages.length} → ${system.length + rest.length})`,
    );
  }

  return [...system, ...rest];
}

export function estimateRequestPayloadChars(body) {
  return JSON.stringify(body?.messages ?? []).length
    + JSON.stringify(body?.tools ?? []).length;
}

function buildCappedBody(body, system, rest) {
  return { ...body, messages: [...system, ...rest] };
}

function findRestSuffixWithinBudget(body, system, rest, maxChars, onWarn) {
  if (rest.length <= 1) return rest;

  let lo = 1;
  let hi = rest.length;
  let best = rest.length;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = repairSliceBoundary(
      dropLeadingOrphanTools(rest.slice(-mid), onWarn),
      onWarn,
    );
    const trial = estimateRequestPayloadChars(buildCappedBody(body, system, candidate));
    if (trial <= maxChars) {
      best = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  if (best >= rest.length) return rest;

  return repairSliceBoundary(
    dropLeadingOrphanTools(rest.slice(-best), onWarn),
    onWarn,
  );
}

function truncateLastUserMessage(rest, maxChars, onWarn) {
  const lastUserIndex = findLastUserIndex(rest);
  if (lastUserIndex < 0) return rest;

  const msg = rest[lastUserIndex];
  if (typeof msg.content !== 'string' || msg.content.length <= maxChars) return rest;

  const out = [...rest];
  out[lastUserIndex] = {
    ...msg,
    content: truncateText(msg.content, maxChars, onWarn, 'last user content'),
  };
  return out;
}

export function capRequestPayload(body, maxChars, onWarn, options = {}) {
  if (!body?.messages?.length || maxChars <= 0) return body;

  let working = body;
  let estimate = estimateRequestPayloadChars(working);
  if (estimate <= maxChars) return working;

  const initial = estimate;
  const initialMsgCount = body.messages.length;
  const system = body.messages.filter(m => m?.role === 'system');
  let rest = body.messages.filter(m => m?.role !== 'system');

  rest = findRestSuffixWithinBudget(body, system, rest, maxChars, onWarn);
  working = buildCappedBody(body, system, rest);
  estimate = estimateRequestPayloadChars(working);

  if (estimate > maxChars) {
    rest = truncateLastUserMessage(
      rest,
      options.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS,
      onWarn,
    );
    working = buildCappedBody(body, system, rest);
    estimate = estimateRequestPayloadChars(working);
  }

  if (estimate > maxChars && working.tools?.length) {
    working = {
      ...working,
      tools: compactToolsForPayload(working.tools, onWarn),
    };
    estimate = estimateRequestPayloadChars(working);
  }

  if (estimate > maxChars) {
    onWarn?.(`request payload still ${estimate} chars after cap (limit ${maxChars})`);
  } else {
    onWarn?.(
      `capped request payload from ${initial} to ${estimate} chars (${initialMsgCount} → ${working.messages.length} msgs)`,
    );
  }

  return working;
}

export function ensureMinMaxTokens(body, onWarn, minTokens = DEFAULT_MIN_MAX_TOKENS) {
  if (!body?.tools?.length) return body;
  const current = Math.max(
    body.max_tokens ?? 0,
    body.max_completion_tokens ?? 0,
  );
  if (current >= minTokens) return body;
  if (current >= DEFAULT_TOOL_CALL_TOKEN_FLOOR) return body;

  const target = current === 0 ? minTokens : DEFAULT_TOOL_CALL_TOKEN_FLOOR;
  onWarn?.(`raised max_tokens ${current || 'unset'} → ${target} for tool-call headroom`);
  return {
    ...body,
    max_tokens: target,
    max_completion_tokens: target,
  };
}

export function sanitizeRequest(body, onWarn, options = {}) {
  const profile = options.profile ?? profileForAttempt(options.attemptNum ?? 0);
  const out = {};

  for (const [key, value] of Object.entries(body)) {
    if (!REQUEST_KEYS.has(key)) continue;
    if (value === null || value === undefined) continue;
    out[key] = value;
  }

  if (typeof out.model === 'string' && out.model.includes('/')) {
    out.model = out.model.split('/').pop();
  }

  let rawTools = Array.isArray(out.tools) ? out.tools : [];
  if (profile.essentialToolsOnly && rawTools.length) {
    rawTools = filterEssentialTools(rawTools, onWarn);
  }
  const toolNames = collectToolNames(rawTools);

  if (Array.isArray(out.tools)) {
    let preparedTools = slimToolsForUpstream(rawTools, onWarn);
    if (JSON.stringify(preparedTools).length > DEFAULT_TOOL_PAYLOAD_BUDGET_CHARS) {
      preparedTools = compactToolsForPayload(preparedTools, onWarn);
    }
    out.tools = preparedTools.map(tool => sanitizeToolDef(tool, onWarn)).filter(Boolean);
    if (rawTools.length && out.tools.length !== rawTools.length) {
      onWarn?.(`dropped ${rawTools.length - out.tools.length} invalid tool definitions`);
    }
    if (out.tools.length) {
      out.parallel_tool_calls = false;
    }
  }

  if (Array.isArray(out.messages)) {
    out.messages = trimRequestHistory(out.messages, {
      maxMessages: profile.maxHistoryMessages,
      maxToolTurns: profile.maxToolTurns,
      systemMaxChars: profile.systemMaxChars,
      totalSystemMaxChars: profile.totalSystemMaxChars,
    }, onWarn);
    if (profile.retryNudge) {
      out.messages = appendRetryNudge(out.messages, onWarn);
    }
    const idMap = buildToolCallIdMap(out.messages, onWarn);
    const ctx = { idMap, toolNames, onWarn };
    out.messages = out.messages
      .map(m => sanitizeMessage(m, onWarn, ctx))
      .filter(Boolean);
  }

  const withTokens = ensureMinMaxTokens(out, onWarn);
  return capRequestPayload(
    withTokens,
    profile.maxPayloadChars,
    onWarn,
    { maxMessageChars: profile.maxHistoryMessages <= 6 ? 4_000 : DEFAULT_MAX_MESSAGE_CHARS },
  );
}

export function messageFieldSummary(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((m, i) => {
    const extra = Object.keys(m ?? {}).filter(k => {
      const allowed = MESSAGE_KEYS[m?.role];
      return !allowed?.has(k);
    });
    return { i, role: m?.role, extra, hasToolCalls: Boolean(m?.tool_calls?.length) };
  });
}

export function redactRequestSummary(req) {
  return {
    model: req?.model,
    stream: req?.stream,
    messageCount: req?.messages?.length ?? 0,
    toolCount: req?.tools?.length ?? 0,
    messages: (req?.messages ?? []).map(m => ({
      role: m?.role,
      contentLength: typeof m?.content === 'string'
        ? m.content.length
        : JSON.stringify(m?.content ?? '').length,
      toolCallCount: m?.tool_calls?.length ?? 0,
    })),
  };
}
