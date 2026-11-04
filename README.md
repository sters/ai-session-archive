# cc-session-archive

Full-text search over your Claude Code session transcripts.

Claude Code already writes every session to `~/.claude/projects/<project>/<session>.jsonl`. This tool reads those
files (never writes to them) and keeps a SQLite index of what was said: user messages, assistant text, and tool calls
with their input. Tool results and thinking are left out, which keeps the database at a few percent of the transcripts'
size and keeps search hits readable.

Needs only [Bun](https://bun.sh). The index uses SQLite FTS5 with the trigram tokenizer, so Japanese matches by
substring without word segmentation.

## Usage

```bash
bunx github:sters/cc-session-archive sync        # import new lines (incremental)
bunx github:sters/cc-session-archive search 注文履歴 OrderItems --since 2026-10-01
bunx github:sters/cc-session-archive sessions --project my-app
bunx github:sters/cc-session-archive show <session-id>
```

`search` returns messages containing every term, newest first. Terms of one or two characters still match, but are
not served by the trigram index and scan the whole table.

| Option                 | Meaning                                                                       |
| ---------------------- | ----------------------------------------------------------------------------- |
| `--project <text>`     | Only sessions whose cwd contains `<text>`                                     |
| `--since <YYYY-MM-DD>` | Only messages (`search`) or sessions (`sessions`) at or after this local date |
| `--limit <n>`          | Maximum rows (default: `search` 30, `sessions` 50)                            |

| Environment             | Default                                                 |
| ----------------------- | ------------------------------------------------------- |
| `CC_SESSION_ARCHIVE_DB` | `~/.local/share/cc-session-archive/archive.sqlite`      |
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
            "command": "bunx github:sters/cc-session-archive sync >/dev/null 2>&1"
          }
        ]
      }
    ]
  }
}
```

Claude Code deletes transcripts older than `cleanupPeriodDays` (default 30). The index keeps what it already imported,
but only sessions synced before their transcript was deleted. Raise `cleanupPeriodDays` if you want the originals kept.

## Letting Claude use it

This repository is a Claude Code plugin marketplace. Installing the plugin gives Claude the `session-archive` skill,
which runs the CLI through `bunx`:

```text
/plugin marketplace add sters/cc-session-archive
/plugin install cc-session-archive@cc-session-archive
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
