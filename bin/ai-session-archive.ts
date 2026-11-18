#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Calendar } from "../src/calendar";
import { openDb } from "../src/db";
import { getSession, listSessions, local, search, snippet } from "../src/query";
import { claudeGenerate, listSummaries, lock, summarize, writeStats, type Period } from "../src/summary";
import { sync } from "../src/sync";
import { statsLine } from "../src/totals";
import { serve } from "../src/web/server";

const USAGE = `Usage: ai-session-archive <command> [options]

Commands:
  sync                     Import new lines from the Claude Code transcripts
  search <term...>         Messages containing every term, newest first
  sessions                 Main sessions, newest first
  show <session-id>        Every message of a session, with its subagents listed
  summarize                Write the summary of every ended day, week and month that has none or whose
                           input changed, by running \`claude -p\`
  summaries [term...]      Stored summaries containing every term, newest first
  web                      Serve search, session and calendar pages on http://localhost:<port>,
                           running sync every minute

Options:
  --project <path>         Only sessions that ran in <path> or below it, matched as whole path
                           segments of any cwd it was in (acme/widgets, /src/acme/widgets)
  --since <YYYY-MM-DD>     Only messages (search), sessions (sessions) or periods (summarize, summaries)
                           at or after this local date
  --period <day|week|month>  Only summaries of this period (summaries)
  --model <model>          Model for summarize (default: haiku)
  --jobs <n>               Summaries written at once by summarize (default: 4)
  --summarize              Also run summarize after each sync (sync, web)
  --limit <n>              Maximum rows (default: search 30, sessions 50, summaries 10)
  --port <n>               Port for web (default: 7357)
  --gap <minutes>          Idle time that splits a session into calendar events (default: 30)

Environment:
  AI_SESSION_ARCHIVE_DB    Database path (default: ~/.local/share/ai-session-archive/archive.sqlite)
  CLAUDE_CONFIG_DIR        Claude Code config dir holding projects/ (default: ~/.claude)`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    project: { type: "string" },
    since: { type: "string" },
    limit: { type: "string" },
    port: { type: "string" },
    gap: { type: "string" },
    period: { type: "string" },
    model: { type: "string" },
    summarize: { type: "boolean" },
    jobs: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const [command, ...args] = positionals;
if (values.help || !command) {
  console.log(USAGE);
  process.exit(command || values.help ? 0 : 1);
}

const dbPath = process.env.AI_SESSION_ARCHIVE_DB ?? join(homedir(), ".local/share/ai-session-archive/archive.sqlite");
const projectsDir = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
const db = openDb(dbPath);

const since = values.since ? new Date(`${values.since}T00:00:00`).toISOString() : undefined;
const filter = (defaultLimit: number) => ({
  project: values.project,
  since,
  limit: values.limit ? Number(values.limit) : defaultLimit,
});

// Shared by sync and the web server, which keep the parsed sessions between runs.
const calendar = new Calendar(db, Number(values.gap ?? 30) * 60_000);
const model = values.model ?? "haiku";
const lockPath = `${dbPath}.summarize.lock`;
// Resolves to the number of summaries written, or undefined when another process is summarizing.
const summarizeNow = async () => {
  const held = lock(lockPath);
  if ("heldBy" in held) {
    console.log(`summarize is already running (pid ${held.heldBy}, ${lockPath}); skipped`);
    return;
  }
  try {
    return await summarize(db, claudeGenerate(model), {
      model,
      since: values.since,
      jobs: Number(values.jobs ?? 4) || 4,
      log: (l) => console.log(`summarized ${l}`),
    });
  } finally {
    held.release();
  }
};

const printWritten = (n: number | undefined) => n !== undefined && console.log(`wrote ${n} summaries`);

switch (command) {
  case "sync": {
    const r = await sync(db, projectsDir);
    writeStats(db, calendar.sessions());
    console.log(`synced ${r.files} files, ${r.messages} messages`);
    if (values.summarize) printWritten(await summarizeNow());
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
  case "summarize": {
    printWritten(await summarizeNow());
    break;
  }
  case "summaries": {
    const period = values.period;
    if (period !== undefined && !["day", "week", "month"].includes(period)) {
      console.error("--period must be day, week or month");
      process.exit(1);
    }
    const found = listSummaries(db, {
      period: period as Period | undefined,
      since: values.since,
      terms: args,
      limit: values.limit ? Number(values.limit) : 10,
    });
    for (const s of found) {
      console.log(`# ${s.period} ${s.start}`);
      if (s.stats) console.log(statsLine(s.stats));
      console.log(`\n${s.text ?? "(not summarized yet)"}\n`);
    }
    break;
  }
  case "web": {
    const server = serve(db, Number(values.port ?? 7357), calendar);
    console.log(`listening on ${server.url}`);
    let syncing = false;
    const syncNow = async () => {
      if (syncing) return;
      syncing = true;
      try {
        await sync(db, projectsDir);
        writeStats(db, calendar.sessions());
      } catch (err) {
        console.error("sync failed:", err);
      } finally {
        syncing = false;
      }
      if (values.summarize) void summarizeInBackground();
    };
    // Kept apart from `syncing`, so that a long first run of summarize does not hold back sync.
    let summarizing = false;
    const summarizeInBackground = async () => {
      if (summarizing) return;
      summarizing = true;
      try {
        await summarizeNow();
      } catch (err) {
        console.error("summarize failed:", err);
      } finally {
        summarizing = false;
      }
    };
    void syncNow();
    setInterval(() => void syncNow(), 60_000);
    break;
  }
  default:
    console.error(`unknown command: ${command}\n\n${USAGE}`);
    process.exit(1);
}
