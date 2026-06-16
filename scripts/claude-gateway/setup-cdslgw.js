#!/usr/bin/env node
/**
 * setup-cdslgw.js — Configure OmniRoute Codex Sale Gateway provider.
 *
 * Usage: node setup-cdslgw.js <NODE_ID>
 *   node setup-cdslgw.js openai-compatible-chat-e8ee18ea-793f-4bb4-bdff-38959b91cb5a
 *
 * Creates connection, adds models, sets active. Node must already exist.
 */
const NODE_ID = process.argv[2];
if (!NODE_ID) { console.error('Usage: node setup-cdslgw.js <NODE_ID>'); process.exit(1); }

const http = require('http');
const KEY = process.env.CODEX_API_KEY || 'sk-clb-kyEhsquRHv9y6O7vpIkRdCApCf4xr-o4d8E_ZK35O6Q';
const MODELS = ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5', 'gpt-image-2', 'gpt-4o-transcribe'];
const PREFIX = 'cdslgw';

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ hostname: '127.0.0.1', port: 20128, path, method,
      headers: { 'Content-Type': 'application/json' },
    }, res => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function setup(nodeId) {
  console.log('Node:', nodeId);

  // 1 — create connection
  console.log('1. Creating connection...');
  const connRes = await api('POST', '/api/providers', {
    provider: nodeId, name: 'codexsale', apiKey: KEY,
    providerSpecificData: { prefix: PREFIX, nodeName: 'Codex Sale Gateway' },
  });
  const connId = connRes.connection?.id;
  if (!connId) { console.error('FAIL:', JSON.stringify(connRes).slice(0,300)); return; }
  console.log('   CONN:', connId);

  // 2 — add models
  console.log('2. Adding models...');
  for (const m of MODELS) {
    await api('POST', '/api/provider-models', {
      provider: nodeId, connectionId: connId, modelId: m, name: m, source: 'manual',
    });
    console.log('   ' + m);
  }

  // 3 — sync
  await api('POST', '/api/providers/' + connId + '/sync-models');
  console.log('3. Models synced');

  // 4 — test after delay
  await new Promise(r => setTimeout(r, 3000));
  console.log('4. E2E test...');
  const testRes = await new Promise(resolve => {
    const r = http.request({ hostname: '127.0.0.1', port: 20129, path: '/v1/chat/completions', method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OMNIROUTE_API_KEY || 'sk-f4df583d7637d6b1-7332eb-aeebc0a5'}`, 'Content-Type': 'application/json' },
    }, res => { let b=''; res.on('data',d=>b+=d); res.on('end',()=>{ try{resolve(JSON.parse(b));}catch{resolve(b);} }); });
    r.write(JSON.stringify({ model: PREFIX+'/gpt-5.4', max_tokens: 20, messages: [{role:'user',content:'Reply only: CODEX_OK'}] }));
    r.end();
  });
  if (testRes.choices) {
    console.log('   ✅', testRes.choices[0].message.content);
  } else {
    console.log('   ❌', JSON.stringify(testRes).slice(0, 300));
  }

  console.log('\nModels:');
  MODELS.forEach(m => console.log('  ' + PREFIX + '/' + m));
}

setup(NODE_ID).catch(e => { console.error(e); process.exit(1); });
