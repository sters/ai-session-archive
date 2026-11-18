import type { Database } from "bun:sqlite";

const SNIPPET_RADIUS = 80;

// `agents` includes subagent sessions in a search; they are left out by default, as their parent holds what
// they were asked and what they reported. `roles` keeps the messages of those roles (see `matchesRole`).
export type Filter = { project?: string; since?: string; limit: number; agents?: boolean; roles?: string[] };

// A role is `user`, `assistant` or `tool`, or `tool:<name>` for the calls of one tool.
export const isRole = (r: string) => /^(user|assistant|tool(:.+)?)$/.test(r);
export const matchesRole = (roles: string[], m: { role: string; tool: string | null }) =>
  roles.some((r) => r === m.role || (m.role === "tool" && r === `tool:${m.tool}`));

// Keeps the sessions that ran in `project` or below it at any point, not only where they started:
// `project` matches whole path segments of a cwd, so `acme/widgets` matches /src/acme/widgets/api but
// not /src/acme/widgets-old. A cwd is recorded on the lines where it changes (see `strip` in sync.ts).
function inProject(alias: string, project: string): [string, string[]] {
  const segment = `/${project.replace(/^\/+|\/+$/g, "")}/`;
  return [
    `(instr('/' || ${alias}.cwd || '/', ?) > 0 OR EXISTS (
       SELECT 1 FROM records r WHERE r.session = ${alias}.rowid
         AND instr('/' || json_extract(r.data, '$.cwd') || '/', ?) > 0))`,
    [segment, segment],
  ];
}

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
  if (!f.agents) where.push("s.parent_id IS NULL");
  if (f.roles) {
    where.push(
      `(${f.roles.map((r) => (r.startsWith("tool:") ? "(m.role = 'tool' AND m.tool = ?)" : "m.role = ?")).join(" OR ")})`,
    );
    params.push(...f.roles.map((r) => (r.startsWith("tool:") ? r.slice(5) : r)));
  }
  if (f.project) {
    const [sql, p] = inProject("s", f.project);
    where.push(sql);
    params.push(...p);
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

// Around the first term found, or the start of the text when `fromStart`, as for a prompt, whose start says
// what was asked.
export function snippet(text: string, terms: string[], fromStart = false): string {
  const lower = text.toLowerCase();
  const at = fromStart ? 0 : (terms.map((t) => lower.indexOf(t.toLowerCase())).find((i) => i >= 0) ?? 0);
  const from = Math.max(0, at - SNIPPET_RADIUS);
  const to = Math.min(text.length, from + 2 * SNIPPET_RADIUS);
  return (from > 0 ? "…" : "") + text.slice(from, to).replace(/\s+/g, " ") + (to < text.length ? "…" : "");
}

export function local(ts: string | null): string {
  if (!ts) return "????-??-?? ??:??";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
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

// `first_prompt` is the first user message that is not a slash command, for a session without a title.
export type ListedSession = SessionRow & { structured: number; prompts: number; first_prompt: string | null };

// `structured` is 1 when the session's last message is a StructuredOutput tool call, i.e. it ended by returning
// schema-shaped output.
export function listSessions(db: Database, f: Filter): ListedSession[] {
  const where = ["parent_id IS NULL"];
  const params: (string | number)[] = [];
  if (f.project) {
    const [sql, p] = inProject("sessions", f.project);
    where.push(sql);
    params.push(...p);
  }
  if (f.since) {
    where.push("last_ts >= ?");
    params.push(f.since);
  }
  params.push(f.limit);
  return db
    .query<ListedSession, (string | number)[]>(
      `SELECT ${SESSION_COLUMNS},
         (SELECT tool FROM messages WHERE session = sessions.rowid ORDER BY id DESC LIMIT 1) IS 'StructuredOutput'
           AS structured,
         (SELECT count(*) FROM messages WHERE session = sessions.rowid AND role = 'user') AS prompts,
         (SELECT text FROM messages WHERE session = sessions.rowid AND role = 'user' AND text NOT LIKE '/%'
          ORDER BY id LIMIT 1) AS first_prompt
       FROM sessions WHERE ${where.join(" AND ")} ORDER BY last_ts DESC LIMIT ?`,
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
