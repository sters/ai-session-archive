import type { Database } from "bun:sqlite";

const SNIPPET_RADIUS = 80;

export type Filter = { project?: string; since?: string; limit: number };

export type Hit = {
  ts: string | null;
  id: string;
  cwd: string | null;
  role: string;
  tool: string | null;
  text: string;
};

// `%` and `_` in a term act as LIKE wildcards. The trigram index serves LIKE only
// without an ESCAPE clause, so they are left unescaped.
export function search(db: Database, terms: string[], f: Filter): Hit[] {
  const where = terms.map(() => "messages_fts.text LIKE ?");
  const params: (string | number)[] = terms.map((t) => `%${t}%`);
  if (f.project) {
    where.push("s.cwd LIKE ?");
    params.push(`%${f.project}%`);
  }
  if (f.since) {
    where.push("m.ts >= ?");
    params.push(f.since);
  }
  params.push(f.limit);
  return db
    .query<Hit, (string | number)[]>(
      `SELECT m.ts, s.id, s.cwd, m.role, m.tool, m.text
       FROM messages_fts
       JOIN messages m ON m.id = messages_fts.rowid
       JOIN sessions s ON s.rowid = m.session
       WHERE ${where.join(" AND ")}
       ORDER BY m.ts DESC
       LIMIT ?`,
    )
    .all(...params);
}

export function snippet(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  const at = terms.map((t) => lower.indexOf(t.toLowerCase())).find((i) => i >= 0) ?? 0;
  const from = Math.max(0, at - SNIPPET_RADIUS);
  const to = Math.min(text.length, at + SNIPPET_RADIUS);
  return (from > 0 ? "…" : "") + text.slice(from, to).replace(/\s+/g, " ") + (to < text.length ? "…" : "");
}

export type SessionRow = {
  id: string;
  parent_id: string | null;
  file_path: string;
  cwd: string | null;
  git_branch: string | null;
  title: string | null;
  agent_type: string | null;
  description: string | null;
  first_ts: string | null;
  last_ts: string | null;
};

const SESSION_COLUMNS = "id, parent_id, file_path, cwd, git_branch, title, agent_type, description, first_ts, last_ts";

export function listSessions(db: Database, f: Filter): SessionRow[] {
  const where = ["parent_id IS NULL"];
  const params: (string | number)[] = [];
  if (f.project) {
    where.push("cwd LIKE ?");
    params.push(`%${f.project}%`);
  }
  if (f.since) {
    where.push("last_ts >= ?");
    params.push(f.since);
  }
  params.push(f.limit);
  return db
    .query<SessionRow, (string | number)[]>(
      `SELECT ${SESSION_COLUMNS} FROM sessions WHERE ${where.join(" AND ")} ORDER BY first_ts DESC LIMIT ?`,
    )
    .all(...params);
}

export function getSession(db: Database, id: string) {
  const sessions = db
    .query<SessionRow & { rowid: number }, [string]>(`SELECT rowid, ${SESSION_COLUMNS} FROM sessions WHERE id = ?`)
    .all(id);
  const messages = db.query<Omit<Hit, "id" | "cwd">, [number]>(
    "SELECT ts, role, tool, text FROM messages WHERE session = ? ORDER BY id",
  );
  const subagents = db.query<SessionRow, [string]>(
    `SELECT ${SESSION_COLUMNS} FROM sessions WHERE parent_id = ? ORDER BY first_ts`,
  );
  return sessions.map((s) => ({ session: s, messages: messages.all(s.rowid), subagents: subagents.all(id) }));
}
