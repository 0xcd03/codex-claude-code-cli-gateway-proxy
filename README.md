# OmniRouter Gateway (omnirouter-gw)

Локальный проект gateway для OmniRoute на сервере **fra-1-vm-5sy7**.

**Server:** 81.200.157.36  
**Hostname:** fra-1-vm-5sy7  
**OS:** Ubuntu 24.04 LTS (6.8.0-110-generic)  
**SSH key:** `/Users/dmitrij/cursor/omnirouter-gw/ssh/id_ed25519_fra1vm5sy7` (также `~/.ssh/id_ed25519_fra1vm5sy7`)

**Корень проекта:** `/Users/dmitrij/cursor/omnirouter-gw/`

---

## Структура

```
omnirouter-gw/
  config/docker-compose.yml      # compose для /opt/omniroute на сервере
  scripts/claude-gateway/      # claude-gateway + codex-gateway (исходники)
  ssh/                         # ключ для деплоя
  backups/                     # локальные бэкапы сервера
```

---

## Services

| Service | Port | Status | Notes |
|---------|------|--------|-------|
| OpenClaw | 127.0.0.1:18789 | ✅ systemd | v2026.6.1 |
| OmniRoute | 20128 / 20129 | ✅ Docker | v3.8.23 |
| claude-gateway | 127.0.0.1:20130 | ✅ inside omniroute | Claude Code CLI → vibecode |
| codex-gateway | 127.0.0.1:20132 | ✅ inside omniroute | proxy → codex.sale (20131 = EmbedWsProxy) |
| SearXNG | 127.0.0.1:18080 | ✅ Docker | |

---

## Docker Compose

**Локальная копия:** `config/docker-compose.yml`  
**На сервере:** `/opt/omniroute/docker-compose.yml`

**Auto-start sidecars (entrypoint, OmniRoute 3.8.23):**
- `npm install -g @anthropic-ai/claude-code` (idempotent)
- `claude-gateway` on 20130 (Claude Code CLI subprocess)
- `codex-gateway` on 20132 (transparent proxy to codex.sale)
- OmniRoute: `/tmp/check-permissions.sh node dev/run-standalone.mjs`
- Container runs as `root` (secrets + `/root/.claude` mounts)

**Restart:**
```bash
ssh -i /Users/dmitrij/cursor/omnirouter-gw/ssh/id_ed25519_fra1vm5sy7 root@81.200.157.36 \
  'cd /opt/omniroute && docker compose restart omniroute'
```

**Deploy gateway sources:**
```bash
GW=/Users/dmitrij/cursor/omnirouter-gw/scripts/claude-gateway
KEY=/Users/dmitrij/cursor/omnirouter-gw/ssh/id_ed25519_fra1vm5sy7
HOST=root@81.200.157.36

scp -i "$KEY" \
  "$GW/server.js" \
  "$GW/codex-gateway.mjs" \
  "$GW/codex-sanitize.mjs" \
  "$GW/codex-app-server-client.mjs" \
  "$GW/openai-codex-bridge.mjs" \
  "$HOST:/opt/claude-gateway/"
ssh -i "$KEY" "$HOST" 'mkdir -p /opt/omniroute/codex-home && cd /opt/omniroute && docker compose restart omniroute'
```

**Tests (локально):**
```bash
cd /Users/dmitrij/cursor/omnirouter-gw/scripts/claude-gateway && npm test
```

---

## Codex Sale Gateway (cdslgw)

**Prefix:** `cdslgw`

**Models:**
```
cdslgw/gpt-5.4
cdslgw/gpt-5.4-mini
cdslgw/gpt-5.5
cdslgw/gpt-image-2
cdslgw/gpt-4o-transcribe
```

**Cursor settings:**
- API Base URL: `http://81.200.157.36:20129/v1`
- Model: `cdslgw/gpt-5.5`

**Gateway:** Codex CLI App Server bridge (default) or direct HTTP proxy.

**Codex CLI config** (как в install-скрипте codex.sale):
- Provider: `https://codex.sale/backend-api/codex` (`wire_api = responses`)
- Ключ: `CODEX_LB_API_KEY` из Docker secret `/etc/codex-secrets/api_key`
- Файлы: `$CODEX_HOME/.codex/auth.json` + `config.toml` (пишутся при старте gateway)

**Modes** (`CODEX_GATEWAY_MODE`):
- `app-server` — `Cursor → codex-gateway → codex app-server --stdio → codex.sale` with `dynamicTools` passthrough (tools execute in Cursor, not on server)
- `http` — direct OpenAI-compatible proxy with hollow-response retry + sanitization

Runs inside omniroute container on **20132**. Requires `@openai/codex` CLI (installed in entrypoint).

---

## Claude Code Gateway (claude)

**Prefix:** `claude`

**Models:**
```
claude/claude-opus-4-8
claude/claude-opus-4-7
claude/claude-opus-4-6
claude/claude-opus-4-5
claude/claude-sonnet-4-6
claude/claude-sonnet-4-5
claude/claude-haiku-4-5
```

**Gateway:** runs inside container on 20130, uses `claude -p` subprocess.

---

## Notes

- Device fingerprint for Claude CLI is persisted in `/opt/omniroute/claude-home`.
- Codex API key stored in Docker secret `/etc/codex-secrets/api_key` (env: `CODEX_LB_API_KEY`).
- Codex CLI version: 0.139.0 (installed in entrypoint).
- **Все изменения gateway — только в `omnirouter-gw/scripts/claude-gateway/`.**
- После правок: `bash deploy.sh` (автоматически делает tests → scp → restart → smoke).

## Verified (2026-06-15)

- [x] `codex app-server --stdio` инициализируется с codex.sale backend
- [x] Chat completion (text) через app-server bridge: `"Hi"`
- [x] Tool call (Write) через dynamicTools: `Write {"path":"/tmp/hello.txt","contents":"world\n"}`
- [x] 77/77 unit tests passing
- [x] HTTP fallback mode работает (hollow retry + sanitization)
