# Security Policy

`paperclip-openrouter` is an external adapter plugin for
[Paperclip](https://github.com/paperclipai/paperclip) that runs any of
OpenRouter's 300+ models as an agent via an in-process multi-turn tool loop
against the OpenRouter REST API. Because the adapter handles credentials and can
expose filesystem and shell tools to a model, we take security reports
seriously.

## Supported Versions

Security fixes are provided for the latest released minor on the current major.
Older majors receive critical fixes on a best-effort basis only.

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through GitHub Security Advisories:

➡️ https://github.com/HLLMR/paperclip-openrouter/security/advisories/new

When reporting, please include where practical:

- A description of the vulnerability and its impact.
- Steps to reproduce or a proof of concept.
- Affected version(s) of the adapter, Paperclip, and Node.js.
- Any relevant configuration (with secrets redacted).

### Response window

- **Acknowledgement:** within 3 business days of your report.
- **Triage and severity assessment:** within 7 business days.
- **Fix or mitigation plan:** communicated as soon as triage completes; timelines
  depend on severity and complexity.

We will keep you informed of progress and coordinate a disclosure date with you.

### Responsible disclosure

- Give us a reasonable opportunity to investigate and ship a fix before any
  public disclosure.
- Do not access, modify, or exfiltrate data that is not yours, and do not
  degrade service for other users while testing.
- Act in good faith and avoid privacy violations or destruction of data.

We are happy to credit reporters in the advisory unless you prefer to remain
anonymous.

## Security Model

Understanding the adapter's trust boundaries will help you assess and report
issues accurately.

### API key handling

- The OpenRouter API key is read from the `OPENROUTER_API_KEY` environment
  variable or from the adapter's `apiKey` configuration value.
- The key is used only to authenticate requests to
  `https://openrouter.ai/api/v1`.
- The key is **redacted in logs**. Avoid pasting raw keys into issues, logs, or
  configuration snippets you share.

### `shell_exec` tool

- The `shell_exec` bash tool is **opt-in and disabled by default**.
- When enabled, it supports a **command allow-list** so operators can restrict
  which commands the model may invoke.
- Enabling unrestricted shell execution grants the model the ability to run
  arbitrary commands in the adapter's environment; do so only in trusted,
  sandboxed contexts.

### Filesystem tools

- The workspace-scoped filesystem read/write/list tools are **restricted to the
  configured working directory (`cwd`)** by default.
- Access outside `cwd` is only possible when `tools.fs.allowOutsideCwd` is
  explicitly set. Treat that flag as a privilege escalation and enable it only
  when necessary.

### Untrusted model output

- **Treat all model output as untrusted.** A model may attempt prompt injection,
  request out-of-scope tool calls, or emit malicious content (e.g., paths,
  commands, or data intended to escape its sandbox).
- Tool inputs produced by the model are validated and constrained by the
  boundaries above, but operators should still review enabled tools, allow-lists,
  and filesystem scope before deploying to sensitive environments.

If you believe any of these boundaries can be bypassed, please report it via the
private advisory link above.
