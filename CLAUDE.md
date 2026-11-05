# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Full-text search over Claude Code session transcripts. `sync` reads `~/.claude/projects/**/*.jsonl` (never writes to
them) into a SQLite FTS5 index; `search`, `sessions` and `show` query it. The repository is also a Claude Code plugin
marketplace whose `session-archive` skill runs the CLI through `bunx github:sters/cc-session-archive`.

## Commands

```bash
mise install                         # Bun version from .tool-versions
bun install
bun check                            # type check
bun lint                             # canary builds only
bun fmt                              # canary builds only
bun test
bin/cc-session-archive.ts --help
```

## Architecture

- `bin/cc-session-archive.ts` — CLI: argument parsing and output formatting only.
- `src/sync.ts` — reads each transcript from `sessions.imported_bytes` up to the last complete line. A file that got
  shorter is re-imported from the start. Keeps user text, assistant text and tool calls (input truncated); drops tool
  results, thinking and `isMeta` lines. Transcript lines are untrusted input: every field is type-checked before use.
- `src/db.ts` — schema. `messages_fts` is an external-content FTS5 table with the trigram tokenizer, kept in sync by
  triggers, so Japanese matches by substring.
- `src/query.ts` — search with `LIKE` on the FTS table (served by the trigram index for terms of three or more
  characters), session listing, and session detail.
- `src/web/` — `web` command. `server.ts` serves JSON from `query.ts` and `index.html` as a Bun HTML import, which
  bundles `app.tsx` at runtime. `app.tsx` builds DOM nodes with its own `h()` through the `@jsx` pragma, so there is
  no React or other client dependency.
- `skills/session-archive/SKILL.md` and `.claude-plugin/` — the plugin. tagpr bumps the version in both
  `package.json` and `.claude-plugin/plugin.json`.

## Conventions

- **Keep the tool generic.** This is a public, general-purpose repository: nothing in it may depend on or point to a
  specific company, business, product or codebase. That covers code, test fixtures, comments, docs, the skill and
  commit messages, and it includes org and repo names, identifiers and file paths, ticket keys, internal tool or
  stack descriptions, and business-domain vocabulary. An example taken from a real session is rewritten into a
  neutral one (`acme/widgets`, `my-app`, users / orders, `PROJ-123`) before it lands; swapping only the org name is
  not enough. The repository's own address (`sters/cc-session-archive`) and its author are the exception.
- **Never commit anything read from real transcripts or the database.** Fixtures are written by hand.
- **`bun.lock` must not carry a registry URL.** A mirror configured in `~/.npmrc` gets recorded as each package's
  tarball URL and CI cannot reach it. After `bun install`, clear them:
  `sed -i '' -E 's#"https://registry\.[^"]*/-/[^"]*\.tgz"#""#' bun.lock`.
- Runtime dependencies stay at zero; use Bun built-ins (`bun:sqlite`, `Bun.file`, `Bun.Glob`) and `node:` modules.
