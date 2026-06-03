# Troubleshooting

Common issues with the `paperclip-openrouter` adapter and how to
fix them. Most problems surface either as an error code from a run or in the
**Test Environment** diagnostics. See the
[configuration reference](./configuration.md) for any field mentioned here.

## Quick reference

| Symptom / error code | Likely cause | Fix |
|---|---|---|
| `openrouter_missing_api_key` | No API key found. | Set `apiKey`, or provide `OPENROUTER_API_KEY` via `env` or the host environment. |
| `openrouter_auth_required` | Key present but rejected by OpenRouter. | Replace with a valid, funded key; check for typos/whitespace. |
| Model not found in catalog | `model` id not in OpenRouter's live `/models` list. | Use a valid `provider/model` id from the catalog. |
| "model does not support tool use" | Selected model has no tool-calling support. | Adapter auto-retries without tools; pick a tool-capable model for tool work. |
| `openrouter_timeout` | Request exceeded `timeoutSec`. | Raise `timeoutSec` (default 180). |
| `openrouter_tool_loop_exhausted` | Hit `maxToolTurns` before finishing. | Raise `maxToolTurns` (default 12). |
| Paperclip API tools unavailable | Missing `PAPERCLIP_API_URL` / `PAPERCLIP_API_KEY`. | Ensure both are set in the adapter/host environment. |

## Missing or invalid API key

**`openrouter_missing_api_key`** means the adapter found no key at all. Provide
one of:

- `apiKey` in the agent's adapter config, or
- `OPENROUTER_API_KEY` in the adapter `env` map, or
- `OPENROUTER_API_KEY` in the Paperclip host environment.

**`openrouter_auth_required`** means a key was found but OpenRouter rejected it.
The key is invalid, revoked, or has no credit. Generate a fresh key at
OpenRouter, confirm it has a positive balance, and watch for stray
whitespace/quotes when pasting. Re-run **Test Environment** to confirm — it
validates the key and reads your remaining credit balance.

## Model not found in the catalog

The model picker is populated from OpenRouter's **live `/models` endpoint**
(cached ~5 minutes), not a hardcoded list. If a run reports the model is not in
the catalog:

- Verify the exact `provider/model` id (e.g. `anthropic/claude-3.5-sonnet`,
  `openai/gpt-4o-mini`). Ids are case- and slash-sensitive.
- The model may have been renamed or retired on OpenRouter — pick a current id.
- If you just changed it, wait for the 5-minute catalog cache to refresh.

## "Model does not support tool use"

Some OpenRouter models cannot do tool/function calling. When the adapter detects
this, it **automatically retries the request without tools** so the run can
still produce a text answer — you do not need to do anything for the run to
proceed. However, that model cannot use `paperclip_api_request`,
`fs_read_file`/`fs_write_file`/`fs_list_dir`, `shell_exec`, etc. If the agent's
job depends on tools, switch `model` to a tool-capable model.

## Timeouts (`openrouter_timeout`)

A request took longer than `timeoutSec` (default **180**). Common with large
prompts, slow upstreams, or high `reasoningEffort`. Fixes:

- Raise `timeoutSec` (e.g. `240`–`300`).
- Lower `reasoningEffort` if set to `high`.
- Reduce `maxTokens` or trim the prompt.

## Tool loop exhausted (`openrouter_tool_loop_exhausted`)

The model used up `maxToolTurns` (default **12**) tool-call/response iterations
in one heartbeat without finishing. Fixes:

- Raise `maxToolTurns` (e.g. `20`).
- Tighten the task/prompt so the agent needs fewer tool round-trips.
- If using shell, check the `tools.shell.allowList` isn't forcing repeated
  rejected attempts.

## Paperclip API tools unavailable

`paperclip_api_request` and `paperclip_search_issues` require the adapter to
know how to reach Paperclip. If they are unavailable, the environment is missing
**`PAPERCLIP_API_URL`** and/or **`PAPERCLIP_API_KEY`**. Ensure both are present
in the adapter/host environment. The filesystem and shell tools do not depend on
these and will still work.

## Reading the Test Environment diagnostics

**Test Environment** (Paperclip UI) is the fastest way to diagnose setup. It:

- validates the API key (catches `openrouter_missing_api_key` /
  `openrouter_auth_required`),
- confirms the configured `model` exists in the live OpenRouter catalog, and
- reports your **remaining credit balance** (via `getQuotaWindows()` →
  OpenRouter `/auth/key`).

Read it top to bottom: a key/auth failure points at the API key section above; a
catalog miss points at the `model` id; a successful run that still shows a low
or zero balance means you need to top up OpenRouter credits.

## See also

- [Configuration reference](./configuration.md)
- [Examples & recipes](./examples.md)
- [Cost & caching](./cost-and-caching.md)
