import type { Database } from "bun:sqlite";
import { Glob } from "bun";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const TOOL_INPUT_LIMIT = 2000;

export type Row = { ts: string | null; role: "user" | "assistant" | "tool"; tool: string | null; text: string };

// The fields read from a transcript line. Lines are untrusted input, so every field may be
// missing or of another type and is checked before use.
type Block = { type?: unknown; text?: unknown; name?: unknown; input?: unknown } | null;
export type TranscriptRecord = {
  type?: unknown;
  isMeta?: unknown;
  timestamp?: unknown;
  cwd?: unknown;
  gitBranch?: unknown;
  aiTitle?: unknown;
  message?: { content?: unknown } | null;
};
type AgentMeta = { agentType?: unknown; description?: unknown };

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const text = (b: Block): string | null => (b?.type === "text" && str(b.text)?.trim() ? (b.text as string) : null);

// Tool results and thinking are left out: tool results are most of the bytes and drown
// search hits, and thinking is usually redacted to an empty string.
export function extract(rec: TranscriptRecord): Row[] {
  const content = rec.message?.content;
  if (content == null || rec.isMeta) return [];
  const ts = str(rec.timestamp);
  const blocks = Array.isArray(content) ? (content as Block[]) : [];
  const rows: Row[] = [];
  if (rec.type === "user") {
    if (typeof content === "string") {
      if (content.trim()) rows.push({ ts, role: "user", tool: null, text: content });
    }
    for (const b of blocks) {
      const t = text(b);
      if (t) rows.push({ ts, role: "user", tool: null, text: t });
    }
  } else if (rec.type === "assistant") {
    for (const b of blocks) {
      const t = text(b);
      if (t) {
        rows.push({ ts, role: "assistant", tool: null, text: t });
      } else if (b?.type === "tool_use") {
        const input = JSON.stringify(b.input ?? {}).slice(0, TOOL_INPUT_LIMIT);
        rows.push({ ts, role: "tool", tool: str(b.name), text: input });
      }
    }
  }
  return rows;
}

// Bump when what is imported from a line changes; sessions imported at a lower version are imported
// again while their transcript exists.
export const IMPORT_VERSION = 1;

const RECORD_TEXT_LIMIT = 500;
const RECORD_TYPES = new Set(["user", "assistant", "system", "pr-link", "cost-state", "ai-title", "last-prompt"]);
const RECORD_FIELDS = [
  "type",
  "subtype",
  "timestamp",
  "slug",
  "aiTitle",
  "isMeta",
  "isCompactSummary",
  "promptSource",
  "attributionSkill",
  "attributionMcpServer",
  "durationMs",
  "prNumber",
  "prRepository",
  "prUrl",
  "modelUsage",
] as const;
// Repeated on nearly every line, so written only where they differ from the previous line's value.
const SESSION_FIELDS = ["cwd", "gitBranch", "entrypoint", "version"] as const;
const USAGE_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "cache_creation",
] as const;

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const opt = (v: unknown) => str(v) ?? undefined;
const short = (v: unknown) => opt(v)?.slice(0, RECORD_TEXT_LIMIT);

// Only a prompt's text is kept; it is what titles a session that has no ai-title.
function pick(o: Record<string, unknown> | null, keys: readonly string[]): object | undefined {
  if (!o) return undefined;
  return Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
}

function stripPart(v: unknown, keepText: boolean): object | null {
  const p = obj(v);
  switch (p?.type) {
    case "text":
      return keepText ? { type: "text", text: short(p.text) } : null;
    case "tool_result":
      return { type: "tool_result" };
    case "tool_use": {
      const input = obj(p.input);
      return {
        type: "tool_use",
        name: opt(p.name),
        input: { file_path: opt(input?.file_path), notebook_path: opt(input?.notebook_path) },
      };
    }
    default:
      return null;
  }
}

function stripToolResult(v: unknown): object | undefined {
  const r = obj(v);
  if (!r) return undefined;
  const patch = Array.isArray(r.structuredPatch) ? r.structuredPatch : [];
  const bashFiles = obj(r.bashEditDiff)?.files;
  return {
    type: opt(r.type),
    filePath: opt(r.filePath),
    // Only the line count of a created file and the +/- marker of each patch line are kept.
    content: r.type === "create" ? str(r.content)?.replace(/[^\n]/g, "") : undefined,
    structuredPatch: patch.map((h) => ({
      lines: (Array.isArray(obj(h)?.lines) ? (obj(h)!.lines as unknown[]) : []).map((l) => str(l)?.slice(0, 1) ?? ""),
    })),
    bashEditDiff: Array.isArray(bashFiles)
      ? { files: bashFiles.map((f) => ({ filePath: opt(obj(f)?.filePath) })) }
      : undefined,
  };
}

// A copy of a transcript line with what was said and what tools returned removed, keeping what
// describes the session's activity: timestamps, models, token usage, cost-state, turn durations,
// tool names, edited file paths, patch line markers and PR links. Prompt text is cut short.
// `cwd`, `gitBranch`, `entrypoint` and `version` are kept on user and assistant lines only, and only
// when they differ from the value in `prev`, which carries them from line to line of one file. Returns null for lines of other types.
export function strip(rec: TranscriptRecord, prev: Record<string, unknown> = {}): object | null {
  const r = rec as Record<string, unknown>;
  if (typeof r.type !== "string" || !RECORD_TYPES.has(r.type)) return null;
  const out: Record<string, unknown> = {};
  for (const k of RECORD_FIELDS) if (r[k] !== undefined) out[k] = r[k];
  for (const k of r.type === "user" || r.type === "assistant" ? SESSION_FIELDS : []) {
    if (r[k] === undefined || r[k] === prev[k]) continue;
    out[k] = prev[k] = r[k];
  }
  if (r.lastPrompt !== undefined) out.lastPrompt = short(r.lastPrompt);
  const m = obj(r.message);
  if (m) {
    const c = m.content;
    out.message = {
      id: opt(m.id),
      model: opt(m.model),
      usage: pick(obj(m.usage), USAGE_FIELDS),
      content:
        typeof c === "string"
          ? short(c)
          : Array.isArray(c)
            ? c.map((p) => stripPart(p, r.type === "user")).filter(Boolean)
            : undefined,
    };
  }
  const tr = stripToolResult(r.toolUseResult);
  if (tr) out.toolUseResult = tr;
  return out;
}

type SessionState = { rowid: number; imported_bytes: number; import_version: number };

export async function sync(db: Database, projectsDir: string): Promise<{ files: number; messages: number }> {
  const files = [
    ...new Glob("*/*.jsonl").scanSync({ cwd: projectsDir }),
    ...new Glob("*/*/subagents/*.jsonl").scanSync({ cwd: projectsDir }),
  ];

  const getState = db.query<SessionState, [string]>(
    "SELECT rowid, imported_bytes, import_version FROM sessions WHERE file_path = ?",
  );
  const insertSession = db.query<SessionState, [string, string | null, string, string, string | null, string | null]>(
    `INSERT INTO sessions (id, parent_id, file_path, project_dir, agent_type, description)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING rowid, imported_bytes, import_version`,
  );
  const insertMessage = db.query("INSERT INTO messages (session, ts, role, tool, text) VALUES (?, ?, ?, ?, ?)");
  const insertRecord = db.query("INSERT INTO records (session, ts, data) VALUES (?, ?, ?)");
  const updateSession = db.query(
    `UPDATE sessions SET
       cwd = coalesce(cwd, ?2), git_branch = coalesce(git_branch, ?3), title = coalesce(?4, title),
       first_ts = CASE WHEN first_ts IS NULL OR ?5 < first_ts THEN ?5 ELSE first_ts END,
       last_ts = CASE WHEN last_ts IS NULL OR ?6 > last_ts THEN ?6 ELSE last_ts END,
       imported_bytes = imported_bytes + ?7, import_version = ?8
     WHERE rowid = ?1`,
  );
  const deleteMessages = db.query("DELETE FROM messages WHERE session = ?");
  const deleteRecords = db.query("DELETE FROM records WHERE session = ?");
  const deleteSession = db.query("DELETE FROM sessions WHERE rowid = ?");

  let changedFiles = 0;
  let upgraded = false;
  let newMessages = 0;

  for (const rel of files) {
    const path = join(projectsDir, rel);
    const size = statSync(path).size;
    let state = getState.get(path);
    const current = state?.import_version === IMPORT_VERSION;
    if (state && current && state.imported_bytes === size) continue;
    // Transcripts are append-only; a file that shrank was rewritten, so start it over.
    if (state && (!current || state.imported_bytes > size)) {
      db.transaction(() => {
        deleteMessages.run(state!.rowid);
        deleteRecords.run(state!.rowid);
        deleteSession.run(state!.rowid);
      })();
      upgraded ||= !current;
      state = null;
    }

    const start = state?.imported_bytes ?? 0;
    const bytes = await Bun.file(path).slice(start, size).bytes();
    // Stop at the last newline so a line still being written is read on the next sync.
    const end = bytes.lastIndexOf(10) + 1;
    if (end === 0) continue;
    const lines = new TextDecoder().decode(bytes.subarray(0, end)).split("\n");

    let cwd: string | null = null;
    let branch: string | null = null;
    let title: string | null = null;
    let firstTs: string | null = null;
    let lastTs: string | null = null;
    const rows: Row[] = [];
    const records: [string | null, string][] = [];
    const prev = {};
    for (const line of lines) {
      if (!line) continue;
      let rec: TranscriptRecord | null;
      try {
        rec = JSON.parse(line) as TranscriptRecord | null;
      } catch {
        continue;
      }
      if (typeof rec !== "object" || rec === null) continue;
      cwd ??= str(rec.cwd);
      branch ??= str(rec.gitBranch);
      if (rec.type === "ai-title") title = str(rec.aiTitle) ?? title;
      const ts = str(rec.timestamp);
      if (ts) {
        if (!firstTs || ts < firstTs) firstTs = ts;
        if (!lastTs || ts > lastTs) lastTs = ts;
      }
      rows.push(...extract(rec));
      const record = strip(rec, prev);
      if (record) records.push([ts, JSON.stringify(record)]);
    }

    db.transaction(() => {
      const s = state ?? insertSession.get(...newSessionValues(path, rel))!;
      for (const r of rows) insertMessage.run(s.rowid, r.ts, r.role, r.tool, r.text);
      for (const [ts, data] of records) insertRecord.run(s.rowid, ts, data);
      updateSession.run(s.rowid, cwd, branch, title, firstTs, lastTs, end, IMPORT_VERSION);
    })();
    changedFiles++;
    newMessages += rows.length;
  }
  // Importing a whole archive again leaves the FTS index in many small segments and the deleted rows' pages
  // free; merging and vacuuming once brings it back to the size of a fresh import.
  if (upgraded) {
    db.run("INSERT INTO messages_fts(messages_fts) VALUES ('optimize')");
    db.run("VACUUM");
  }
  return { files: changedFiles, messages: newMessages };
}

function newSessionValues(
  path: string,
  rel: string,
): [string, string | null, string, string, string | null, string | null] {
  const id = basename(path, ".jsonl");
  const projectDir = rel.split("/")[0]!;
  if (basename(dirname(path)) !== "subagents") return [id, null, path, projectDir, null, null];
  const parentId = basename(dirname(dirname(path)));
  let meta: AgentMeta | null = null;
  try {
    meta = JSON.parse(readFileSync(path.replace(/\.jsonl$/, ".meta.json"), "utf8")) as AgentMeta | null;
  } catch {
    // A subagent without a readable meta file is still imported, just without its type and description.
  }
  return [id, parentId, path, projectDir, str(meta?.agentType), str(meta?.description)];
}
