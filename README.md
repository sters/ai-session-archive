# ai-session-archive

Full-text search over your Claude Code session transcripts, and a calendar of the time you spent in them.

Claude Code already writes every session to `~/.claude/projects/<project>/<session>.jsonl`. This tool reads those
files (never writes to them) and keeps a SQLite index of what was said: user messages, assistant text, and tool calls
with their input. Tool results and thinking are left out, which keeps search hits readable. Next to the text it keeps
each line's metadata (timestamps, models, token usage, cost, turn durations, edited files, PR links), which the
calendar is drawn from.

Needs only [Bun](https://bun.sh). The index uses SQLite FTS5 with the trigram tokenizer, so Japanese matches by
substring without word segmentation.

## Usage

```bash
bunx github:sters/ai-session-archive sync        # import new lines (incremental)
bunx github:sters/ai-session-archive search 注文履歴 OrderItems --since 2026-10-01
bunx github:sters/ai-session-archive sessions --project my-app
bunx github:sters/ai-session-archive show <session-id>
bunx github:sters/ai-session-archive web         # search and read sessions at http://localhost:7357
```

`web` also runs `sync` every minute while it is up, so the pages include sessions that are still running.

`search` returns messages containing every term, newest first. Terms of one or two characters still match, but are
not served by the trigram index and scan the whole table.

| Option                 | Meaning                                                                       |
| ---------------------- | ----------------------------------------------------------------------------- |
| `--project <text>`     | Only sessions whose cwd contains `<text>`                                     |
| `--since <YYYY-MM-DD>` | Only messages (`search`) or sessions (`sessions`) at or after this local date |
| `--limit <n>`          | Maximum rows (default: `search` 30, `sessions` 50)                            |
| `--port <n>`           | Port for `web` (default: 7357). It listens on 127.0.0.1 only                  |
| `--gap <minutes>`      | Idle time that splits a session into calendar events (default: 30)            |

| Environment             | Default                                                 |
| ----------------------- | ------------------------------------------------------- |
| `AI_SESSION_ARCHIVE_DB` | `~/.local/share/ai-session-archive/archive.sqlite`      |
| `CLAUDE_CONFIG_DIR`     | `~/.claude` (transcripts are read from its `projects/`) |

`sync` reads each transcript from where it stopped last time, up to the last complete line, so it is cheap to run
often and safe while a session is still writing. A transcript that got shorter is re-imported from the start.

## Keeping the index current

Run `sync` when a session ends, from `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bunx github:sters/ai-session-archive sync >/dev/null 2>&1"
          }
        ]
      }
    ]
  }
}
```

A database written by an older version is upgraded by the next `sync`: sessions whose transcript still exists are
imported again to pick up their metadata. Sessions whose transcript is already gone keep only their messages and are
shown on the calendar with estimated times and no cost.

Claude Code deletes transcripts older than `cleanupPeriodDays` (default 30). The index keeps what it already imported,
but only sessions synced before their transcript was deleted. Raise `cleanupPeriodDays` if you want the originals kept.

## Calendar

`http://localhost:7357/calendar` lays out the time spent working as a calendar.

- Each session is split into events (work blocks) wherever the gap between messages exceeds `--gap`. A session resumed
  the next day with `--resume` becomes one event per stretch of work.
- "Active spans" in the sidebar shows only the turns in which Claude was actually running. Turns that follow each
  other within 5 minutes are merged into one.
- An event's title is the `ai-title`, otherwise the first prompt, otherwise `last-prompt`. Its colour is determined by
  the session's `cwd`.
- Sessions whose `entrypoint` is `sdk-cli` (started programmatically through the SDK) are hidden by default. Toggle
  them with "Show SDK runs".
- Clicking an event shows the `claude --resume` command for that session and a link to its messages.

| Item                                     | Source                                                                                                                                                                                                                                              |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active time                              | `turn_duration` in `system` records (turn end time and duration). Without it (SDK runs, older versions), a turn is estimated as running from a prompt to the last message before the next prompt, and is marked "estimated"                         |
| Cost                                     | The session total is the `cost-state` value (API-price equivalent). It is split across blocks in proportion to token volume per model, weighted input 1, output 5, cache read 0.1, cache write 1.25, 1-hour cache write 2. The split is an estimate |
| Cost (sessions without `cost-state`)     | Such as sessions still running. Estimated as per-model unit price, derived from other sessions, × token volume, and marked "estimated"                                                                                                              |
| Changed lines                            | Line counts of the patches in Edit, Write and NotebookEdit results, counted the same way as Claude Code's `totalLinesAdded` / `totalLinesRemoved`                                                                                                   |
| PR                                       | `pr-link`                                                                                                                                                                                                                                           |
| Tools, models, skills, MCP, edited files | `tool_use`, `model`, `attributionSkill` and `attributionMcpServer` in assistant messages, and file paths in tool results                                                                                                                            |

- Subagents add their tokens, tools, edited files and changed lines to the parent session's block, not messages or
  blocks.
- The daily total and the sidebar's "Active" figure are the sum of time Claude was running. Sessions running in
  parallel are each counted, so a day can exceed 24 hours. Spans crossing midnight are counted per day. Cost, prompts,
  changed lines and PRs are counted on the day the block starts.
- The page refetches every 60 seconds. FullCalendar is loaded from jsDelivr.

## Letting Claude use it

This repository is a Claude Code plugin marketplace. Installing the plugin gives Claude the `session-archive` skill,
which runs the CLI through `bunx`:

```text
/plugin marketplace add sters/ai-session-archive
/plugin install ai-session-archive@ai-session-archive
```

The database holds whatever passed through your sessions, including command lines and anything pasted into them. Keep
it local.

## Development

```bash
mise install       # Bun version from .tool-versions
bun install
bun check          # type check
bun lint           # type-aware, configured in bunfig.toml (canary builds only)
bun fmt            # canary builds only
bun test
```
