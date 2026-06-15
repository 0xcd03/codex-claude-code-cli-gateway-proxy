#!/usr/bin/env bash
# Deploy omnirouter-gw gateway sources to server.
# Configuration:
#   1. Copy deploy.env.example → deploy.env
#   2. Fill in GW_HOST and GW_SSH_KEY
#   3. Run: bash deploy.sh
set -euo pipefail

DIR="$(dirname "$0")"

# Auto-source deploy.env if present (not committed to git)
if [ -f "$DIR/deploy.env" ]; then
  set -a; source "$DIR/deploy.env"; set +a
fi

HOST="${GW_HOST:-}"
KEY="${GW_SSH_KEY:-}"
GATEWAY_DIR="${GW_REMOTE_GATEWAY_DIR:-/opt/claude-gateway}"
OMNIROUTE_DIR="${GW_REMOTE_OMNIROUTE_DIR:-/opt/omniroute}"
GW="$DIR/scripts/claude-gateway"

if [ -z "$HOST" ] || [ -z "$KEY" ]; then
  echo "ERROR: GW_HOST and GW_SSH_KEY are not set." >&2
  echo "" >&2
  echo "  Option 1: Create deploy.env from the template:" >&2
  echo "    cp deploy.env.example deploy.env" >&2
  echo "    # edit deploy.env with your server IP and SSH key path" >&2
  echo "    bash deploy.sh" >&2
  echo "" >&2
  echo "  Option 2: Export env vars directly:" >&2
  echo "    GW_HOST=root@your-server GW_SSH_KEY=/path/to/key bash deploy.sh" >&2
  exit 1
fi

SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20"
SCP="scp -i $KEY -o StrictHostKeyChecking=accept-new"

echo "=== 0. Migrate server paths (vbcdr → claude) ==="
$SSH "$HOST" '
  if [ -f /etc/vbcdr-secrets/api_key ] && [ ! -f /etc/claude-secrets/api_key ]; then
    mkdir -p /etc/claude-secrets
    cp /etc/vbcdr-secrets/api_key /etc/claude-secrets/api_key
    chmod 600 /etc/claude-secrets/api_key
    echo "migrated: /etc/claude-secrets/api_key"
  elif [ -f /etc/claude-secrets/api_key ]; then
    echo "already: /etc/claude-secrets/api_key"
  else
    echo "WARN: no claude API key found"
  fi
  if [ -d /opt/vbcdr-gateway ] && [ ! -d '"$GATEWAY_DIR"' ]; then
    cp -a /opt/vbcdr-gateway '"$GATEWAY_DIR"'
    echo "migrated: $GATEWAY_DIR/"
  elif [ -d '"$GATEWAY_DIR"' ]; then
    echo "already: $GATEWAY_DIR/"
  fi
'
echo ""

echo "=== 1. Tests ==="
cd "$GW" && npm test
echo ""

echo "=== 2. Copy sources + compose ==="
$SCP \
    "$GW/server.js" \
    "$GW/codex-gateway.mjs" \
    "$GW/codex-sanitize.mjs" \
    "$GW/codex-app-server-client.mjs" \
    "$GW/openai-codex-bridge.mjs" \
    "$GW/claude-bridge.mjs" \
    "$GW/tool-mapping.mjs" \
    "$HOST:$GATEWAY_DIR/"
$SCP "$DIR/config/docker-compose.yml" "$HOST:$OMNIROUTE_DIR/docker-compose.yml"

echo "=== 3. Restart container ==="
$SSH "$HOST" "mkdir -p $OMNIROUTE_DIR/codex-home && cd $OMNIROUTE_DIR && docker compose up -d omniroute"
sleep 15

echo "=== 4. Verify ==="
$SSH "$HOST" '
echo "--- container ---"
docker ps --filter name=omniroute --format "{{.Status}}"
echo "--- codex bin ---"
docker exec omniroute sh -c "codex --version 2>&1 || echo NOT_FOUND"
echo "--- config.toml ---"
docker exec omniroute cat '"$OMNIROUTE_DIR"'/codex-home/.codex/config.toml 2>&1 || echo NOT_FOUND
echo "--- gateway models ---"
docker exec omniroute node -e "const h=require(\"http\");h.get(\"http://127.0.0.1:20132/v1/models\",r=>{let d=\"\";r.on(\"data\",c=>d+=c);r.on(\"end\",()=>console.log(d.slice(0,500)))});" 2>&1
'

echo "=== 5. Tool test ==="
$SSH "$HOST" '
docker exec omniroute node -e "
const h = require(\"http\");
const body = JSON.stringify({model:\"gpt-5.5\",stream:true,messages:[{role:\"user\",content:\"Write file /tmp/x.txt with content hello\"}],tools:[{type:\"function\",function:{name:\"Write\",parameters:{type:\"object\",properties:{path:{type:\"string\"},contents:{type:\"string\"}},required:[\"path\",\"contents\"]}}}]});
const r = h.request({hostname:\"127.0.0.1\",port:20132,path:\"/v1/chat/completions\",method:\"POST\",headers:{\"Content-Type\":\"application/json\",\"Content-Length\":Buffer.byteLength(body)}}, res => {
  let out=\"\";
  res.on(\"data\", c => {
    const lines = c.toString().split(\"\\n\");
    for (const l of lines) {
      if (!l.startsWith(\"data:\") || l.includes(\"[DONE]\")) continue;
      try { const j = JSON.parse(l.slice(5).trim()); const d = j.choices?.[0]?.delta; if (d?.content) out += d.content; if (d?.tool_calls) for (const tc of d.tool_calls) if (tc?.function?.name) out += \" TOOL:\"+tc.function.name+\" args:\"+(tc.function.arguments||\"\").slice(0,150); } catch {}
    }
  });
  res.on(\"end\", () => { console.log(out.slice(0,600)); process.exit(0); });
});
r.on(\"error\", e => { console.log(\"ERR:\", e.message); process.exit(1); });
r.setTimeout(90000, () => { console.log(\"TIMEOUT\"); process.exit(1); });
r.write(body); r.end();
" 2>&1
'

echo ""
echo "=== DEPLOY COMPLETE ==="
