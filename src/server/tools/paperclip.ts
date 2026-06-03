import type { AdapterTool, ToolEnvironment, ToolResult } from "./types.js";

const MAX_RESPONSE_BYTES = 64 * 1024;
const ALLOWED_METHODS = new Set(["GET", "POST", "PATCH", "PUT", "DELETE"]);

function joinUrl(base: string, pathSegment: string): string {
  const trimmedBase = base.replace(/\/$/, "");
  const trimmedPath = pathSegment.startsWith("/") ? pathSegment : `/${pathSegment}`;
  return `${trimmedBase}${trimmedPath}`;
}

async function callPaperclipApi(
  env: ToolEnvironment,
  params: { method?: unknown; path?: unknown; body?: unknown },
): Promise<ToolResult> {
  if (!env.paperclipApiUrl || !env.paperclipApiKey) {
    return {
      ok: false,
      content:
        "Paperclip API is not configured for this run (missing PAPERCLIP_API_URL or PAPERCLIP_API_KEY).",
      isError: true,
    };
  }
  const method = typeof params.method === "string" ? params.method.toUpperCase() : "GET";
  if (!ALLOWED_METHODS.has(method)) {
    return { ok: false, content: `unsupported method ${method}`, isError: true };
  }
  if (typeof params.path !== "string" || params.path.trim().length === 0) {
    return { ok: false, content: "path must be a non-empty string", isError: true };
  }
  const url = joinUrl(env.paperclipApiUrl, params.path.trim());
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.paperclipApiKey}`,
    "X-Paperclip-Run-Id": env.runId,
    Accept: "application/json",
  };
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: bodyJson, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, content: err instanceof Error ? err.message : String(err), isError: true };
  }
  clearTimeout(timer);
  const text = await res.text();
  const truncated = text.length > MAX_RESPONSE_BYTES;
  const responseBody = truncated
    ? text.slice(0, MAX_RESPONSE_BYTES) + `\n[truncated at ${MAX_RESPONSE_BYTES} bytes]`
    : text;
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
  enabled: (env) => Boolean(env.paperclipApiUrl && env.paperclipApiKey),
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
  enabled: (env) => Boolean(env.paperclipApiUrl && env.paperclipApiKey && env.agent.companyId),
  invoke: async (input, env) => {
    const params = input ?? {};
    if (typeof params.q !== "string" || params.q.trim().length === 0) {
      return { ok: false, content: "q must be a non-empty string", isError: true };
    }
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
    return callPaperclipApi(env, {
      method: "GET",
      path: `/api/companies/${env.agent.companyId}/issues?${search.toString()}`,
    });
  },
};
