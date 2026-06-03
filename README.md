# @envora/paperclip-adapter-openrouter

A [Paperclip](https://github.com/paperclipai/paperclip) **external adapter** that runs any of OpenRouter's 300+ models as a Paperclip agent — no local CLI required.

It talks straight to the OpenRouter REST API (`/chat/completions`) and runs an in-process, multi-turn **tool loop**: the model can call the Paperclip API, read/write files in its workspace, and (opt-in) run shell commands. Usage, cost, and remaining credit balance are reported back to Paperclip.

## Why this adapter

- **No runtime to install.** Unlike CLI adapters (`claude_local`, `codex_local`, `opencode_local`), this needs only an OpenRouter API key.
- **Full live model catalog.** The agent model picker is populated from OpenRouter's live `/models` endpoint (cached 5 min), not a hardcoded list.
- **Real cost + credits.** Per-run cost comes from OpenRouter's `usage.include` field; remaining prepaid credit balance is surfaced to Paperclip's quota dashboard via `getQuotaWindows()`.
- **Honest packaging.** Ships compiled `dist/`, the `./ui-parser` export with `paperclip.adapterUiParser`, and `createServerAdapter()` — i.e. it satisfies the official external-adapter contract.

## Install

### From the Paperclip UI

Settings → Adapters → Install from npm → `@envora/paperclip-adapter-openrouter`

### From the API

```sh
curl -X POST "$PAPERCLIP_API_URL/api/adapters/install" \
  -H "Authorization: Bearer <instance-admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"packageName": "@envora/paperclip-adapter-openrouter"}'
```

### From a local build (development)

```sh
npm install
npm run build
# then point Paperclip at the built directory:
curl -X POST "$PAPERCLIP_API_URL/api/adapters/install" \
  -H "Authorization: Bearer <instance-admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"packageName": "'"$PWD"'", "isLocalPath": true}'
```

## Configure an agent

In the Paperclip UI → Org Chart → Hire Agent:

- **Adapter**: OpenRouter
- **Model**: any OpenRouter id, e.g. `openai/gpt-4o-mini`, `anthropic/claude-3.5-sonnet`, `qwen/qwen-2.5-coder-32b-instruct`, or a `:free` variant
- **API key**: set `apiKey` in the agent config, or provide `OPENROUTER_API_KEY` in the adapter env or the Paperclip host environment

Run **Test Environment** to validate the key, confirm the model exists in the live catalog, and read your remaining credit balance.

## Configuration reference

See the in-app adapter configuration doc (also in [`src/index.ts`](src/index.ts)) for the full field list. Highlights:

| Field | Default | Notes |
|---|---|---|
| `model` | `openai/gpt-4o-mini` | any OpenRouter `provider/model` id |
| `apiKey` / `OPENROUTER_API_KEY` | — | required |
| `apiBaseUrl` | `https://openrouter.ai/api/v1` | override for proxies/self-host |
| `temperature`, `topP`, `maxTokens` | unset | omitted when blank |
| `reasoningEffort` | unset | `low`/`medium`/`high` for reasoning models |
| `maxToolTurns` | `12` | tool-call/response loop cap per heartbeat |
| `tools.shell.enabled` | `false` | opt-in shell execution |
| `tools.fs.allowOutsideCwd` | `false` | restrict fs tools to the workspace |

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

## Provenance

Clean-room implementation. Structurally informed by the MIT-licensed
`paperclip-adapter-qwen-openrouter` (the cleanest community adapter) and the
Paperclip API tool definitions from `paperclip-adapter-openrouter-talha`,
generalized to any OpenRouter model and extended with a live model catalog,
credit-balance reporting, reasoning-effort support, and a tool-call-aware UI
parser. Not affiliated with OpenRouter or the Paperclip maintainers.

## License

MIT — see [LICENSE](LICENSE).
