# kiro-openai-proxy

OpenAI-compatible HTTP proxy for Kiro CLI ACP/headless mode.

The goal is boring on purpose: point any OpenAI-compatible client at this service, send `chat.completions`, and let Kiro do the actual agent work behind the curtain.

## Features

- `POST /v1/chat/completions`
- `GET /v1/models`
- Bearer auth via `API_KEY`
- Session reuse via `session_id`, `kiro_session_id`, or `x-kiro-session-id`
- Optional OpenAI-style SSE response shape (`stream: true`)
- Zero runtime npm dependencies

## Requirements

- Node.js 20+
- Kiro CLI installed and authenticated/headless-ready
- `KIRO_API_KEY` if your Kiro setup uses API-key auth

```bash
kiro-cli --version
```

## Quick start

```bash
git clone https://github.com/viezai/kiro-openai-proxy.git
cd kiro-openai-proxy
npm install

cp .env.example .env
# edit API_KEY and KIRO_API_KEY

npm start
```

Test:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H 'authorization: Bearer local-dev-key' \
  -H 'content-type: application/json' \
  -d '{
    "model":"kiro",
    "messages":[{"role":"user","content":"Say hello from Kiro"}]
  }'
```

Reuse a Kiro session:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H 'authorization: Bearer local-dev-key' \
  -H 'content-type: application/json' \
  -H 'x-kiro-session-id: <session-id-from-previous-response>' \
  -d '{"model":"kiro","messages":[{"role":"user","content":"Continue from previous context"}]}'
```

The response includes:

```json
{
  "kiro": {
    "session_id": "...",
    "metadata": {}
  }
}
```

## Environment

| Variable | Default | Description |
|---|---:|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind host |
| `API_KEY` | empty | If set, requires `Authorization: Bearer <API_KEY>` |
| `MODEL_ID` | `kiro` | Model id exposed in OpenAI-compatible responses |
| `KIRO_CLI_PATH` | `kiro-cli` | Kiro CLI executable path |
| `KIRO_CWD` | process cwd | Working directory passed to Kiro sessions |
| `KIRO_API_KEY` | inherited | Kiro API key for headless auth |
| `REQUEST_TIMEOUT_MS` | `600000` | Kiro prompt timeout |
| `DEBUG` | empty | Print Kiro stderr |

## Notes

This is not a full OpenAI API implementation. It is a pragmatic bridge for agent routing:

- Kiro ACP is the source of truth.
- OpenAI compatibility is intentionally limited to common chat clients.
- Token usage is returned as zero because Kiro credits/usage are not OpenAI tokens.
- Streaming currently emits the final Kiro answer as one content chunk after Kiro finishes.

## License

MIT
