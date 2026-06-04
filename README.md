# paperclip-openrouter

[![npm version](https://img.shields.io/npm/v/paperclip-openrouter.svg)](https://www.npmjs.com/package/paperclip-openrouter)
[![CI](https://github.com/HLLMR/paperclip-openrouter/actions/workflows/ci.yml/badge.svg)](https://github.com/HLLMR/paperclip-openrouter/actions/workflows/ci.yml)
[![npm downloads](https://img.shields.io/npm/dm/paperclip-openrouter.svg)](https://www.npmjs.com/package/paperclip-openrouter)
[![node](https://img.shields.io/node/v/paperclip-openrouter.svg)](https://www.npmjs.com/package/paperclip-openrouter)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A [Paperclip](https://github.com/paperclipai/paperclip) **external adapter** that runs any of OpenRouter's 300+ models as a Paperclip agent — no local CLI required.

It talks straight to the OpenRouter REST API (`/chat/completions`) and runs an in-process, multi-turn **tool loop**: the model can call the Paperclip API, read/write files in its workspace, and (opt-in) run shell commands. Usage, cost, and remaining credit balance are reported back to Paperclip, and Anthropic/Gemini prompts are cached automatically.

## Why this adapter

- **No runtime to install.** Unlike CLI adapters (`claude_local`, `codex_local`, `opencode_local`), this needs only an OpenRouter API key.
- **Full live model catalog.** The agent model picker is populated from OpenRouter's live `/models` endpoint (cached 5 min), not a hardcoded list.
- **Real cost + credits.** Per-run cost comes from OpenRouter's `usage.include` field; remaining prepaid credit balance is surfaced to Paperclip's quota dashboard via `getQuotaWindows()`.
- **Prompt caching built in (verified).** Anthropic and Gemini requests get `cache_control` breakpoints on the stable system + conversation prefix; measured end-to-end through OpenRouter, a cache read bills the cached tokens at ~10% of input. Note: providers only cache a prefix **above a minimum size** (a few thousand tokens; higher for Haiku), so short prompts won't cache. `cacheTtl: "1h"` extends the cache for spaced heartbeats. See [docs/cost-and-caching.md](docs/cost-and-caching.md).
- **Honest packaging.** Ships compiled `dist/`, the `./ui-parser` export with `paperclip.adapterUiParser`, and `createServerAdapter()` — it satisfies the official external-adapter contract.

## How it compares

| | This adapter | Typical community OpenRouter adapters |
|---|---|---|
| Model scope | Any OpenRouter model | Often locked to one provider/model |
| Model picker | Live `/models` catalog | Hardcoded list |
| Cost reporting | Per-run `costUsd` + credit balance | Usually none |
| Prompt caching | Anthropic/Gemini `cache_control` | None |
| UI transcript | Renders tool calls + results | Often plain stdout |
| Packaging | `dist` + `ui-parser` + `createServerAdapter` | Frequently `src`-only / partial |

## Install

### From the Paperclip UI

Settings → Adapters → Install from npm → `paperclip-openrouter`

### From the API

```sh
curl -X POST "$PAPERCLIP_API_URL/api/adapters/install" \
  -H "Authorization: Bearer <instance-admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"packageName": "paperclip-openrouter"}'
```

### From a local build (development)

```sh
npm install
npm run build
curl -X POST "$PAPERCLIP_API_URL/api/adapters/install" \
  -H "Authorization: Bearer <instance-admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"packageName": "'"$PWD"'", "isLocalPath": true}'
```

## Quick start

In the Paperclip UI → Org Chart → Hire Agent:

- **Adapter**: OpenRouter
- **Model**: any OpenRouter id, e.g. `openai/gpt-4o-mini`, `anthropic/claude-3.5-sonnet`, `qwen/qwen-2.5-coder-32b-instruct`, or a `:free` variant
- **API key**: set `apiKey` in the agent config, or provide `OPENROUTER_API_KEY` in the adapter env or the Paperclip host environment

A minimal agent config:

```json
{
  "model": "anthropic/claude-3.5-sonnet",
  "apiKey": "sk-or-v1-...",
  "tools": { "shell": { "enabled": true, "allowList": ["git ", "ls", "cat "] } }
}
```

Run **Test Environment** to validate the key, confirm the model exists in the live catalog, and read your remaining credit balance.

## Configuration

Full reference: [docs/configuration.md](docs/configuration.md). Highlights:

| Field | Default | Notes |
|---|---|---|
| `model` | `openai/gpt-4o-mini` | any OpenRouter `provider/model` id |
| `apiKey` / `OPENROUTER_API_KEY` | — | required |
| `apiBaseUrl` | `https://openrouter.ai/api/v1` | override for proxies/self-host |
| `temperature`, `topP`, `maxTokens` | unset | omitted when blank |
| `reasoningEffort` | unset | `low`/`medium`/`high` for reasoning models |
| `disablePromptCaching` | `false` | turn off Anthropic/Gemini `cache_control` |
| `cacheTtl` | `5m` | cache lifetime; `1h` for heartbeats spaced > 5 min |
| `maxToolTurns` | `12` | tool-call/response loop cap per heartbeat |
| `tools.shell.enabled` | `false` | opt-in shell execution |
| `tools.fs.allowOutsideCwd` | `false` | restrict fs tools to the workspace |

More docs: [examples](docs/examples.md) · [cost & caching](docs/cost-and-caching.md) · [troubleshooting](docs/troubleshooting.md)

## Tools exposed to the model

- `paperclip_api_request` — authenticated Paperclip API calls (auth + run-id injected automatically)
- `paperclip_search_issues` — issue search scoped to the agent's company
- `fs_read_file`, `fs_write_file`, `fs_list_dir` — workspace-scoped filesystem access
- `shell_exec` — bash execution (disabled by default; supports an allow-list)

## Develop

```sh
npm install
npm run typecheck
npm test          # compiles + runs node:test unit tests
npm run build     # emits dist/
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Security policy: [SECURITY.md](SECURITY.md).

## Provenance

Clean-room implementation. Structurally informed by the MIT-licensed
`paperclip-adapter-qwen-openrouter` (the cleanest community adapter) and the
Paperclip API tool definitions from `paperclip-adapter-openrouter-talha`,
generalized to any OpenRouter model and extended with a live model catalog,
credit-balance reporting, reasoning-effort support, Anthropic/Gemini prompt
caching, and a tool-call-aware UI parser. Not affiliated with OpenRouter or
the Paperclip maintainers.

## License

[MIT](LICENSE) — free for everyone, always.
