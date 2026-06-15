# OmniRouter Gateway

Gateway-проект для OmniRoute: два OpenAI-совместимых прокси с dynamic tool passthrough.

---

## Структура

```
omnirouter-gw/
  config/docker-compose.yml      # compose для развёртывания
  scripts/claude-gateway/        # claude-gateway + codex-gateway (исходники)
  deploy.sh                      # скрипт деплоя
```

---

## Gateways

| Gateway | Port | Описание |
|---------|------|----------|
| codex-gateway | 20132 | Codex App Server bridge (`codex app-server --stdio → codex.sale`) с dynamicTools passthrough |
| claude-gateway | 20130 | Claude CLI bridge (`stream-json` с tool_use passthrough) |

Оба gateway запускаются как sidecar внутри контейнера OmniRoute (см. `config/docker-compose.yml`).

---

## Docker Compose

**Файл:** `config/docker-compose.yml`

**Auto-start sidecars (entrypoint):**
- `npm install -g @anthropic-ai/claude-code`
- `npm install -g @openai/codex`
- `claude-gateway` на 20130 (Claude Code CLI subprocess)
- `codex-gateway` на 20132 (прокси к codex.sale)

**Restart:**
```bash
ssh $HOST 'cd /path/to/omniroute && docker compose restart omniroute'
```

**Deploy gateway sources:**
```bash
GW=./scripts/claude-gateway
HOST=root@your-server

scp -i "$SSH_KEY" \
  "$GW/server.js" \
  "$GW/codex-gateway.mjs" \
  "$GW/codex-sanitize.mjs" \
  "$GW/codex-app-server-client.mjs" \
  "$GW/openai-codex-bridge.mjs" \
  "$GW/claude-bridge.mjs" \
  "$GW/tool-mapping.mjs" \
  "$HOST:/opt/claude-gateway/"
scp -i "$SSH_KEY" config/docker-compose.yml "$HOST:/opt/omniroute/"
ssh "$HOST" 'cd /opt/omniroute && docker compose restart omniroute'
```

**Tests:**
```bash
cd scripts/claude-gateway && npm test
```

---

## Codex Sale Gateway (cdslgw)

**Prefix:** `cdslgw`

```
Cursor → OmniRoute → codex-gateway → codex app-server --stdio → codex.sale
                                    ↑ dynamicTools passthrough
                                    (tools execute in Cursor, NOT on server)
```

**Codex CLI config:**
- Provider: `https://codex.sale/backend-api/codex` (`wire_api = responses`)
- Ключ: `CODEX_LB_API_KEY` из Docker secret
- Файлы: `$CODEX_HOME/.codex/auth.json` + `config.toml` (авто-генерация при старте)

**Modes** (`CODEX_GATEWAY_MODE`):
- `app-server` — App Server bridge с dynamicTools (default)
- `http` — прямой HTTP proxy с hollow-response retry

**Требования:** `@openai/codex` CLI (устанавливается в entrypoint).

---

## Claude Code Gateway (claude)

**Prefix:** `claude`

```
Cursor → OmniRoute → claude-gateway → claude -p --output-format stream-json → vibecode
                                    ↑ tool_use passthrough
                                    (tools execute in Cursor, NOT on server)
```

**Tool mapping** (Claude → Cursor):
| Claude | Cursor |
|--------|--------|
| Write | Write |
| Bash | Shell |
| Read | Read |
| Edit | StrReplace |
| Glob | Glob |
| Grep | Grep |

**Modes** (`CLAUDE_GATEWAY_MODE`):
- `bridge` — stream-json с tool_use passthrough (default)
- `legacy` — plain `claude -p` text-only

**Требования:** `@anthropic-ai/claude-code` CLI (устанавливается в entrypoint).

---

## Verified (2026-06-15)

- [x] `codex app-server --stdio` работает с codex.sale backend
- [x] Tool call (Write) через dynamicTools: `Write {"path":"/tmp/hello.txt","contents":"world\n"}`
- [x] Claude stream-json tool_use: Write, Bash, Read, Edit, Glob
- [x] 88/88 unit tests passing
- [x] HTTP fallback mode (hollow retry + sanitization)
