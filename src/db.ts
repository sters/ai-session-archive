import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 10000");
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    rowid INTEGER PRIMARY KEY,
    id TEXT NOT NULL,
    parent_id TEXT,
    file_path TEXT NOT NULL UNIQUE,
    project_dir TEXT NOT NULL,
    cwd TEXT,
    git_branch TEXT,
    title TEXT,
    agent_type TEXT,
    description TEXT,
    first_ts TEXT,
    last_ts TEXT,
    imported_bytes INTEGER NOT NULL DEFAULT 0
  )`);
  // Sessions imported by an older build have a lower import_version and are imported again by `sync`
  // while their transcript still exists.
  const columns = db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('sessions')").all();
  if (!columns.some((c) => c.name === "import_version")) {
    db.run("ALTER TABLE sessions ADD COLUMN import_version INTEGER NOT NULL DEFAULT 0");
  }
  db.run("CREATE INDEX IF NOT EXISTS sessions_id ON sessions(id)");
  db.run("CREATE INDEX IF NOT EXISTS sessions_parent ON sessions(parent_id)");
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    session INTEGER NOT NULL REFERENCES sessions(rowid),
    ts TEXT,
    role TEXT NOT NULL,
    tool TEXT,
    text TEXT NOT NULL
  )`);
  db.run("CREATE INDEX IF NOT EXISTS messages_session ON messages(session, id)");
  // One row per transcript line that carries metadata, in file order: the line as JSON with its text,
  // tool input and tool output stripped (see `strip` in sync.ts). Token usage, cost-state and turn
  // durations are kept as Claude Code wrote them.
  db.run(`CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY,
    session INTEGER NOT NULL REFERENCES sessions(rowid),
    ts TEXT,
    data TEXT NOT NULL
  )`);
  db.run("CREATE INDEX IF NOT EXISTS records_session ON records(session, id)");
  // trigram so that Japanese, which has no word boundaries, matches by substring.
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    text, content='messages', content_rowid='id', tokenize='trigram'
  )`);
  db.run(`CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
  END`);
  db.run(`CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END`);
  return db;
}
