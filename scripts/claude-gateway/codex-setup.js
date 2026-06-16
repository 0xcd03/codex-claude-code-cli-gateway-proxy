#!/usr/bin/env node
/**
 * codex-setup.js — One-shot script to configure OmniRoute provider node
 * for codex-gateway (inside-container sidecar on port 20131).
 *
 * Run inside the OmniRoute Docker container:
 *   docker cp codex-setup.js omniroute:/tmp/ && docker exec omniroute node /tmp/codex-setup.js
 */

import { createServer } from 'node:http';

const OMNIRoute_API = 'http://127.0.0.1:20128';

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, OMNIRoute_API);
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: '127.0.0.1',
      port: 20128,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const req = createServer ? null : null; // stub

    const http = require('node:http');
    const r = http.request(opts, res => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  console.log('=== Creating codex-gateway provider node ===');

  // Step 1: Create provider node
  const nodeRes = await api('POST', '/api/provider-nodes', {
    type: 'openai-compatible',
    name: 'Codex Sale Gateway',
    prefix: 'cdslgw',
    baseUrl: 'http://127.0.0.1:20131/v1',
    apiType: 'chat',
    chatPath: '/v1/chat/completions',
  });
  const nodeId = nodeRes.body?.node?.id;
  if (!nodeId) { console.log('NODE CREATE FAILED:', JSON.stringify(nodeRes.body).slice(0, 200)); return; }
  console.log('Node:', nodeId);

  // Step 2: Create connection
  const connRes = await api('POST', '/api/providers', {
    provider: nodeId,
    name: 'codexsale',
    apiKey: process.env.CODEX_API_KEY || 'sk-clb-kyEhsquRHv9y6O7vpIkRdCApCf4xr-o4d8E_ZK35O6Q',
    providerSpecificData: { prefix: 'cdslgw', nodeName: 'Codex Sale Gateway' },
  });
  const connId = connRes.body?.connection?.id;
  if (!connId) { console.log('CONN CREATE FAILED:', JSON.stringify(connRes.body).slice(0, 200)); return; }
  console.log('Connection:', connId);

  // Step 3: Add models
  const models = ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5', 'gpt-image-2', 'gpt-4o-transcribe'];
  for (const m of models) {
    await api('POST', '/api/provider-models', {
      provider: nodeId,
      connectionId: connId,
      modelId: m,
      name: m,
      source: 'manual',
    });
    console.log('  Model:', m);
  }

  // Step 4: Sync models
  await api('POST', `/api/providers/${connId}/sync-models`);
  console.log('Models synced');

  console.log('');
  console.log('DONE. Use prefix cdslgw in OmniRoute:');
  console.log('  cdslgw/gpt-5.4');
  console.log('  cdslgw/gpt-5.4-mini');
  console.log('  cdslgw/gpt-5.5');
  console.log('  cdslgw/gpt-image-2');
  console.log('  cdslgw/gpt-4o-transcribe');
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
