#!/usr/bin/env node
/**
 * codex-gateway — OpenAI-compatible proxy to codex.sale with request sanitization.
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAssistantTextSseChunks,
  collectToolNames,
  createHollowResponseDetector,
  createStreamSanitizer,
  estimateRequestPayloadChars,
  messageFieldSummary,
  redactRequestSummary,
  sanitizeCompletionPayload,
  sanitizeRequest,
  profileForAttempt,
} from './codex-sanitize.mjs';
import { runOpenAiViaAppServer } from './openai-codex-bridge.mjs';
import { setupCodexSaleConfig } from './codex-app-server-client.mjs';

const PORT           = process.env.GATEWAY_PORT   ?? 20132;
const UPSTREAM_URL   = process.env.UPSTREAM_URL   ?? 'https://codex.sale/v1';
const API_KEY        = process.env.API_KEY        ?? '';
const DEBUG_DUMP     = process.env.DEBUG_DUMP     ?? '';
const DUMP_400       = process.env.DUMP_400       ?? '/tmp/codex-last-400.json';
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 16 * 1024 * 1024);
const HOLLOW_RETRIES = (() => {
  const n = Number(process.env.CODEX_HOLLOW_RETRIES);
  return Number.isFinite(n) && n >= 0 ? n : 2;
})();
const HOLLOW_FALLBACK_TEXT = process.env.CODEX_HOLLOW_FALLBACK_TEXT
  ?? 'Модель вернула пустой tool-вызов несколько раз подряд (контекст диалога, вероятно, слишком большой). Начните новый чат и повторите задачу.';
const GATEWAY_MODE = (process.env.CODEX_GATEWAY_MODE ?? 'http').toLowerCase();
const CODEX_BIN = process.env.CODEX_BIN ?? 'codex';
const CODEX_HOME = process.env.CODEX_HOME ?? '/opt/omniroute/codex-home';
const CODEX_CWD = process.env.CODEX_CWD ?? '/opt/omniroute/codex-home';
const APP_SERVER_TURN_TIMEOUT_MS = (() => {
  const n = Number(process.env.CODEX_APP_SERVER_TURN_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 120_000;
})();

/** Parse a single SSE `data:` line into a chunk object, or null for [DONE]/non-data/invalid. */
function parseSseChunk(line) {
  if (!line.startsWith('data:')) return null;
  const payload = line.slice(5).trimStart().replace(/\r$/, '');
  if (!payload || payload === '[DONE]') return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function loadSecretFile(path) {
  try {
    return fs.readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

const GATEWAY_SECRET = process.env.GATEWAY_SECRET
  || loadSecretFile('/run/secrets/codex_gateway_secret');

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (!API_KEY && isMain) {
  process.stderr.write('[FATAL] API_KEY is not set\n');
  process.exit(1);
}

const MODELS     = process.env.MODELS ?? 'gpt-5.4,gpt-5.4-mini,gpt-5.5,gpt-image-2,gpt-4o-transcribe';
const MODEL_LIST = MODELS.split(',').map(s => s.trim());

function log(msg) {
  process.stdout.write(`[codex-gw ${new Date().toISOString()}] ${msg}\n`);
}

function logErr(msg, err) {
  const detail = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[codex-gw ${new Date().toISOString()}] ${msg}: ${detail}\n`);
}

function logWarn(msg) {
  process.stderr.write(`[codex-gw ${new Date().toISOString()}] WARN: ${msg}\n`);
}

function isAuthorized(authHeader) {
  if (!GATEWAY_SECRET) return true;
  const token = (authHeader ?? '').replace(/^Bearer\s+/i, '');
  return token === GATEWAY_SECRET || token === API_KEY;
}

function dump400(label, payload) {
  try {
    fs.writeFileSync(DUMP_400, JSON.stringify({
      label,
      at: new Date().toISOString(),
      payload,
    }, null, 2));
  } catch (err) {
    logErr('400 dump failed', err);
  }
}

function dumpDebug(label, payload) {
  if (!DEBUG_DUMP) return;
  dump400(label, payload);
}

function json(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function upstreamBasePath() {
  return new URL(UPSTREAM_URL).pathname.replace(/\/$/, '');
}

function upstreamConfig() {
  const u = new URL(UPSTREAM_URL);
  return {
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    protocol: u.protocol.slice(0, -1),
  };
}

function proxyToUpstream(reqPath, reqMethod, body, callback) {
  const cfg = upstreamConfig();
  const transport = cfg.protocol === 'https' ? https : http;
  const payload = typeof body === 'string' ? body : JSON.stringify(body);

  const headers = {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    Accept: 'application/json, text/event-stream',
  };

  const upstreamReq = transport.request({
    hostname: cfg.hostname,
    port: cfg.port,
    path: `${upstreamBasePath()}/${reqPath.replace(/^\//, '')}`,
    method: reqMethod,
    headers,
  }, upstreamRes => {
    const isStream =
      upstreamRes.headers['content-type']?.includes('event-stream')
      || upstreamRes.headers['content-type']?.includes('text/event-stream');

    if (isStream) {
      callback(null, upstreamRes.statusCode, upstreamRes.headers, upstreamRes, upstreamReq);
      return;
    }

    let data = '';
    upstreamRes.on('data', chunk => { data += chunk; });
    upstreamRes.on('end', () => {
      try {
        callback(null, upstreamRes.statusCode, upstreamRes.headers, JSON.parse(data), upstreamReq);
      } catch (parseErr) {
        logErr('upstream JSON parse failed', parseErr);
        callback(null, upstreamRes.statusCode, upstreamRes.headers, data, upstreamReq);
      }
    });
    upstreamRes.on('error', err => callback(err, null, null, null, upstreamReq));
  });

  upstreamReq.on('error', err => callback(err, null, null, null, upstreamReq));
  upstreamReq.write(payload);
  upstreamReq.end();

  return upstreamReq;
}

function pipeStream(upstream, res, upstreamReq, clientReq, toolNames) {
  let finished = false;
  let upstreamPaused = false;
  let buffer = '';
  const pendingDoneLines = [];
  const sanitizer = createStreamSanitizer(toolNames, msg => logWarn(`response: ${msg}`));

  const cleanup = () => {
    if (finished) return;
    finished = true;
    upstreamReq.destroy();
    upstream.destroy();
  };

  const writeToClient = data => {
    if (res.writableEnded || res.destroyed) return false;
    const ok = res.write(data);
    if (!ok && !upstreamPaused) {
      upstream.pause();
      upstreamPaused = true;
    }
    return ok;
  };

  const flushLines = (final = false) => {
    const lines = buffer.split('\n');
    if (final) {
      buffer = '';
    } else {
      buffer = lines.pop() ?? '';
    }

    for (const line of lines) {
      if (!line.trim()) {
        writeToClient('\n');
        continue;
      }
      if (sanitizer.isDoneSseLine(line)) {
        pendingDoneLines.push(sanitizer.sanitizeSseLine(line));
        continue;
      }
      writeToClient(`${sanitizer.sanitizeSseLine(line)}\n`);
    }
  };

  clientReq.on('aborted', () => {
    if (!res.writableEnded) cleanup();
  });

  res.on('close', cleanup);
  res.on('drain', () => {
    if (upstreamPaused) {
      upstream.resume();
      upstreamPaused = false;
    }
  });
  res.on('error', err => {
    if (err?.code !== 'EPIPE' && err?.code !== 'ECONNRESET') {
      logErr('response error', err);
    }
    cleanup();
  });

  upstream.on('data', chunk => {
    buffer += chunk.toString();
    flushLines(false);
  });

  upstream.on('end', () => {
    if (buffer) flushLines(true);
    for (const line of sanitizer.finalizeStream()) {
      writeToClient(`${line}\n\n`);
    }
    for (const doneLine of pendingDoneLines) {
      writeToClient(`${doneLine}\n\n`);
    }
    if (!res.writableEnded) res.end();
  });

  upstream.on('error', err => {
    logErr('upstream stream error', err);
    cleanup();
  });
}

function readJsonBody(req, res) {
  return new Promise(resolve => {
    let body = '';
    let tooLarge = false;
    let finished = false;

    const done = (status, body) => {
      if (finished) return;
      finished = true;
      json(res, status, body);
      resolve(null);
    };

    req.on('data', chunk => {
      if (tooLarge) return;
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        tooLarge = true;
        req.destroy();
        done(413, { error: { message: 'Request body too large', type: 'invalid_request_error' } });
      }
    });

    req.on('end', () => {
      if (tooLarge || finished) return;
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        done(400, { error: { message: 'Invalid JSON' } });
      }
    });

    req.on('error', err => {
      if (finished) return;
      logErr('request error', err);
      done(400, { error: { message: 'Request error' } });
    });
  });
}

process.on('uncaughtException', err => {
  if (err?.code === 'ERR_HTTP_HEADERS_SENT') {
    logErr('ignored headers-sent race', err);
    return;
  }
  logErr('uncaughtException', err);
  process.exit(1);
});

process.on('unhandledRejection', err => {
  logErr('unhandledRejection', err);
  process.exit(1);
});

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!isAuthorized(req.headers.authorization)) {
    return json(res, 401, { error: { message: 'Invalid gateway token', type: 'auth_error' } });
  }

  if (req.method === 'GET' && (req.url === '/v1/models' || req.url === '/models')) {
    return json(res, 200, {
      object: 'list',
      data: MODEL_LIST.map(id => ({ id, object: 'model', created: 1749600000, owned_by: 'codexsale' })),
    });
  }

  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    readJsonBody(req, res).then(async parsed => {
      if (!parsed) return;

      const strippedFields = messageFieldSummary(parsed.messages).filter(m => m.extra.length);
      if (strippedFields.length) {
        log(`stripped extra msg fields: ${JSON.stringify(strippedFields)}`);
      }

      if (GATEWAY_MODE === 'app-server') {
        // App-server mode: pass raw (unsanitized) body to bridge.
        // Codex CLI manages its own context budget; sanitizer truncation
        // would replace user content with placeholders and break the prompt.
        logWarn(
          `request ${parsed.messages?.length ?? 0} msgs, `
          + `payload≈${Math.round(estimateRequestPayloadChars(parsed) / 1024)}KB, `
          + `tools=${parsed.tools?.length ?? 0}, mode=app-server`,
        );
        await runOpenAiViaAppServer({
          body: parsed,
          res,
          clientReq: req,
          options: {
            apiKey: API_KEY,
            upstreamUrl: UPSTREAM_URL,
            codexBin: CODEX_BIN,
            codexHome: CODEX_HOME,
            cwd: CODEX_CWD,
            turnTimeoutMs: APP_SERVER_TURN_TIMEOUT_MS,
            onWarn: logWarn,
            onLog: log,
          },
        });
        return;
      }

      // HTTP mode only: sanitize for upstream budget constraints
      const sanitized = sanitizeRequest(parsed, logWarn, { attemptNum: 0 });
      const clientToolNames = collectToolNames(parsed.tools);
      const maxHollowRetries = parsed.stream === true ? HOLLOW_RETRIES : 0;

      const buildAttemptPayload = (attemptNum) => {
        const profile = profileForAttempt(attemptNum);
        const attemptBody = sanitizeRequest(parsed, logWarn, { attemptNum, profile });
        if (attemptNum > 0) {
          logWarn(
            `hollow retry profile attempt=${attemptNum + 1}/${maxHollowRetries + 1}: `
            + `${attemptBody.messages?.length ?? 0} msgs, `
            + `payload≈${Math.round(estimateRequestPayloadChars(attemptBody) / 1024)}KB, `
            + `tools=${attemptBody.tools?.length ?? 0}`,
          );
        }
        return attemptBody;
      };

      let settled = false;
      let aborted = false;
      let currentUpstreamReq = null;
      let headSent = false;
      let attemptStreamCleanup = null;
      let clientHandlersAttached = false;

      const attachClientHandlers = () => {
        if (clientHandlersAttached) return;
        clientHandlersAttached = true;
        req.on('aborted', () => {
          aborted = true;
          attemptStreamCleanup?.();
          if (currentUpstreamReq) currentUpstreamReq.destroy();
        });
        res.on('close', () => {
          if (!res.writableFinished) attemptStreamCleanup?.();
        });
        res.on('error', err => {
          if (err?.code !== 'EPIPE' && err?.code !== 'ECONNRESET') {
            logErr('response error', err);
          }
          attemptStreamCleanup?.();
        });
      };
      attachClientHandlers();

      const ensureSseHead = (status, headers) => {
        if (headSent || res.writableEnded || res.destroyed) return;
        headSent = true;
        res.writeHead(status ?? 200, {
          'Content-Type': headers?.['content-type'] ?? 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
      };

      const emitSyntheticHollow = (meta) => {
        settled = true;
        ensureSseHead(200, {});
        const text = HOLLOW_FALLBACK_TEXT;
        for (const line of buildAssistantTextSseChunks(meta, text)) {
          if (!res.writableEnded) res.write(`${line}\n\n`);
        }
        if (!res.writableEnded) res.write('data: [DONE]\n\n');
        if (!res.writableEnded) res.end();
      };

      const handleUpstreamError = (status, payload) => {
        settled = true;
        const errorBody = typeof payload === 'string'
          ? (() => { try { return JSON.parse(payload); } catch { return { error: { message: payload } }; } })()
          : payload;
        const rawJson = JSON.stringify(parsed);
        const sanitizedJson = JSON.stringify(sanitized);
        logWarn(`upstream ${status} msgs=${sanitized.messages?.length} tools=${sanitized.tools?.length} keys=${sanitized.messages?.map(m => `${m.role}:${Object.keys(m).join('+')}`).join('; ')}`);
        logWarn(`upstream error: ${JSON.stringify(errorBody).slice(0, 600)}`);
        logWarn(`400 strict scan raw=${rawJson.includes('"strict"')} sanitized=${sanitizedJson.includes('"strict"')} schema=${sanitizedJson.includes('$schema')}`);
        dump400('upstream-4xx', {
          rawExtra: strippedFields,
          summary: redactRequestSummary(sanitized),
          rawHasStrict: rawJson.includes('"strict"'),
          sanitizedHasStrict: sanitizedJson.includes('"strict"'),
          sanitizedHasSchema: sanitizedJson.includes('$schema'),
          status,
          upstreamError: errorBody?.error,
          sanitized,
        });
        dumpDebug('upstream-4xx', {
          rawExtra: strippedFields,
          summary: redactRequestSummary(sanitized),
          status,
          upstreamError: errorBody?.error,
        });
        return json(res, status, errorBody);
      };

      const consumeStreamAttempt = (upstream, upReq, clientReq, attemptNum) => {
        const sanitizer = createStreamSanitizer(clientToolNames, msg => logWarn(`response: ${msg}`));
        const detector = createHollowResponseDetector();
        let buffer = '';
        let decided = false;
        let upstreamPaused = false;
        let lastMeta = null;
        const preamble = [];
        const pendingDone = [];
        let cleanedUp = false;

        const cleanup = () => {
          if (cleanedUp) return;
          cleanedUp = true;
          attemptStreamCleanup = null;
          upstream.removeAllListeners();
          upReq.destroy();
          upstream.destroy();
        };
        attemptStreamCleanup = cleanup;

        const writeLive = (data) => {
          if (res.writableEnded || res.destroyed) return false;
          const ok = res.write(data);
          if (!ok && !upstreamPaused) { upstream.pause(); upstreamPaused = true; }
          return ok;
        };

        const goLive = () => {
          decided = true;
          settled = true;
          ensureSseHead(200, {});
          for (const line of preamble) writeLive(line);
          preamble.length = 0;
          res.on('drain', () => {
            if (upstreamPaused) { upstream.resume(); upstreamPaused = false; }
          });
        };

        const handleLine = (line) => {
          if (!line.trim()) {
            if (decided) writeLive('\n'); else preamble.push('\n');
            return;
          }
          if (!sanitizer.isDoneSseLine(line)) {
            const raw = parseSseChunk(line);
            if (raw) {
              detector.observeChunk(raw);
              if (raw.id || raw.model) lastMeta = raw;
            }
          }
          if (sanitizer.isDoneSseLine(line)) {
            pendingDone.push(sanitizer.sanitizeSseLine(line));
            return;
          }
          const sline = `${sanitizer.sanitizeSseLine(line)}\n`;
          if (decided) { writeLive(sline); return; }
          preamble.push(sline);
          if (detector.isMeaningful()) goLive();
        };

        upstream.on('data', chunk => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) handleLine(line);
        });

        upstream.on('end', () => {
          if (buffer) { handleLine(buffer); buffer = ''; }

          if (decided) {
            for (const line of sanitizer.finalizeStream()) writeLive(`${line}\n\n`);
            for (const doneLine of pendingDone) writeLive(`${doneLine}\n\n`);
            if (!res.writableEnded) res.end();
            return;
          }

          if (attemptNum < maxHollowRetries) {
            logWarn(`hollow upstream response (out=1) — retrying attempt ${attemptNum + 2}/${maxHollowRetries + 1}`);
            cleanup();
            startAttempt(attemptNum + 1);
            return;
          }
          logWarn('hollow upstream response after retries — returning synthetic error to client');
          emitSyntheticHollow(lastMeta);
        });

        upstream.on('error', err => {
          if (decided) {
            logErr('upstream stream error', err);
            if (!res.writableEnded) res.end();
            return;
          }
          if (attemptNum < maxHollowRetries && !aborted) {
            logWarn('upstream stream error before first token — retrying');
            cleanup();
            startAttempt(attemptNum + 1);
            return;
          }
          settled = true;
          if (!headSent) return json(res, 502, { error: { message: err.message } });
          if (!res.writableEnded) res.end();
        });
      };

      function startAttempt(attemptNum) {
        const attemptPayload = buildAttemptPayload(attemptNum);
        currentUpstreamReq = proxyToUpstream('/chat/completions', 'POST', attemptPayload, (err, status, headers, payload, upReq) => {
          if (settled || aborted) return;
          currentUpstreamReq = upReq;

          if (err) {
            if (attemptNum < maxHollowRetries && !headSent) {
              logWarn('upstream transport error — retrying');
              startAttempt(attemptNum + 1);
              return;
            }
            settled = true;
            return json(res, 502, { error: { message: err.message } });
          }

          if (status && status >= 400) {
            return handleUpstreamError(status, payload);
          }

          if (parsed.stream === true && payload && typeof payload.pipe === 'function') {
            if (res.writableEnded || res.destroyed) {
              settled = true;
              upReq.destroy();
              payload.destroy();
              return;
            }
            consumeStreamAttempt(payload, upReq, req, attemptNum);
            return;
          }

          settled = true;
          if (res.headersSent) return;
          const responseBody = typeof payload === 'string'
            ? (() => { try { return JSON.parse(payload); } catch { return payload; } })()
            : payload;
          const sanitizedResponse = typeof responseBody === 'object' && responseBody !== null
            ? sanitizeCompletionPayload(responseBody, clientToolNames, msg => logWarn(`response: ${msg}`))
            : responseBody;
          res.writeHead(status ?? 200, { 'Content-Type': 'application/json' });
          res.end(typeof sanitizedResponse === 'string'
            ? sanitizedResponse
            : JSON.stringify(sanitizedResponse));
        });
      }

      startAttempt(0);
    });
    return;
  }

  return json(res, 404, { error: { message: 'Not found', type: 'not_found' } });
});

if (isMain) {
  server.listen(PORT, '0.0.0.0', () => {
    if (GATEWAY_MODE === 'app-server' && API_KEY) {
      try {
        const cfg = setupCodexSaleConfig(CODEX_HOME, API_KEY);
        log(`codex-sale config: ${cfg.configPath}`);
      } catch (err) {
        logErr('codex-sale config setup failed', err);
      }
    }
    log(`listening 0.0.0.0:${PORT} → ${UPSTREAM_URL}`);
    log(`mode: ${GATEWAY_MODE}${GATEWAY_MODE === 'app-server' ? ` (bin=${CODEX_BIN}, home=${CODEX_HOME})` : ''}`);
    log(`models: ${MODEL_LIST.join(', ')}`);
    log(`auth: ${GATEWAY_SECRET ? 'enabled (gateway secret or API key)' : 'DISABLED'}`);
    log(`debug dump: ${DEBUG_DUMP || 'off'}`);
    log(`400 dump: ${DUMP_400}`);
    log(`max body: ${MAX_BODY_BYTES} bytes`);
  });
}

export { server, isAuthorized, pipeStream, parseSseChunk };
