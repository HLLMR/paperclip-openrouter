# Examples & recipes

Practical config recipes for the `paperclip-openrouter` adapter.
Drop these into the agent's adapter config in the Paperclip UI (or via the
Paperclip API). For the full field list, see the
[configuration reference](./configuration.md).

In every recipe the API key can come from `apiKey` or from the
`OPENROUTER_API_KEY` environment variable.

## 1. Cheapest setup — a free model

OpenRouter `:free` model variants cost $0 per run, which makes them ideal for
smoke-testing the adapter, low-stakes automation, or high-volume tasks where
quality is secondary.

```json
{
  "apiKey": "sk-or-v1-...",
  "model": "meta-llama/llama-3.1-8b-instruct:free",
  "maxToolTurns": 8
}
```

**When to use:** validating the adapter wiring, cheap background chores, or any
workload where a $0 model is good enough. (Prompt caching is irrelevant here —
`:free` models cost nothing, so caching only affects latency.)

## 2. A capable Claude coding agent with caching

Anthropic models get automatic prompt caching: the adapter sets
`cache_control` breakpoints on the stable system and conversation prefixes, so
the large unchanging portion of the prompt is cached across tool-loop turns and
resumed sessions. This is the strongest cost lever for input-heavy,
multi-turn coding runs.

```json
{
  "apiKey": "sk-or-v1-...",
  "model": "anthropic/claude-3.5-sonnet",
  "temperature": 0.2,
  "maxTokens": 8192,
  "maxToolTurns": 20,
  "systemPrompt": "You are a meticulous senior engineer. Make minimal, correct changes.",
  "instructionsFilePath": "/workspace/project/AGENT.md",
  "cwd": "/workspace/project",
  "tools": {
    "fs": { "allowOutsideCwd": false }
  }
}
```

**When to use:** real coding/agentic work where the agent reads a lot of stable
context (instructions, file dumps) and loops over many tool calls. Caching is
enabled automatically — see [cost & caching](./cost-and-caching.md) for the
economics. To turn it off, set `"disablePromptCaching": true`.

## 3. A reasoning model with `reasoningEffort`

For reasoning-capable models, `reasoningEffort` is forwarded to OpenRouter as
`reasoning.effort` (`low` | `medium` | `high`), trading latency and token spend
for deeper deliberation.

```json
{
  "apiKey": "sk-or-v1-...",
  "model": "openai/o4-mini",
  "reasoningEffort": "high",
  "maxTokens": 8192,
  "timeoutSec": 300
}
```

**When to use:** hard planning, debugging, or analysis tasks that benefit from
more deliberate reasoning. Raise `timeoutSec` since high-effort reasoning runs
take longer.

## 4. Enabling shell with an allow-list

Shell execution is opt-in. Enable it and constrain it to a set of command
prefixes so the agent can only run vetted commands. A command is allowed only
if it starts with one of the `allowList` prefixes.

```json
{
  "apiKey": "sk-or-v1-...",
  "model": "anthropic/claude-3.5-sonnet",
  "cwd": "/workspace/project",
  "tools": {
    "shell": {
      "enabled": true,
      "allowList": ["git ", "npm run ", "npm test", "ls", "cat "],
      "timeoutSec": 90
    },
    "fs": { "allowOutsideCwd": false }
  }
}
```

**When to use:** agents that need to run builds, tests, or git operations.
Keep the allow-list as tight as possible, and leave `tools.fs.allowOutsideCwd`
at `false` so filesystem tools stay within the workspace.

## 5. Pinning a provider with `providerSlug`

OpenRouter may route a model through several upstream providers. Set
`providerSlug` to pin routing to one specific upstream — useful for consistent
latency, pricing, data-handling, or caching behavior.

```json
{
  "apiKey": "sk-or-v1-...",
  "model": "anthropic/claude-3.5-sonnet",
  "providerSlug": "anthropic"
}
```

**When to use:** when you need predictable routing — for example to guarantee a
particular provider's caching behavior, pricing, or compliance posture rather
than letting OpenRouter pick.

## See also

- [Configuration reference](./configuration.md)
- [Cost & caching](./cost-and-caching.md)
- [Troubleshooting](./troubleshooting.md)
