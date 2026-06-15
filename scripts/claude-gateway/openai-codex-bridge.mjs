/**
 * OpenAI Chat Completions ↔ Codex App Server bridge with dynamicTools passthrough.
 */
import crypto from 'node:crypto';
import {
  CodexAppServerClient,
  buildCodexSubprocessEnv,
  newCallId,
} from './codex-app-server-client.mjs';
import {
  TOOL_CALL_STREAM_PLACEHOLDER,
  collectToolNames,
  createStreamSanitizer,
  sanitizeCompletionPayload,
} from './codex-sanitize.mjs';
import { remapClaudeArgs } from './tool-mapping.mjs';

/** Max concurrent app-server subprocesses. */
let activeAppServers = 0;
const MAX_CONCURRENT_APP_SERVERS = 1;
/**
 * Acquire an app-server slot. Always asynchronous — use with `await`.
 * Rejects with a 503-compatible error when at capacity.
 */
async function acquireAppServerSlot(onWarn) {
  if (activeAppServers >= MAX_CONCURRENT_APP_SERVERS) {
    const msg = `app-server bridge busy (${activeAppServers}/${MAX_CONCURRENT_APP_SERVERS} active)`;
    onWarn(msg);
    throw new Error(msg);
  }
  activeAppServers += 1;
  return () => { activeAppServers = Math.max(0, activeAppServers - 1); };
}

export function openAiToolsToDynamicTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter(t => t?.type === 'function' && t.function?.name)
    .map(t => ({
      name: t.function.name,
      description: typeof t.function.description === 'string'
        ? t.function.description.slice(0, 512)
        : '',
      deferLoading: false,
      inputSchema: t.function.parameters ?? { type: 'object', properties: {} },
    }));
}

function messageContentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(p => p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string')
    .map(p => p.text)
    .join('\n\n');
}

/** Build a compact transcript for Codex turn input from OpenAI messages. */
export function messagesToTurnText(messages) {
  const parts = [];
  for (const m of messages ?? []) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'system') {
      const text = messageContentToText(m.content);
      if (text) parts.push(`[SYSTEM]\n${text}`);
      continue;
    }
    if (m.role === 'user') {
      const text = messageContentToText(m.content);
      if (text) parts.push(`[USER]\n${text}`);
      continue;
    }
    if (m.role === 'assistant') {
      const text = messageContentToText(m.content);
      if (text) parts.push(`[ASSISTANT]\n${text}`);
      if (m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          const name = tc?.function?.name ?? 'tool';
          const args = tc?.function?.arguments ?? '{}';
          parts.push(`[ASSISTANT TOOL_CALL ${name}]\n${args}`);
        }
      }
      continue;
    }
    if (m.role === 'tool') {
      parts.push(`[TOOL RESULT ${m.tool_call_id ?? ''}]\n${messageContentToText(m.content)}`);
    }
  }
  return parts.join('\n\n');
}

function sseChunk(meta, delta, finishReason = null) {
  return {
    id: meta.id,
    object: 'chat.completion.chunk',
    created: meta.created,
    model: meta.model,
    choices: [{
      index: 0,
      delta,
      finish_reason: finishReason,
    }],
  };
}

function writeSse(res, obj) {
  if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

/**
 * Run one OpenAI chat completion turn through Codex App Server.
 * Dynamic tool calls are forwarded to Cursor via OpenAI SSE (not executed on server).
 */
export async function runOpenAiViaAppServer({
  body,
  res,
  clientReq,
  options,
}) {
  const {
    apiKey,
    upstreamUrl,
    codexBin = 'codex',
    codexHome = '/opt/omniroute/codex-home',
    cwd = '/opt/omniroute/codex-home',
    onWarn = () => {},
    onLog = () => {},
    turnTimeoutMs = 300_000,
  } = options;

  const model = typeof body.model === 'string' ? body.model.split('/').pop() : 'gpt-5.5';
  const stream = body.stream !== false;
  const toolNames = collectToolNames(body.tools);
  const sanitizer = createStreamSanitizer(toolNames, onWarn);
  const meta = {
    id: `chatcmpl_${crypto.randomBytes(12).toString('hex')}`,
    created: Math.floor(Date.now() / 1000),
    model,
  };

  let releaseSlot;
  try {
    releaseSlot = await acquireAppServerSlot(onWarn);
  } catch (err) {
    // Busy — return 503 so the client can retry or fall back to HTTP mode
    if (!res.headersSent) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: err.message, type: 'server_error' } }));
    }
    return;
  }

  const client = new CodexAppServerClient({
    bin: codexBin,
    env: buildCodexSubprocessEnv({ apiKey, codexHome }),
    cwd,
    onWarn,
    onLog,
  });

  let aborted = false;
  let headSent = false;
  let toolIndex = 0;
  let sawToolCalls = false;
  let textBuffer = '';
  let finishReason = 'stop';
  let lastToolCall = null;
  let turnDoneResolve;
  let turnDoneReject;
  const turnDone = new Promise((resolve, reject) => {
    turnDoneResolve = resolve;
    turnDoneReject = reject;
  });
  let timer;
  let slotReleased = false;
  let turnCompleted = false;

  const ensureHead = () => {
    if (headSent || res.writableEnded) return;
    headSent = true;
    if (stream) writeSse(res, sseChunk(meta, { role: 'assistant' }));
  };

  const emitToolCall = (toolName, argsObj) => {
    if (sawToolCalls) return;
    sawToolCalls = true;
    finishReason = 'tool_calls';
    // Safety remap: Codex CLI should use dynamicTools inputSchema args,
    // but if it uses Claude-style keys (file_path, content), fix them.
    const rawArgs = typeof argsObj === 'string' ? argsObj : JSON.stringify(argsObj ?? {});
    const argsStr = remapClaudeArgs(toolName, rawArgs);
    const openAiId = newCallId('call');
    lastToolCall = {
      id: openAiId,
      type: 'function',
      function: { name: toolName, arguments: argsStr },
    };
    ensureHead();
    if (stream) {
      writeSse(res, sseChunk(meta, {
        tool_calls: [{
          index: toolIndex,
          id: openAiId,
          type: 'function',
          function: { name: toolName, arguments: argsStr },
        }],
      }));
      writeSse(res, sseChunk(meta, { content: TOOL_CALL_STREAM_PLACEHOLDER }));
    }
    onLog(`tool call emitted: ${toolName} args=${argsStr.slice(0, 200)}`);
    turnDoneResolve('tool');
  };

  const cleanup = async () => {
    if (aborted) return;
    aborted = true;
    if (timer) clearTimeout(timer);
    turnDoneReject(new Error('client disconnected'));
    await client.stop().catch(() => {});
    if (!slotReleased) { releaseSlot?.(); slotReleased = true; }
  };

  clientReq.on('aborted', () => { cleanup(); });
  res.on('close', () => { if (!res.writableFinished) cleanup(); });

  client.onRequest('item/tool/call', async (params) => {
    emitToolCall(params?.tool ?? 'tool', params?.arguments);
    // Do NOT interrupt the turn — Cursor hasn't sent the tool result yet.
    // The tool result will be included as [TOOL RESULT] in messagesToTurnText
    // on the next request, keeping the transcript coherent.
    return {
      contentItems: [{ type: 'inputText', text: 'deferred to OpenAI client' }],
      success: false,
    };
  });

  client.onNotification('item/started', (params) => {
    const item = params?.item;
    if (item?.type === 'dynamicToolCall' && item.tool) {
      emitToolCall(item.tool, item.arguments);
    }
  });

  client.onNotification('item/agentMessage/delta', (params) => {
    const text = params?.delta ?? '';
    if (!text || typeof text !== 'string') return;
    textBuffer += text;
    if (!stream) return;
    ensureHead();
    const chunk = sanitizer.sanitizeChunk({
      choices: [{ delta: { content: text } }],
    });
    const content = chunk?.choices?.[0]?.delta?.content;
    if (content) writeSse(res, sseChunk(meta, { content }));
  });

  client.onNotification('item/completed', (params) => {
    const item = params?.item;
    if (item?.type === 'agentMessage' && typeof item.text === 'string') {
      textBuffer = item.text;
    }
    // If turn already finished, resolve now with the final text
    if (turnCompleted && !sawToolCalls) turnDoneResolve('done');
  });

  client.onNotification('turn/completed', (params) => {
    turnCompleted = true;
    const status = params?.turn?.status;
    if (status === 'failed') {
      const msg = params?.turn?.error?.message ?? 'turn failed';
      turnDoneReject(new Error(msg));
      return;
    }
    if (sawToolCalls) return; // emitToolCall already resolved
    turnDoneResolve('done');
  });

  client.onNotification('error', (params) => {
    const msg = params?.error?.message ?? 'codex error';
    turnDoneReject(new Error(msg));
  });

  timer = setTimeout(() => {
    turnDoneReject(new Error(`turn timeout after ${turnTimeoutMs}ms`));
  }, turnTimeoutMs);

  try {
    await client.start();

    const dynamicTools = openAiToolsToDynamicTools(body.tools);
    const threadRes = await client.request('thread/start', {
      model,
      cwd,
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      dynamicTools,
    });
    const threadId = threadRes?.thread?.id;
    if (!threadId) throw new Error('thread/start returned no thread id');

    const turnText = messagesToTurnText(body.messages);
    await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: turnText }],
    }, turnTimeoutMs);

    await turnDone;
    if (aborted) return;

    if (stream) {
      ensureHead();
      writeSse(res, sseChunk(meta, {}, finishReason));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (sawToolCalls && lastToolCall) {
      const payload = sanitizeCompletionPayload({
        id: meta.id,
        object: 'chat.completion',
        created: meta.created,
        model: meta.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: null, tool_calls: [lastToolCall] },
          finish_reason: 'tool_calls',
        }],
      }, toolNames, onWarn);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: meta.id,
      object: 'chat.completion',
      created: meta.created,
      model: meta.model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: textBuffer },
        finish_reason: 'stop',
      }],
    }));
  } catch (err) {
    onWarn(`app-server bridge error: ${err.message}`);
    if (!headSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: err.message, type: 'server_error' } }));
    } else if (!res.writableEnded) {
      res.end();
    }
  } finally {
    if (timer) clearTimeout(timer);
    await client.stop().catch(() => {});
    if (!slotReleased) { releaseSlot?.(); slotReleased = true; }
  }
}
