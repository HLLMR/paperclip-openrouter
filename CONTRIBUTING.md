# Contributing to `paperclip-openrouter`

Thanks for taking the time to contribute. This is an external **adapter plugin for
[Paperclip](https://github.com/paperclipai/paperclip)** that lets Paperclip run any of
OpenRouter's 300+ models as an agent. It talks directly to the OpenRouter REST API
(`https://openrouter.ai/api/v1/chat/completions`) and runs an in-process, multi-turn tool
loop — there's no local CLI to install.

This guide covers everything you need to get a development environment running, make a
change, and open a pull request that's easy to review and merge.

## Table of contents

- [Prerequisites](#prerequisites)
- [Getting started](#getting-started)
- [Project layout](#project-layout)
- [Development workflow](#development-workflow)
- [How the test suite works](#how-the-test-suite-works)
- [Running the adapter against a local Paperclip instance](#running-the-adapter-against-a-local-paperclip-instance)
- [Coding conventions](#coding-conventions)
- [Commit messages](#commit-messages)
- [Pull request process](#pull-request-process)
- [Reporting bugs and requesting features](#reporting-bugs-and-requesting-features)
- [Security](#security)
- [License](#license)

## Prerequisites

- **Node.js >= 20.** The package is ESM-only and targets modern Node.
- **npm** (ships with Node). The repo is committed with an npm lockfile.
- An **OpenRouter API key** if you want to exercise the live model catalog, run the tool
  loop end to end, or use **Test Environment** against a real Paperclip instance. Unit
  tests do **not** require a key or network access.

## Getting started

```sh
git clone https://github.com/HLLMR/paperclip-openrouter.git
cd paperclip-openrouter
npm install
npm run typecheck   # fast type-only pass, no emit
npm test            # compiles + runs the node:test unit tests
npm run build       # emits dist/
```

If all four commands pass on a clean clone, your environment is ready.

## Project layout

```
src/
  index.ts              # adapter manifest + configuration schema (UI field list)
  ui-parser.ts          # tool-call-aware UI parser (./ui-parser export)
  server/
    index.ts            # createServerAdapter() — the external-adapter entrypoint
    execute.ts          # the multi-turn tool loop
    models.ts           # live OpenRouter /models catalog (cached)
    quota.ts            # remaining-credit reporting via getQuotaWindows()
    cache.ts            # small TTL cache used by the catalog
    parse.ts            # request/response parsing helpers
    test.ts             # Test Environment handler (key + model + balance check)
    tools/
      registry.ts       # tool registration
      paperclip.ts      # paperclip_api_request, paperclip_search_issues
      fs.ts             # fs_read_file, fs_write_file, fs_list_dir
      shell.ts          # shell_exec (opt-in)
      types.ts          # shared tool types
    *.test.ts           # node:test unit tests, colocated with the code they cover
```

The public entrypoints are the three `exports` in `package.json`: `.` (the manifest),
`./server` (`createServerAdapter()`), and `./ui-parser`. Keep these contracts stable; a
change to any of them is a breaking change and should be called out in the PR.

## Development workflow

The npm scripts are the source of truth — please don't bypass them.

| Script | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` — strict type check, no output. Run this constantly. |
| `npm test` | `tsc` (full compile to `dist/`) then `node --test` over the compiled tests. |
| `npm run build` | `tsc -p tsconfig.build.json` — production emit to `dist/`. |
| `npm run clean` | removes `dist/`. |

A typical loop while working on a change:

```sh
npm run typecheck   # tighten types as you go
npm test            # confirm behavior
```

Before opening a PR, run `npm test` and `npm run typecheck` from a clean tree and make
sure both are green.

## How the test suite works

Tests are written with the built-in **`node:test`** runner and `node:assert` — there's no
third-party test framework or runner to learn.

- Test files are colocated with the code they cover and named `*.test.ts` (e.g.
  `src/server/parse.test.ts`).
- `npm test` first runs `tsc`, compiling the whole `src/` tree (tests included) into
  `dist/`, then runs `node --test --test-reporter=spec dist`. **The runner
  executes the compiled JavaScript in `dist/`, not the TypeScript sources** — so if a test
  doesn't seem to pick up your change, make sure the compile step ran.
- Because tests run after a real `tsc` pass, a type error will fail `npm test` before any
  test executes. That's intentional: a green `npm test` means the project both type-checks
  and behaves.

When adding a feature or fixing a bug, add or update a `*.test.ts` next to the code. Keep
unit tests hermetic — no network, no live OpenRouter calls, no real filesystem writes
outside a temp dir. Stub HTTP at the boundary so the suite stays fast and deterministic.

## Running the adapter against a local Paperclip instance

You can install your local build into a running Paperclip instance and iterate against it.

1. Build the adapter:

   ```sh
   npm run build
   ```

2. Point Paperclip at the built directory (use the local-path install so Paperclip loads
   `dist/` from disk rather than fetching from npm):

   ```sh
   curl -X POST "$PAPERCLIP_API_URL/api/adapters/install" \
     -H "Authorization: Bearer <instance-admin-token>" \
     -H "Content-Type: application/json" \
     -d '{"packageName": "'"$PWD"'", "isLocalPath": true}'
   ```

3. In the Paperclip UI, hire an agent with **Adapter: OpenRouter**, pick any OpenRouter
   `provider/model` id, and supply an API key (`apiKey` in the agent config, or
   `OPENROUTER_API_KEY` in the adapter env / Paperclip host environment).

4. Use **Test Environment** to validate the key, confirm the model exists in the live
   catalog, and read your remaining credit balance. This is the fastest end-to-end smoke
   test of a change.

5. After each change, re-run `npm run build` and re-install. (Restart or re-install the
   adapter so Paperclip reloads the new `dist/`.)

For pure logic changes you usually don't need a live instance — the `node:test` suite plus
`npm run typecheck` cover most cases.

## Coding conventions

- **TypeScript, strict.** `tsconfig.json` enables `strict` and `noUncheckedIndexedAccess`.
  Don't loosen compiler options to make code compile; fix the types. Avoid `any` — prefer
  precise types, `unknown` at boundaries, and narrowing.
- **ESM only.** The package is `"type": "module"` and uses `verbatimModuleSyntax`. Use
  `import`/`export`, include file extensions in relative imports where required by
  `Node16` resolution, and use `import type` for type-only imports.
- **Keep the public contracts stable.** Changes to the `.`, `./server`, or `./ui-parser`
  exports are breaking — flag them.
- **Match the surrounding style.** Small, focused modules; colocated tests; no dead code.
- **No secrets in logs.** The adapter handles an OpenRouter API key. Never log it in
  plaintext — follow the existing redacted-env logging pattern. See
  [`SECURITY.md`](SECURITY.md).
- **Run `npm run typecheck` and `npm test`** before pushing.

## Commit messages

This repo uses **[Conventional Commits](https://www.conventionalcommits.org/)**. Format:

```
<type>(<optional scope>): <short summary>
```

Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `perf`, `build`, `ci`.

Examples:

```
feat(tools): add allow-list matching to shell_exec
fix(models): cache miss when catalog returns empty data
docs: clarify local-path install in CONTRIBUTING
test(parse): cover tool-call streaming edge case
```

Mark breaking changes with `!` after the type/scope (e.g. `feat(server)!: ...`) and a
`BREAKING CHANGE:` footer describing the migration.

## Pull request process

1. Fork and create a topic branch off `main` (e.g. `feat/shell-allow-list`).
2. Make your change with accompanying tests and doc updates.
3. Ensure the full local gate passes:

   ```sh
   npm run typecheck
   npm test
   ```

4. Use a **Conventional Commit** title for the PR and fill out the pull request template.
5. Link the issue your PR addresses (`Closes #123`).
6. Keep PRs focused and reasonably small — they're faster to review and safer to merge.

Maintainers may ask for changes; pushing follow-up commits to the same branch updates the
PR automatically. Squash-and-merge is the default, so the PR title becomes the commit on
`main` — make it a good Conventional Commit.

## Reporting bugs and requesting features

Please use the GitHub issue forms:

- **Bug report** — include the model id, redacted adapter config, Paperclip and adapter
  versions, logs, and environment.
- **Feature request** — describe the problem first, then the proposed solution.

Open issues at <https://github.com/HLLMR/paperclip-openrouter/issues>.

## Security

Do **not** open public issues for security problems. See [`SECURITY.md`](SECURITY.md) for
private reporting via GitHub security advisories and the adapter's security model.

## License

By contributing, you agree that your contributions are licensed under the project's
[MIT License](LICENSE).
