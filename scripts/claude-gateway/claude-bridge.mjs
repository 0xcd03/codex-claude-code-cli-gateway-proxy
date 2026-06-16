/**
 * Claude CLI bridge — OpenAI SSE ↔ Claude stream-json with tool_use passthrough.
 *
 * Spawns `claude -p` for each turn. Tool use blocks are parsed from the
 * stream-json output and forwarded to Cursor as OpenAI tool_calls SSE.
 * Claude does NOT execute tools — the subprocess is killed on first tool_use.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import {
  CLAUDE_TO_CURSOR_TOOL,
  remapClaudeArgs,
  buildClaudeAllowedTools,
} from './tool-mapping.mjs';

const MAX_TOOL_RESULT_CHARS = 4000;

/** Build prompt from OpenAI messages, including tool calls and results. */
function messagesToPrompt(messages) {
  const parts = [];
  const arr = messages ?? [];
  const seenFiles = new Set(); // track already-read files to prevent bloat

  for (let i = 0; i < arr.length; i++) {
    const m = arr[i];
    if (!m || typeof m !== 'object') continue;
    const content = messageContentToText(m.content);

    if (m.role === 'system') {
      if (content) parts.push(`System: ${content}`);
    } else if (m.role === 'user') {
      parts.push(`User: ${content}`);
    } else if (m.role === 'assistant') {
      if (content) parts.push(`Assistant: ${content}`);
      if (m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          const name = tc?.function?.name ?? 'tool';
          const args = tc?.function?.arguments ?? '{}';
          parts.push(`[Tool call: ${name}]\n${args}`);
        }
      }
    } else if (m.role === 'tool') {
      const prev = arr[i - 1];
      let toolName = 'tool';
      let filePath = '';

      if (prev?.role === 'assistant' && prev.tool_calls) {
        for (const tc of prev.tool_calls) {
          if (tc.id === m.tool_call_id) {
            toolName = tc.function?.name ?? 'tool';
            const parsed = tc.function?.arguments ? tryParseJson(tc.function.arguments) : null;
            filePath = parsed?.file_path ?? parsed?.path ?? '';
            break;
          }
        }
      }

      let label = `${toolName}${filePath ? ' → ' + filePath : ''}`;
      let resultText = content;

      // For Read tools: if file already seen, truncate heavily
      if (toolName === 'Read' || toolName === 'ReadFile') {
        if (filePath && seenFiles.has(filePath)) {
          resultText = `[уже прочитано: ${filePath.slice(0, 80)}]`;
          label += ' (повтор — пропущено)';
        } else {
          if (filePath) seenFiles.add(filePath);
          if (resultText.length > MAX_TOOL_RESULT_CHARS) {
            resultText = resultText.slice(0, MAX_TOOL_RESULT_CHARS) + '\n...[обрезано]';
          }
        }
      } else {
        // Non-Read results: cap size
        if (resultText.length > MAX_TOOL_RESULT_CHARS) {
          resultText = resultText.slice(0, MAX_TOOL_RESULT_CHARS) + '\n...[обрезано]';
        }
      }

      parts.push(`[Tool result: ${label}]\n${resultText}`);
    }
  }
  return parts.join('\n\n');
}

function tryParseJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function messageContentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(p => p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string')
    .map(p => p.text)
    .join('\n\n');
}

function sseChunk(meta, delta, finishReason = null) {
  return {
    id: meta.id,
    object: 'chat.completion.chunk',
    created: meta.created,
    model: meta.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

export class ClaudeToolBridge {
  constructor(options = {}) {
    this.bin        = options.bin        ?? 'claude';
    this.apiKey     = options.apiKey     ?? '';
    this.baseUrl    = options.baseUrl    ?? 'https://claude-code-cli.vibecode-claude.online';
    this.homeDir    = options.homeDir    ?? '/root';
    this.model      = options.model      ?? 'claude-sonnet-4-5';
    this.timeoutMs  = options.timeoutMs  ?? 120_000;
    this.appendSystemPrompt = options.appendSystemPrompt
      ?? 'Do not re-read files already read. After Write, do not verify — it is saved. Keep moving forward.';
    this.onLog      = options.onLog      ?? (() => {});
    this.onWarn     = options.onWarn     ?? (() => {});
  }

  buildEnv() {
    return {
      HOME: this.homeDir,
      PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      TERM: 'dumb',
      ANTHROPIC_BASE_URL: this.baseUrl,
      ANTHROPIC_API_KEY: this.apiKey,
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_BUG_COMMAND: '1',
      DISABLE_COST_WARNINGS: '1',
    };
  }

  /**
   * Run one turn through Claude CLI.
   * Emits SSE chunks to `res`. Returns 'tool' if tool call detected, 'done' otherwise.
   */
  async runTurn({ messages, tools, res, meta, clientReq }) {
    const prompt   = messagesToPrompt(messages);
    const allowed  = buildClaudeAllowedTools(tools);
    const model    = this.model;
    const stream   = true; // always stream in bridge mode

    this.onLog(`claude turn: ${messages.length} msgs, prompt≈${Math.round(prompt.length / 1024)}KB, allowedTools=${allowed}`);

    // Pipe prompt via stdin to avoid E2BIG on large contexts (>128KB argv limit).
    // Uses `sh -c 'claude ... -p "$(cat)"'` — stdin → cat substitution bypasses argv.
    const argList = [
      '--model', model,
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--allowedTools', allowed,
      '--max-turns', '50',
      '--append-system-prompt', this.appendSystemPrompt,
    ];

    const proc = spawn('sh', [
      '-c',
      `${this.bin} ${argList.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')} -p "$(cat)"`,
    ], {
      env: this.buildEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Pipe prompt through stdin → sh → cat → claude -p "$(cat)"
    proc.stdin.write(prompt);
    proc.stdin.end();

    return new Promise((resolve, reject) => {
      let buffer       = '';
      let headSent     = false;
      let toolIndex    = 0;
      let toolCallsAcc = [];       // [{ id, name, args }]
      let curToolBlock = null;     // { id, name } — currently accumulating
      let textContent  = '';
      let resolved     = false;
      let cleanedUp    = false;

      const timer = setTimeout(() => {
        cleanup(`claude turn timeout after ${this.timeoutMs}ms`);
      }, this.timeoutMs);

      const cleanup = (reason) => {
        if (cleanedUp) return;
        cleanedUp = true;
        clearTimeout(timer);
        proc.kill('SIGTERM');
        if (!resolved) {
          resolved = true;
          reject(new Error(reason));
        }
      };

      // Client disconnect
      if (clientReq) {
        clientReq.on('aborted', () => cleanup('client aborted'));
      }
      res.on('close', () => { if (!res.writableFinished) cleanup('client disconnected'); });

      const ensureHead = () => {
        if (headSent || !stream) return;
        headSent = true;
        res.write(`data: ${JSON.stringify(sseChunk(meta, { role: 'assistant' }))}\n\n`);
      };

      const emitTextDelta = (text) => {
        if (!text || !stream) return;
        ensureHead();
        res.write(`data: ${JSON.stringify(sseChunk(meta, { content: text }))}\n\n`);
      };

      const finishStream = (reason) => {
        if (!stream) return;
        ensureHead();
        res.write(`data: ${JSON.stringify(sseChunk(meta, {}, reason))}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      };

      const handleToolUseStart = (block) => {
        curToolBlock = { id: block.id, name: block.name, args: '' };
        this.onLog(`claude tool_use start: ${block.name} id=${block.id}`);
      };

      const handleToolUseDelta = (delta) => {
        if (curToolBlock) curToolBlock.args += delta.partial_json ?? '';
      };

      const handleToolUseDone = () => {
        if (!curToolBlock) return;
        toolCallsAcc.push(curToolBlock);
        curToolBlock = null;
      };

      const emitAllToolCalls = () => {
        if (toolCallsAcc.length === 0 || resolved) return;
        resolved = true;
        clearTimeout(timer);

        ensureHead();

        const openAiCalls = toolCallsAcc.map((tc, i) => {
          const cursorName = CLAUDE_TO_CURSOR_TOOL[tc.name] ?? tc.name;
          const openAiId   = `call_${crypto.randomBytes(12).toString('hex')}`;
          const remapped    = remapClaudeArgs(tc.name, tc.args);
          this.onLog(`claude tool_use emit: ${tc.name}→${cursorName} args=${remapped.slice(0, 150)}`);
          return {
            index: toolIndex + i,
            id: openAiId,
            type: 'function',
            function: { name: cursorName, arguments: remapped },
          };
        });

        res.write(`data: ${JSON.stringify(sseChunk(meta, { tool_calls: openAiCalls }))}\n\n`);
        res.write(`data: ${JSON.stringify(sseChunk(meta, { content: '.' }))}\n\n`);

        finishStream('tool_calls');
        proc.kill('SIGTERM');
        resolve('tool');
      };

      const processLine = (line) => {
        if (!line.trim() || resolved) return;
        let evt;
        try { evt = JSON.parse(line); } catch { return; }

        // System init
        if (evt.type === 'system' && evt.subtype === 'init') {
          this.onLog(`claude init: model=${evt.model}, tools=${evt.tools?.length ?? 0}`);
          return;
        }

        // assistant events carry cumulative text snapshots — do NOT emit.
        // stream_event content_block_delta text_delta handles real-time streaming.
        if (evt.type === 'assistant' && evt.message?.content) {
          for (const part of evt.message.content) {
            if (part.type === 'text' && part.text) textContent += part.text;
          }
          return;
        }

        // Stream events
        if (evt.type !== 'stream_event') return;
        const e = evt.event;
        if (!e) return;

        // Content block start
        if (e.type === 'content_block_start') {
          const cb = e.content_block;
          if (cb?.type === 'tool_use') {
            handleToolUseStart(cb);
          }
          return;
        }

        // Content block delta
        if (e.type === 'content_block_delta') {
          const d = e.delta;
          if (d?.type === 'input_json_delta') {
            handleToolUseDelta(d);
          } else if (d?.type === 'text_delta' && d.text) {
            textContent += d.text;
            emitTextDelta(d.text);
          }
          return;
        }

        // Content block stop — for tool_use, args are complete
        if (e.type === 'content_block_stop') {
          handleToolUseDone();
          // Emit immediately on first tool_use completion — Claude waits for
          // tool result before continuing, so there won't be more events.
          if (toolCallsAcc.length > 0 && !resolved) {
            emitAllToolCalls();
          }
          return;
        }

        // Message stop — Claude finished without tools
        if (e.type === 'message_stop') {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            finishStream('stop');
            resolve('done');
          }
          return;
        }
      };

      proc.stdout.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        lines.forEach(processLine);
      });

      proc.stderr.on('data', chunk => {
        this.onWarn(`claude stderr: ${chunk.toString().slice(0, 300)}`);
      });

      proc.on('close', code => {
        clearTimeout(timer);
        if (buffer.trim()) {
          const lines = buffer.split('\n');
          lines.forEach(processLine);
        }
        if (!resolved) {
          resolved = true;
          if (!headSent) {
            reject(new Error(`claude exited ${code} with no output`));
          } else {
            finishStream('stop');
            resolve('done');
          }
        }
      });

      proc.on('error', err => {
        clearTimeout(timer);
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });
    });
  }
}
