# Cost & caching

How the `paperclip-openrouter` adapter reports cost and credits,
and how its automatic prompt caching works. See the
[configuration reference](./configuration.md) for the fields mentioned here.

## How cost, usage, and credits are reported

- **Per-run usage and cost** come from OpenRouter's response `usage` field. The
  adapter requests it with `usage: { include: true }`, so each completion comes
  back with token counts and the dollar cost OpenRouter charged for that call.
- **Billing type** reported to Paperclip is **`credits`**. OpenRouter is
  prepaid — you buy credits up front and each run draws them down.
- **Remaining credit balance** is surfaced through the adapter's
  `getQuotaWindows()`, which queries OpenRouter's `/auth/key` endpoint. This is
  what populates the remaining-balance view for the agent.
- **Cached-read tokens** are reported back as `cachedInputTokens` (see below).

You can confirm the key, model, and remaining balance at any time with the
**Test Environment** action in the Paperclip UI.

## Prompt caching

OpenRouter can cache the large, stable prefix of a prompt so you don't pay full
input price for it on every turn. The adapter manages this automatically based
on the model's provider.

### What it does

For each run the prompt has a big stable portion (system prompt, instructions,
accumulated conversation) followed by the small changing portion (the latest
tool result or user turn). The adapter marks the stable portion so the provider
can cache it and cheaply re-read it on the next turn instead of reprocessing it
from scratch.

### Which providers

| Provider family | Caching behavior |
|---|---|
| Anthropic | Adapter sets explicit `cache_control: {type:"ephemeral"}` breakpoints. |
| Gemini | Adapter sets explicit `cache_control: {type:"ephemeral"}` breakpoints. |
| OpenAI, Grok, DeepSeek | Cache **implicitly**; messages are left as plain strings (no `cache_control`). |

For Anthropic and Gemini the adapter places **two** breakpoints:

1. the **system prefix**, and
2. the **conversation prefix**,

so the large stable head of the prompt is cached across the tool-loop turns and
across resumed sessions.

Providers that cache implicitly (OpenAI, Grok, DeepSeek) need no `cache_control`
and are sent as plain strings — the adapter does not try to add breakpoints
there.

### Cache economics (Anthropic)

Caching is not free on the write, but the read is cheap:

| Operation | Cost vs. base input price |
|---|---|
| Cache **write** (first time the prefix is cached) | ≈ **1.25×** base input price |
| Cache **read** (cached prefix re-used) | ≈ **0.1×** base input price (~90% off) |

So you pay a small premium once to write the cache, then ~90% off for every
subsequent turn that re-reads it. The ephemeral cache **TTL is ~5 minutes**.

### Reading `cachedInputTokens`

When a turn re-reads cached input, those tokens are reported back as
`cachedInputTokens` in the usage data. A non-zero `cachedInputTokens` on later
turns of a run means the cache is being hit; if it stays at zero across a
multi-turn Anthropic/Gemini run, the cache is not being re-used (see the TTL
caveat below).

### When it helps most

Caching pays off for **input-heavy, multi-turn** runs:

- A large, stable system prompt / instructions file.
- Tight tool loops where turns happen seconds apart — these hit the cache
  strongly and read it many times before it expires.

It helps least when:

- **Wake cadence is slow.** Heartbeats spaced more than ~5 minutes apart let the
  ephemeral cache expire, so you pay an occasional write with no read benefit.
- **The prompt is small** or changes every turn — little stable prefix to cache.
- **The model is `:free`.** Free models cost $0, so caching only affects
  latency, not cost.

Be honest with yourself about the numbers: exact savings depend on prompt size,
turn count, wake cadence, and the model's pricing.

### How to disable it

Set `disablePromptCaching: true` in the agent config to stop the adapter from
adding `cache_control` breakpoints (Anthropic/Gemini). Implicit caching by
OpenAI/Grok/DeepSeek is a provider behavior and is unaffected by this flag.

```json
{
  "model": "anthropic/claude-3.5-sonnet",
  "disablePromptCaching": true
}
```

### Worked example (illustration only)

> The numbers below are a made-up illustration to show how the multipliers
> combine — they are **not** a quote. Use your model's real OpenRouter pricing
> and your actual token counts.

Suppose an Anthropic run with a **20,000-token stable prefix** (system +
instructions + early conversation) and a tool loop of **6 turns** seconds apart,
all within the ~5-minute TTL. Let the base input price be **1 unit / token**.

**Without caching** — the prefix is reprocessed at full price each turn:

```
6 turns × 20,000 tokens × 1.0  = 120,000 units
```

**With caching** — write once, then read at ~0.1× for the rest:

```
turn 1 (write): 20,000 × 1.25 =  25,000 units
turns 2-6 (read): 5 × 20,000 × 0.1 = 10,000 units
total                              =  35,000 units
```

That is roughly a **70% reduction** on the stable-prefix portion of input for
this illustration. Real runs differ: the changing per-turn input and the output
tokens are billed normally either way, and if turns drift past ~5 minutes apart
the cache expires and you re-pay the write. Treat this as a directional example,
not a guarantee.

## See also

- [Configuration reference](./configuration.md)
- [Examples & recipes](./examples.md)
- [Troubleshooting](./troubleshooting.md)
