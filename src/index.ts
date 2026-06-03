/**
 * @envora/paperclip-adapter-openrouter
 *
 * Shared adapter metadata (type, label, default models, configuration doc).
 * The server module (./server) provides createServerAdapter(); the UI parser
 * lives in ./ui-parser. This file is the package entry point and must export
 * `createServerAdapter` per the Paperclip external-adapter contract.
 */
import type { AdapterModel } from "@paperclipai/adapter-utils";

export const type = "openrouter";
export const label = "OpenRouter";

export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
/**
 * A cheap, broadly-available, tool-capable default. Operators can pick any
 * OpenRouter model id per agent; `listModels` exposes the full live catalog.
 */
export const DEFAULT_MODEL = "openai/gpt-4o-mini";
export const DEFAULT_TIMEOUT_SEC = 180;
export const DEFAULT_MAX_TOOL_TURNS = 12;
export const DEFAULT_SESSION_MESSAGE_CAP = 40;

/**
 * Seed catalog shown before the live `/models` fetch resolves (and as a
 * fallback when OpenRouter is unreachable). Intentionally small and
 * provider-diverse — `listModels()` replaces this with the full live list.
 */
export const models: AdapterModel[] = [
  { id: "openai/gpt-4o", label: "OpenAI GPT-4o" },
  { id: "openai/gpt-4o-mini", label: "OpenAI GPT-4o mini" },
  { id: "anthropic/claude-3.5-sonnet", label: "Anthropic Claude 3.5 Sonnet" },
  { id: "anthropic/claude-3.5-haiku", label: "Anthropic Claude 3.5 Haiku" },
  { id: "google/gemini-2.0-flash-001", label: "Google Gemini 2.0 Flash" },
  { id: "meta-llama/llama-3.3-70b-instruct", label: "Meta Llama 3.3 70B Instruct" },
  { id: "qwen/qwen-2.5-coder-32b-instruct", label: "Qwen 2.5 Coder 32B Instruct" },
  { id: "deepseek/deepseek-chat", label: "DeepSeek Chat" },
  { id: "mistralai/mistral-large", label: "Mistral Large" },
  { id: "meta-llama/llama-3.3-70b-instruct:free", label: "Meta Llama 3.3 70B (free)" },
];

export const agentConfigurationDoc = `# openrouter agent configuration

Adapter: openrouter
Registration: external plugin (loaded via the adapter plugin system, not hardcoded)

Use when:
- You want to run any OpenRouter model as a Paperclip agent without installing a local CLI
- You want a tool-loop agent that can call the Paperclip API and read/write files in its workspace
- You are happy to provide an OpenRouter API key per agent or via OPENROUTER_API_KEY

Don't use when:
- You need a CLI subprocess (use claude_local, codex_local, opencode_local, etc.)
- You need streaming/SSE responses surfaced token-by-token in the UI

Core fields:
- apiKey (string, optional): OpenRouter API key. If unset, OPENROUTER_API_KEY (adapter env or host env) is used.
- apiBaseUrl (string, optional): OpenRouter base URL; defaults to ${DEFAULT_OPENROUTER_BASE_URL}
- model (string, optional): OpenRouter model id (provider/model); defaults to ${DEFAULT_MODEL}
- temperature (number, optional): sampling temperature (0–2); omitted when blank
- topP (number, optional): nucleus sampling; omitted when blank
- maxTokens (number, optional): cap on completion tokens
- reasoningEffort (string, optional): "low" | "medium" | "high" — forwarded as OpenRouter \`reasoning.effort\` for models that support it
- systemPrompt (string, optional): extra system instruction prepended to every run
- providerSlug (string, optional): pin OpenRouter routing to a single upstream provider slug
- siteUrl (string, optional): forwarded as HTTP-Referer for OpenRouter app attribution
- siteTitle (string, optional): forwarded as X-Title for OpenRouter app attribution (default "Paperclip")

Prompt assembly fields:
- cwd (string, optional): working directory used for resolving instructionsFilePath and fs_* tools
- instructionsFilePath (string, optional): markdown file prepended to the prompt at runtime
- promptTemplate (string, optional): heartbeat prompt template
- bootstrapPromptTemplate (string, optional): only sent on the first run for a new session

Operational fields:
- timeoutSec (number, optional): HTTP request timeout per OpenRouter call; defaults to ${DEFAULT_TIMEOUT_SEC}
- env (object, optional): KEY=VALUE entries; OPENROUTER_API_KEY here also satisfies authentication
- maxToolTurns (number, optional): cap on the tool-call/response loop per heartbeat; defaults to ${DEFAULT_MAX_TOOL_TURNS}
- sessionMessageCap (number, optional): max conversation messages persisted across heartbeats; defaults to ${DEFAULT_SESSION_MESSAGE_CAP}

Tool harness:
- This adapter runs an in-process tool loop. By default these tools are exposed to the model:
  - paperclip_api_request — authenticated HTTP requests to the Paperclip API (GET/POST/PATCH/PUT/DELETE)
  - paperclip_search_issues — search issues by free text, optionally scoped by status/project/assignee
  - fs_read_file, fs_write_file, fs_list_dir — filesystem access scoped to the adapter cwd
  - shell_exec — bash command execution (opt-in, off by default)
- Configure tools via the \`tools\` config object:
  - tools.shell.enabled (boolean): default false. Enable to expose shell_exec.
  - tools.shell.allowList (string[]): optional command-prefix allow list (e.g. ["git status", "ls"]).
  - tools.shell.timeoutSec (number): per-command timeout, default 60s.
  - tools.fs.allowOutsideCwd (boolean): default false. When true, fs_* tools accept absolute paths outside cwd.
  - tools.fs.maxBytes (number): max bytes per fs read/write, default 262144 (256 KiB).

Notes:
- Conversation messages persist across heartbeats so multi-turn flows survive between wakes (capped by sessionMessageCap; subject to Paperclip's session compactor).
- Usage and cost are reported back to Paperclip from OpenRouter's \`usage.include\` response field, summed across turns. Billing type is "credits" (OpenRouter is prepaid).
- Remaining OpenRouter credit balance is surfaced to Paperclip via the adapter quota window (getQuotaWindows).
- Tool calls and results are rendered in the run transcript via the bundled UI parser.
`;

export { createServerAdapter } from "./server/index.js";
