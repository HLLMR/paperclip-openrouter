import type { AdapterTool, ToolEnvironment, ToolResult } from "./types.js";

// Cap on response body returned to the model — large API payloads are
// truncated so they can't blow the context window.
const MAX_RESPONSE_BYTES = 64 * 1024;
// SECURITY: method allow-list. Anything outside this set is rejected before a
// request is ever made, so the model can't issue exotic/unsafe verbs.
const ALLOWED_METHODS = new Set(["GET", "POST", "PATCH", "PUT", "DELETE"]);

// Join base URL + path with exactly one slash between them, tolerating a
// trailing slash on the base and a missing leading slash on the path.
function joinUrl(base: string, pathSegment: string): string {
  const trimmedBase = base.replace(/\/$/, "");
  const trimmedPath = pathSegment.startsWith("/") ? pathSegment : `/${pathSegment}`;
  return `${trimmedBase}${trimmedPath}`;
}

// Shared HTTP helper behind both paperclip tools. Handles auth injection,
// method/path validation, the 30s timeout, and response truncation in one place
// so individual tools only build the path + body.
async function callPaperclipApi(
  env: ToolEnvironment,
  params: { method?: unknown; path?: unknown; body?: unknown },
): Promise<ToolResult> {
  // Defensive: the tools' enabled() gates already require creds, but re-check
  // here so a direct call can never fire an unauthenticated request.
  if (!env.paperclipApiUrl || !env.paperclipApiKey) {
    return {
      ok: false,
      content:
        "Paperclip API is not configured for this run (missing PAPERCLIP_API_URL or PAPERCLIP_API_KEY).",
      isError: true,
    };
  }
  // Normalize + enforce the method allow-list (default GET for missing input).
  const method = typeof params.method === "string" ? params.method.toUpperCase() : "GET";
  if (!ALLOWED_METHODS.has(method)) {
    return { ok: false, content: `unsupported method ${method}`, isError: true };
  }
  if (typeof params.path !== "string" || params.path.trim().length === 0) {
    return { ok: false, content: "path must be a non-empty string", isError: true };
  }
  const url = joinUrl(env.paperclipApiUrl, params.path.trim());
  // Inject the agent bearer token + run id on every call. Routing all requests
  // through here means credentials are never the model's responsibility and
  // can't be omitted or spoofed via the path/body args.
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.paperclipApiKey}`,
    "X-Paperclip-Run-Id": env.runId,
    Accept: "application/json",
  };
  // Serialize the optional body. A string is passed through as-is (caller may
  // pre-encode); anything else is JSON-stringified. A non-serializable body
  // (e.g. circular) is reported rather than thrown.
  let bodyJson: string | undefined;
  if (params.body !== undefined && params.body !== null) {
    headers["Content-Type"] = "application/json";
    try {
      bodyJson = typeof params.body === "string" ? params.body : JSON.stringify(params.body);
    } catch (err) {
      return {
        ok: false,
        content: `body is not JSON-serializable: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }
  // Hard 30s timeout via AbortController so a hung upstream can't stall the run.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: bodyJson, signal: controller.signal });
  } catch (err) {
    // Network failure / abort lands here; clear the timer before returning.
    clearTimeout(timer);
    return { ok: false, content: err instanceof Error ? err.message : String(err), isError: true };
  }
  clearTimeout(timer);
  const text = await res.text();
  // Truncate oversized bodies to the byte cap and annotate the cut.
  const truncated = text.length > MAX_RESPONSE_BYTES;
  const responseBody = truncated
    ? text.slice(0, MAX_RESPONSE_BYTES) + `\n[truncated at ${MAX_RESPONSE_BYTES} bytes]`
    : text;
  // Surface the status line + body. ok/isError mirror the HTTP success so the
  // model sees non-2xx as a tool error without us parsing the payload.
  return {
    ok: res.ok,
    content: `HTTP ${res.status} ${res.statusText}\n${responseBody}`,
    isError: !res.ok,
  };
}

export const paperclipApiRequestTool: AdapterTool = {
  name: "paperclip_api_request",
  description:
    "Make an authenticated request to the Paperclip API. Uses the agent's bearer token and X-Paperclip-Run-Id automatically. Common paths: GET /api/agents/me, POST /api/issues/{id}/checkout, PATCH /api/issues/{id}, POST /api/issues/{id}/comments.",
  parameters: {
    type: "object",
    properties: {
      method: { type: "string", enum: ["GET", "POST", "PATCH", "PUT", "DELETE"], description: "HTTP method." },
      path: { type: "string", description: "Path under PAPERCLIP_API_URL, e.g. /api/agents/me. Must start with /." },
      body: { description: "Optional JSON-serializable body. Sent for POST/PATCH/PUT." },
    },
    required: ["method", "path"],
    additionalProperties: false,
  },
  // Advertised only when API creds exist for the run.
  enabled: (env) => Boolean(env.paperclipApiUrl && env.paperclipApiKey),
  // Thin wrapper: the model supplies method/path/body, the helper does the rest.
  invoke: (input, env) => callPaperclipApi(env, input ?? {}),
};

export const paperclipSearchIssuesTool: AdapterTool = {
  name: "paperclip_search_issues",
  description:
    "Search Paperclip issues by free text, optionally filtering by status, project, or assignee.",
  parameters: {
    type: "object",
    properties: {
      q: { type: "string", description: "Free-text search across titles, identifiers, descriptions, comments." },
      status: { type: "string", description: "Optional status filter, e.g. 'in_progress' or 'todo,in_progress'." },
      projectId: { type: "string", description: "Optional project id filter." },
      assigneeAgentId: { type: "string", description: "Optional assignee agent id filter." },
    },
    required: ["q"],
    additionalProperties: false,
  },
  // Needs creds AND a company id, since search is scoped to the agent's company.
  enabled: (env) => Boolean(env.paperclipApiUrl && env.paperclipApiKey && env.agent.companyId),
  invoke: async (input, env) => {
    const params = input ?? {};
    if (typeof params.q !== "string" || params.q.trim().length === 0) {
      return { ok: false, content: "q must be a non-empty string", isError: true };
    }
    // Build the query string; URLSearchParams handles encoding. Optional
    // filters are only added when present and non-blank.
    const search = new URLSearchParams();
    search.set("q", params.q.trim());
    if (typeof params.status === "string" && params.status.trim().length > 0) {
      search.set("status", params.status.trim());
    }
    if (typeof params.projectId === "string" && params.projectId.trim().length > 0) {
      search.set("projectId", params.projectId.trim());
    }
    if (typeof params.assigneeAgentId === "string" && params.assigneeAgentId.trim().length > 0) {
      search.set("assigneeAgentId", params.assigneeAgentId.trim());
    }
    // Scope is fixed to the run's company id (from env, not model input), so the
    // model can't search outside its own company regardless of the filters.
    return callPaperclipApi(env, {
      method: "GET",
      path: `/api/companies/${env.agent.companyId}/issues?${search.toString()}`,
    });
  },
};
