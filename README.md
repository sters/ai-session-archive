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
bunx github:sters/ai-session-archive summarize   # write day, week and month summaries with `claude -p`
bunx github:sters/ai-session-archive summaries --period week --since 2026-10-01
bunx github:sters/ai-session-archive web         # search and read sessions at http://localhost:7357
```

`web` only reads the database. Run `sync` (or the `SessionEnd` hook below) to bring new sessions in; the pages
pick them up without a restart.

`search` returns, in one list newest first, the messages of main sessions containing every term (subagent sessions
too with `--agents`) and the sections of stored summaries containing every term. A summary section is dated by the last
day of its period and shows only the lines holding a term, numbered as in the whole summary. Messages are limited by
`--limit` and to 3 per session, followed by how many more the session has; a prompt is shown from its start. Summary
sections are limited to 10; with `--project`, they are those under a heading naming the project.
Terms of one or two characters still match, but are not served by the trigram index and scan the whole table.

`sessions` lists the most recently active sessions first, with their time span and prompt count. `show` prints a
session, or a summary named `<period>/<start>`, with numbered lines; `--lines <from>-<to>` keeps part of it, `--project`
a project's sections of a summary, and `--role user,assistant,tool` (or `tool:<name>`) the messages of those roles
(`--limit <n>` for the first n), all keeping the line numbers. Under `--role`, a prompt repeated unchanged is shown
once, and a compaction summary as a line naming its range. `search` takes `--role` too. A session without a title is listed by its first prompt.

A user message holds what the user typed: a slash command is stored as `/name args` and a `!` shell command as
`! command`, and what Claude Code writes into user lines itself (task notifications, command output, messages from
other agents) is left out.

| Option                        | Meaning                                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `--project <path>`            | Only sessions that ran in `<path>` or below it at any point, matched as whole path segments (`acme/widgets`)      |
| `--since <YYYY-MM-DD>`        | Only messages (`search`), sessions (`sessions`) or periods (`summarize`, `summaries`) at or after this local date |
| `--limit <n>`                 | Maximum rows (default: `search` 30, `sessions` 50, `summaries` 10)                                                |
| `--period <day\|week\|month>` | Only summaries of this period (`summaries`)                                                                       |
| `--model <model>`             | Model for `summarize` (default: `haiku`)                                                                          |
| `--jobs <n>`                  | Summaries written at once by `summarize` (default: 4)                                                             |
| `--summarize`                 | Also run `summarize` after `sync` (`sync`)                                                                        |
| `--port <n>`                  | Port for `web` (default: 7357). It listens on 127.0.0.1 only                                                      |
| `--gap <minutes>`             | Idle time that splits a session into calendar events (default: 30)                                                |

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

## Summaries

`summarize` keeps a summary of each local day, week (Monday to Sunday) and month in the database, so that Claude can
recall past work through the skill without reading whole transcripts.

- A day is summarized from its sessions, under one heading per project, named `<owner>/<repo>` when the session's
  working directories show one: what was worked on and how it ended, decisions and their reasons, problems and their
  fixes, what was left open, identifiers worth searching for, and the session ids holding the details. The day's
  sessions are written to a temporary directory as an index and one file per session, and the model reads what it
  needs from them. Weeks and months are summarized from their day summaries, grouped the same way.
- Only periods that have ended are summarized. A period is summarized again when its input changes, for example when
  a session from that day is synced late; otherwise a run that finds nothing new makes no calls.
- Summaries are written by `claude -p` with hooks and MCP servers disabled and without saving the session, so it
  uses your Claude Code login and the runs do not appear in the archive. A day's run has only Read, Grep and Glob, in
  `dontAsk` permission mode, so it can read the files of that day and nothing outside their directory; weeks and
  months run with no tools. A day takes a minute or two. On the first run, limit the range with `--since` unless you
  want the whole history summarized.
- Up to `--jobs` summaries are written at once: days first, then weeks and months, which are built from the days. If
  one fails, no further summary is started, and the next run picks up from what was written.
- One `summarize` runs at a time. While one holds `<database>.summarize.lock`, another run, such as a second
  session ending at the same moment, skips summarizing and says so; `sync` itself still runs. A lock left by a
  process that is gone is taken over.
- Subagents are left out; the session that started one already records what it was asked and what it reported.
  Sessions started through the SDK are included, since they often hold the work itself.
- Next to each summary, `sync` stores the period's calendar figures in `period_stats`: sessions, prompts, active time,
  cost, PRs and changed lines, counted as in the calendar's "This period" panel. They are calculated, not written by
  the model, so they are kept for the current day, week and month too, and include sessions started through the SDK.
  Every `sync` recalculates them all, which takes a second or two.
- `http://localhost:7357/summaries` shows them, filtered by period, terms and date like the `summaries` command. Session
  ids written out in full link to the session's messages.
- `summaries <term...>` prints the stored summaries containing every term, newest first. `--since` keeps the periods
  that end on or after the date, so the week or month containing it is included.

To keep them current, pass `--summarize` to `sync`, and `summarize` runs after it. After the first run it makes calls
only once a day has ended. In the `SessionEnd` hook below, run it in the background, because writing a summary takes
longer than a hook is given:

```json
"command": "bunx github:sters/ai-session-archive sync --summarize >/dev/null 2>&1 &"
```

## Calendar

`http://localhost:7357/calendar` lays out the time spent working as a calendar.

- Each session is split into events (work blocks) wherever the gap between messages exceeds `--gap`. A session resumed
  the next day with `--resume` becomes one event per stretch of work.
- "Active spans" in the sidebar shows only the turns in which Claude was actually running. Turns that follow each
  other within 5 minutes are merged into one.
- An event's title is the `ai-title`, otherwise the first prompt, otherwise `last-prompt`. Its colour is determined by
  the session's `cwd`.
- Sessions whose `entrypoint` is `sdk-cli` (started programmatically through the SDK) are shown by default. Hide them
  with "Show SDK runs".
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
