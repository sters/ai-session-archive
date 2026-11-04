#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { openDb } from "../src/db";
import { getSession, listSessions, search, snippet } from "../src/query";
import { sync } from "../src/sync";

const USAGE = `Usage: cc-session-archive <command> [options]

Commands:
  sync                     Import new lines from the Claude Code transcripts
  search <term...>         Messages containing every term, newest first
  sessions                 Main sessions, newest first
  show <session-id>        Every message of a session, with its subagents listed

Options:
  --project <text>         Only sessions whose cwd contains <text>
  --since <YYYY-MM-DD>     Only messages (search) or sessions (sessions) at or after this local date
  --limit <n>              Maximum rows (default: search 30, sessions 50)

Environment:
  CC_SESSION_ARCHIVE_DB    Database path (default: ~/.local/share/cc-session-archive/archive.sqlite)
  CLAUDE_CONFIG_DIR        Claude Code config dir holding projects/ (default: ~/.claude)`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    project: { type: "string" },
    since: { type: "string" },
    limit: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const [command, ...args] = positionals;
if (values.help || !command) {
  console.log(USAGE);
  process.exit(command || values.help ? 0 : 1);
}

const dbPath = process.env.CC_SESSION_ARCHIVE_DB ?? join(homedir(), ".local/share/cc-session-archive/archive.sqlite");
const projectsDir = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
const db = openDb(dbPath);

const since = values.since ? new Date(`${values.since}T00:00:00`).toISOString() : undefined;
const filter = (defaultLimit: number) => ({
  project: values.project,
  since,
  limit: values.limit ? Number(values.limit) : defaultLimit,
});

function local(ts: string | null): string {
  if (!ts) return "????-??-?? ??:??";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

switch (command) {
  case "sync": {
    const r = await sync(db, projectsDir);
    console.log(`synced ${r.files} files, ${r.messages} messages`);
    break;
  }
  case "search": {
    if (args.length === 0) {
      console.error("search needs at least one term");
      process.exit(1);
    }
    for (const h of search(db, args, filter(30))) {
      const who = h.role === "tool" ? `tool:${h.tool}` : h.role;
      console.log(`${local(h.ts)}  ${h.id}  ${h.cwd ?? "-"}\n  ${who}: ${snippet(h.text, args)}`);
    }
    break;
  }
  case "sessions": {
    for (const s of listSessions(db, filter(50))) {
      console.log(`${local(s.first_ts)}  ${s.id}  ${s.cwd ?? "-"}  ${s.title ?? ""}`);
    }
    break;
  }
  case "show": {
    const id = args[0];
    const found = id ? getSession(db, id) : [];
    if (found.length === 0) {
      console.error(`no session ${id ?? ""}`);
      process.exit(1);
    }
    for (const { session: s, messages, subagents } of found) {
      console.log(`# ${s.title ?? s.description ?? s.id}`);
      console.log(`id: ${s.id}${s.parent_id ? `  parent: ${s.parent_id}  agent: ${s.agent_type}` : ""}`);
      console.log(`cwd: ${s.cwd ?? "-"}  branch: ${s.git_branch ?? "-"}  ${local(s.first_ts)} - ${local(s.last_ts)}`);
      console.log(`transcript: ${s.file_path}\n`);
      for (const m of messages) {
        const who = m.role === "tool" ? `[tool:${m.tool}]` : `[${m.role}]`;
        console.log(`${local(m.ts)} ${who}\n${m.text}\n`);
      }
      for (const a of subagents) console.log(`subagent ${a.id} (${a.agent_type}): ${a.description ?? ""}`);
    }
    break;
  }
  default:
    console.error(`unknown command: ${command}\n\n${USAGE}`);
    process.exit(1);
}
