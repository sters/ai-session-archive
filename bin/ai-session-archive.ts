#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Calendar } from "../src/calendar";
import { openDb } from "../src/db";
import { getSession, isRole, listSessions, local, matchesRole, search, snippet } from "../src/query";
import {
  claudeGenerate,
  getSummary,
  listSummaries,
  lock,
  sections,
  searchSummaries,
  summarize,
  writeStats,
  type Period,
} from "../src/summary";
import { sync } from "../src/sync";
import { statsLine } from "../src/totals";
import { serve } from "../src/web/server";

const USAGE = `Usage: ai-session-archive <command> [options]

Commands:
  sync                     Import new lines from the Claude Code transcripts
  search <term...>         Messages of main sessions and summary sections containing every term,
                           newest first: up to --limit messages, 3 of them per session, and 10
                           summary sections
  sessions                 Main sessions, most recently active first, with their time span and prompts
  show <session-id>        Every message of a session, with its subagents listed
  show <period>/<start>    A stored summary, as named by search (day/2026-10-01); --project keeps
                           only that project's sections
  summarize                Write the summary of every ended day, week and month that has none or whose
                           input changed, by running \`claude -p\`
  summaries [term...]      Stored summaries containing every term, newest first
  web                      Serve search, session and calendar pages on http://localhost:<port>

Options:
  --project <path>         Only sessions that ran in <path> or below it, matched as whole path
                           segments of any cwd it was in (acme/widgets, /src/acme/widgets)
  --since <YYYY-MM-DD>     Only messages (search), sessions (sessions) or periods (summarize, summaries)
                           at or after this local date
  --period <day|week|month>  Only summaries of this period (summaries)
  --model <model>          Model for summarize (default: haiku)
  --jobs <n>               Summaries written at once by summarize (default: 4)
  --summarize              Also run summarize after sync (sync)
  --limit <n>              Maximum rows (default: search 30, sessions 50, summaries 10)
  --port <n>               Port for web (default: 7357)
  --gap <minutes>          Idle time that splits a session into calendar events (default: 30)
  --lines <from>-<to>      Only these lines of show's output, which is numbered (also <n>, <from>-);
                           lines left out by --project or --role keep their numbers
  --role <role,...>        Only messages of these roles: user, assistant, tool, or tool:<name> for one
                           tool (search, show); with --limit <n>, only the first n (show)
  --agents                 Also search subagent sessions (search)

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
    lines: { type: "string" },
    period: { type: "string" },
    model: { type: "string" },
    summarize: { type: "boolean" },
    agents: { type: "boolean" },
    role: { type: "string" },
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

const roles = values.role?.split(",").map((r) => r.trim());
if (roles && !roles.every(isRole)) {
  console.error("--role takes a comma-separated list of user, assistant, tool and tool:<name>");
  process.exit(1);
}
const since = values.since ? new Date(`${values.since}T00:00:00`).toISOString() : undefined;
const filter = (defaultLimit: number) => ({
  project: values.project,
  since,
  limit: values.limit ? Number(values.limit) : defaultLimit,
  agents: values.agents,
  roles,
});

// The web server keeps the parsed sessions between requests.
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
    const f = filter(30);
    // Messages and summary sections are limited apart, since a day's messages would otherwise crowd out every
    // summary. A summary is placed at the end of its period's last day, before the messages it covers. A session
    // shows its newest PER_SESSION hits, the last of them followed by how many more were found.
    const PER_SESSION = 3;
    const messages = search(db, args, { ...f, limit: f.limit * 10 });
    const found = new Map<string, number>();
    for (const h of messages) found.set(h.id, (found.get(h.id) ?? 0) + 1);
    const shown = new Map<string, number>();
    const kept = messages
      .filter((h) => {
        const n = (shown.get(h.id) ?? 0) + 1;
        shown.set(h.id, n);
        return n <= PER_SESSION;
      })
      .slice(0, f.limit);
    shown.clear();
    const hits = [
      ...kept.map((h) => {
        const who = h.role === "tool" ? `tool:${h.tool}` : h.role;
        const n = (shown.get(h.id) ?? 0) + 1;
        shown.set(h.id, n);
        const more =
          n === PER_SESSION && found.get(h.id)! > n ? `\n  (+${found.get(h.id)! - n} more in this session)` : "";
        const where = f.project ? "" : `  ${h.cwd ?? "-"}`;
        const out = `${local(h.ts)}  ${h.id}${where}\n  ${who}: ${snippet(h.text, args, h.role === "user")}${more}`;
        return { at: h.ts ?? "", out };
      }),
      ...searchSummaries(db, args, { project: f.project, since: values.since, limit: Math.min(f.limit, 10) }).map(
        (s) => {
          const [y = 0, m = 1, d = 1] = s.lastDay.split("-").map(Number);
          const out = `${s.lastDay}        summary ${s.period}/${s.start} (lines ${s.from}-${s.to})\n${s.lines.replace(/^/gm, "  ")}`;
          return { at: new Date(new Date(y, m - 1, d + 1).getTime() - 1).toISOString(), out };
        },
      ),
    ];
    hits.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    for (const h of hits) console.log(h.out);
    break;
  }
  case "sessions": {
    for (const s of listSessions(db, filter(50))) {
      const prompts = `${s.prompts} prompt${s.prompts === 1 ? "" : "s"}`;
      const title = s.title ?? (s.first_prompt ? snippet(s.first_prompt, [], true) : "");
      console.log(`${local(s.first_ts)} - ${local(s.last_ts)}  ${s.id}  ${prompts}  ${s.cwd ?? "-"}  ${title}`);
    }
    break;
  }
  case "show": {
    const id = args[0];
    const range = values.lines?.match(/^(\d+)(-(\d*))?$/);
    if (values.lines !== undefined && !range) {
      console.error("--lines must be <n>, <from>-<to> or <from>-");
      process.exit(1);
    }
    const from = range ? Number(range[1]) : 1;
    const to = range?.[3] ? Number(range[3]) : range?.[2] || !range ? Infinity : from;
    // Lines left out by --project or --role are undefined, so the rest keep their numbers.
    const out: (string | undefined)[] = [];
    const ref = id?.match(/^(day|week|month)\/(\d{4}-\d{2}-\d{2})$/);
    if (ref) {
      const text = getSummary(db, ref[1] as Period, ref[2]!);
      if (text === undefined) {
        console.error(`no summary ${id}`);
        process.exit(1);
      }
      const lines = text.split("\n");
      const kept = new Set(sections(lines, values.project).flatMap(([a, b]) => lines.slice(a, b).map((_, i) => a + i)));
      out.push(...lines.map((l, i) => (kept.has(i) ? l : undefined)));
    } else {
      const found = id ? getSession(db, id) : [];
      if (found.length === 0) {
        console.error(`no session ${id ?? ""}`);
        process.exit(1);
      }
      for (const { session: s, messages, subagents } of found) {
        out.push(`# ${s.title ?? s.description ?? s.id}`);
        out.push(`id: ${s.id}${s.parent_id ? `  parent: ${s.parent_id}  agent: ${s.agent_type}` : ""}`);
        out.push(
          `cwd: ${s.cwd ?? "-"}  branch at start: ${s.git_branch ?? "-"}  ${local(s.first_ts)} - ${local(s.last_ts)}`,
        );
        out.push(`transcript: ${s.file_path}`, "");
        // Under --role, --limit keeps the first messages shown, a prompt sent again unchanged is left out, and the
        // summary Claude Code writes when it compacts a conversation, which is stored as a user message, is
        // replaced by where to read it.
        let count = 0;
        let previous: string | undefined;
        for (const m of messages) {
          const who = m.role === "tool" ? `[tool:${m.tool}]` : `[${m.role}]`;
          const lines: (string | undefined)[] = [`${local(m.ts)} ${who}`, ...m.text.split("\n"), ""];
          if (roles) {
            const repeated = m.role === "user" && m.text === previous;
            if (m.role === "user") previous = m.text;
            const shown = matchesRole(roles, m) && !repeated;
            if (shown) count++;
            if (!shown || (values.limit && count > Number(values.limit))) {
              out.push(...lines.map(() => undefined));
              continue;
            }
            if (m.text.startsWith("This session is being continued from a previous conversation")) {
              const [first, last] = [out.length + 2, out.length + lines.length - 1];
              lines.fill(undefined, 1);
              lines[1] = `(summary of the earlier conversation, written when it was compacted: lines ${first}-${last}, shown without --role)`;
            }
          }
          out.push(...lines);
        }
        if (!roles) for (const a of subagents) out.push(`subagent ${a.id} (${a.agent_type}): ${a.description ?? ""}`);
      }
    }
    let printed = 0;
    for (let i = from; i <= Math.min(to, out.length); i++) {
      if (out[i - 1] === undefined) continue;
      console.log(`${i}: ${out[i - 1]}`);
      printed++;
    }
    if (printed < out.length) console.log(`(${out.length} lines)`);
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
    break;
  }
  default:
    console.error(`unknown command: ${command}\n\n${USAGE}`);
    process.exit(1);
}
