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

type SessionState = { rowid: number; imported_bytes: number };

export async function sync(db: Database, projectsDir: string): Promise<{ files: number; messages: number }> {
  const files = [
    ...new Glob("*/*.jsonl").scanSync({ cwd: projectsDir }),
    ...new Glob("*/*/subagents/*.jsonl").scanSync({ cwd: projectsDir }),
  ];

  const getState = db.query<SessionState, [string]>("SELECT rowid, imported_bytes FROM sessions WHERE file_path = ?");
  const insertSession = db.query<SessionState, [string, string | null, string, string, string | null, string | null]>(
    `INSERT INTO sessions (id, parent_id, file_path, project_dir, agent_type, description)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING rowid, imported_bytes`,
  );
  const insertMessage = db.query("INSERT INTO messages (session, ts, role, tool, text) VALUES (?, ?, ?, ?, ?)");
  const updateSession = db.query(
    `UPDATE sessions SET
       cwd = coalesce(cwd, ?2), git_branch = coalesce(git_branch, ?3), title = coalesce(?4, title),
       first_ts = CASE WHEN first_ts IS NULL OR ?5 < first_ts THEN ?5 ELSE first_ts END,
       last_ts = CASE WHEN last_ts IS NULL OR ?6 > last_ts THEN ?6 ELSE last_ts END,
       imported_bytes = imported_bytes + ?7
     WHERE rowid = ?1`,
  );
  const deleteMessages = db.query("DELETE FROM messages WHERE session = ?");
  const deleteSession = db.query("DELETE FROM sessions WHERE rowid = ?");

  let changedFiles = 0;
  let newMessages = 0;

  for (const rel of files) {
    const path = join(projectsDir, rel);
    const size = statSync(path).size;
    let state = getState.get(path);
    if (state && state.imported_bytes === size) continue;
    // Transcripts are append-only; a file that shrank was rewritten, so start it over.
    if (state && state.imported_bytes > size) {
      db.transaction(() => {
        deleteMessages.run(state!.rowid);
        deleteSession.run(state!.rowid);
      })();
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
    }

    db.transaction(() => {
      const s = state ?? insertSession.get(...newSessionValues(path, rel))!;
      for (const r of rows) insertMessage.run(s.rowid, r.ts, r.role, r.tool, r.text);
      updateSession.run(s.rowid, cwd, branch, title, firstTs, lastTs, end);
    })();
    changedFiles++;
    newMessages += rows.length;
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
