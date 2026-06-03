# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-06-03

### Fixed

- Advertise instructions-bundle support (`supportsInstructionsBundle: true` +
  `instructionsPathKey: "instructionsFilePath"`) so Paperclip injects the
  agent's instructions bundle (its AGENTS.md persona) into the run. `execute()`
  already consumed `instructionsFilePath`; without the flags Paperclip never
  populated it, so agents ran without their persona.

## [0.1.0] - 2026-06-03

Initial release.

### Added

- OpenRouter external adapter for Paperclip (`type: openrouter`) — runs any
  OpenRouter model as an agent via an in-process, multi-turn tool loop against
  `https://openrouter.ai/api/v1`. No local CLI required.
- Live model catalog from OpenRouter's `/models` endpoint (cached 5 minutes),
  with a seed fallback list.
- Per-run cost and token usage reported from OpenRouter's `usage.include`
  field; billing type reported as `credits`.
- Remaining credit-balance reporting via `getQuotaWindows()` (OpenRouter
  `/auth/key`).
- Anthropic / Gemini prompt caching: automatic `cache_control` breakpoints on
  the system prefix and conversation prefix; configurable via
  `disablePromptCaching`.
- Tool harness: `paperclip_api_request`, `paperclip_search_issues`,
  `fs_read_file`, `fs_write_file`, `fs_list_dir`, and opt-in `shell_exec`
  (allow-list supported).
- Session persistence across heartbeats (`sessionCodec` + `sessionManagement`).
- Reasoning-effort support (`reasoningEffort`: low/medium/high).
- Self-contained UI parser that renders tool calls and results in the run
  transcript.
- Environment diagnostics (`testEnvironment`): key validation, live model-catalog
  check, credit balance, and a hello probe.

[Unreleased]: https://github.com/HLLMR/paperclip-openrouter/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/HLLMR/paperclip-openrouter/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/HLLMR/paperclip-openrouter/releases/tag/v0.1.0
