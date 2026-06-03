# Configuration reference

This is the complete list of configuration fields for the
`paperclip-openrouter` adapter (adapter type id: `openrouter`).
These are the **only** valid fields — anything else is ignored.

You set these in the agent's adapter config in the Paperclip UI (Org Chart →
Hire Agent / Edit Agent) or via the Paperclip API. Fields with a default are
optional; blank/unset values are omitted from the OpenRouter request entirely.

## Core

| Field | Type | Default | Description |
|---|---|---|---|
| `apiKey` | string | — (falls back to `OPENROUTER_API_KEY` env) | OpenRouter API key used to authenticate requests to the OpenRouter REST API. |
| `apiBaseUrl` | string | `https://openrouter.ai/api/v1` | Base URL for the OpenRouter API; override for a proxy or self-hosted gateway. |
| `model` | string | `openai/gpt-4o-mini` | OpenRouter `provider/model` id the agent runs as (e.g. `anthropic/claude-3.5-sonnet`). |
| `temperature` | number | unset | Sampling temperature; omitted from the request when blank. |
| `topP` | number | unset | Nucleus sampling probability mass; omitted when blank. |
| `maxTokens` | number | unset | Maximum tokens to generate per completion; omitted when blank. |
| `reasoningEffort` | `low` \| `medium` \| `high` | unset | Forwarded as OpenRouter `reasoning.effort` for reasoning-capable models. |
| `disablePromptCaching` | boolean | `false` | When `true`, disables automatic `cache_control` breakpoints (Anthropic/Gemini). |
| `systemPrompt` | string | unset | Custom system prompt; participates in prompt assembly (see below). |
| `providerSlug` | string | unset | Pins OpenRouter routing to a single upstream provider. |
| `siteUrl` | string | unset | Sent as the `HTTP-Referer` header to OpenRouter. |
| `siteTitle` | string | `Paperclip` | Sent as the `X-Title` header to OpenRouter. |

## Prompt assembly

These fields control how the system/user prompt is built before each run.

| Field | Type | Default | Description |
|---|---|---|---|
| `cwd` | string | unset | Working directory for the agent's workspace and filesystem tools. |
| `instructionsFilePath` | string | unset | Path to a Markdown file whose contents are prepended to the prompt. |
| `promptTemplate` | string | unset | Template used to assemble the prompt for each run. |
| `bootstrapPromptTemplate` | string | unset | Template used only on the agent's first run. |

## Operational

| Field | Type | Default | Description |
|---|---|---|---|
| `timeoutSec` | number | `180` | Per-request timeout in seconds before the call fails with `openrouter_timeout`. |
| `env` | map (KEY=VALUE) | unset | Environment variables for the run; `OPENROUTER_API_KEY` here also authenticates. |
| `maxToolTurns` | number | `12` | Maximum tool-call/response loop iterations per heartbeat. |
| `sessionMessageCap` | number | `40` | Maximum messages retained in a session before older ones are trimmed. |

## Tools

The `tools` object configures which tools the model may use and how they are
sandboxed. See the [tools exposed to the model](#tools-exposed-to-the-model)
list below for what each tool does.

| Field | Type | Default | Description |
|---|---|---|---|
| `tools.shell.enabled` | boolean | `false` | Enables the `shell_exec` tool (opt-in bash execution). |
| `tools.shell.allowList` | string[] | unset | Allowed command prefixes for `shell_exec`; commands not matching are rejected. |
| `tools.shell.timeoutSec` | number | `60` | Per-command timeout for `shell_exec` in seconds. |
| `tools.fs.allowOutsideCwd` | boolean | `false` | When `false`, filesystem tools are restricted to the workspace (`cwd`). |
| `tools.fs.maxBytes` | number | `262144` | Maximum bytes a single filesystem tool read/write may handle (256 KiB). |

### Tools exposed to the model

- `paperclip_api_request` — authenticated Paperclip API calls (auth + run-id injected automatically).
- `paperclip_search_issues` — issue search scoped to the agent's company.
- `fs_read_file`, `fs_write_file`, `fs_list_dir` — workspace-scoped filesystem access.
- `shell_exec` — bash execution (disabled by default; supports an allow-list via `tools.shell.allowList`).

## Examples

### Minimal

The smallest useful config. The API key may instead be supplied via the
`OPENROUTER_API_KEY` environment variable, in which case `apiKey` can be omitted.

```json
{
  "apiKey": "sk-or-v1-...",
  "model": "openai/gpt-4o-mini"
}
```

### Fully loaded

Every field set, for reference. You will rarely need all of these at once.

```json
{
  "apiKey": "sk-or-v1-...",
  "apiBaseUrl": "https://openrouter.ai/api/v1",
  "model": "anthropic/claude-3.5-sonnet",
  "temperature": 0.2,
  "topP": 0.95,
  "maxTokens": 4096,
  "reasoningEffort": "medium",
  "disablePromptCaching": false,
  "systemPrompt": "You are a meticulous senior engineer.",
  "providerSlug": "anthropic",
  "siteUrl": "https://example.com",
  "siteTitle": "Acme Ops",

  "cwd": "/workspace/project",
  "instructionsFilePath": "/workspace/project/AGENT.md",
  "promptTemplate": "{{instructions}}\n\n{{task}}",
  "bootstrapPromptTemplate": "First run: set up the workspace.\n\n{{task}}",

  "timeoutSec": 240,
  "env": {
    "OPENROUTER_API_KEY": "sk-or-v1-...",
    "PROJECT_ENV": "staging"
  },
  "maxToolTurns": 20,
  "sessionMessageCap": 60,

  "tools": {
    "shell": {
      "enabled": true,
      "allowList": ["git ", "npm ", "ls", "cat "],
      "timeoutSec": 90
    },
    "fs": {
      "allowOutsideCwd": false,
      "maxBytes": 524288
    }
  }
}
```

## See also

- [Examples & recipes](./examples.md)
- [Cost & caching](./cost-and-caching.md)
- [Troubleshooting](./troubleshooting.md)
