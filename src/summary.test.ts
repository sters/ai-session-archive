import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDb } from "./db";
import type { Block, CalendarSession } from "./calendar";
import { listSummaries, lock, summarize, writeStats, type Period } from "./summary";

// Around noon UTC, so that the local date is the same whether it is read by JavaScript (UTC under
// `bun test`) or by SQLite's 'localtime' (the system time zone) in any zone within ±11 hours.
const at = (day: number, hour: number) => new Date(Date.UTC(2026, 9, day, hour)).toISOString();

function fixture() {
  const db = openDb(":memory:");
  const session = (id: string, entrypoint: string) => {
    const rowid = db
      .query<{ rowid: number }, [string, string, string]>(
        `INSERT INTO sessions (id, file_path, project_dir, cwd, first_ts) VALUES (?, ?, 'p', '/work/my-app', ?)
         RETURNING rowid`,
      )
      .get(id, `${id}.jsonl`, at(1, 9))!.rowid;
    db.query("INSERT INTO records (session, ts, data) VALUES (?, NULL, ?)").run(rowid, JSON.stringify({ entrypoint }));
    return rowid;
  };
  const message = (s: number, ts: string, text: string) =>
    db.query("INSERT INTO messages (session, ts, role, text) VALUES (?, ?, 'user', ?)").run(s, ts, text);
  return { db, session, message };
}

test("summarizes ended days from their session files, then weeks and months from the day summaries", async () => {
  const { db, session, message } = fixture();
  const cli = session("s1", "cli");
  const sdk = session("s2", "sdk-cli");
  // 2026-10-04 is a Sunday: the week of Monday 09-28 ends with it.
  message(cli, at(1, 10), "fix the orders page");
  message(cli, at(4, 10), "add pagination to orders");
  message(sdk, at(4, 11), "automated run");
  message(cli, at(5, 10), "today, not summarized yet");

  const calls: string[] = [];
  const generate = async (system: string, input: string, files?: Record<string, string>) => {
    if (!files) return `rollup of ${input.length}`;
    const material = Object.values(files).join("\n");
    calls.push(material);
    return `day: ${material}`;
  };
  const o = { model: "test", today: "2026-10-05", jobs: 2 };

  expect(await summarize(db, generate, o)).toBe(3);
  const all = listSummaries(db, { terms: [], limit: 10 });
  expect(all.map((s) => `${s.period} ${s.start}`)).toEqual(["day 2026-10-04", "day 2026-10-01", "week 2026-09-28"]);
  expect(all[0]!.text).toContain("add pagination to orders");
  expect(all[0]!.text).toContain("[11:00 user] automated run");
  expect(all[0]!.text).toMatch(/## s2\nsdk-cli .*\ndirectories: \/work\/my-app\n/);
  expect(calls.join()).not.toContain("today");

  // Nothing changed, so nothing is written again.
  expect(await summarize(db, generate, o)).toBe(0);

  // A late message on an ended day rewrites that day and the week built from it.
  message(cli, at(4, 13), "late message");
  expect(await summarize(db, generate, o)).toBe(2);

  // Once October ends, its month summary is written.
  expect(await summarize(db, generate, { ...o, today: "2026-11-01" })).toBe(3);
  expect(listSummaries(db, { period: "month", terms: [], limit: 10 }).map((s) => s.start)).toEqual(["2026-10-01"]);

  expect(listSummaries(db, { terms: ["late message"], limit: 10 }).map((s) => s.start)).toEqual(["2026-10-04"]);
  // A week that ends after `since` is kept even though it starts before it.
  expect(listSummaries(db, { period: "week", since: "2026-10-04", terms: [], limit: 10 }).map((s) => s.start)).toEqual([
    "2026-10-05",
    "2026-09-28",
  ]);
});

test("writes up to `jobs` summaries at once, and stops starting new ones after a failure", async () => {
  const { db, session, message } = fixture();
  const cli = session("s1", "cli");
  for (const day of [1, 2, 3, 4, 5]) message(cli, at(day, 10), `work on day ${day}`);

  let running = 0;
  let peak = 0;
  const generate = async (_: string, input: string) => {
    running++;
    peak = Math.max(peak, running);
    await Bun.sleep(5);
    running--;
    if (input.includes("2026-10-02")) throw new Error("rate limited");
    return "ok";
  };
  await expect(summarize(db, generate, { model: "test", today: "2026-10-31", jobs: 2 })).rejects.toThrow(
    "rate limited",
  );
  expect(peak).toBe(2);
  // Days 1 and 2 ran together; day 3 was started by the worker that finished day 1 before day 2 failed.
  expect(listSummaries(db, { terms: [], limit: 10 }).map((s) => s.start)).toEqual(["2026-10-03", "2026-10-01"]);
});

test("stores calendar totals per day, week and month, splitting active time at midnight", () => {
  const { db } = fixture();
  const local = (day: number, hour: number) => new Date(2026, 9, day, hour).getTime();
  const block = (start: number, end: number, extra: Partial<Block> = {}): Block => ({
    start,
    end,
    prompts: 1,
    messages: 2,
    activeMs: end - start,
    active: [{ start, end }],
    costUSD: 1.5,
    linesAdded: 10,
    linesRemoved: 2,
    files: [],
    prs: [],
    errors: 0,
    ...extra,
  });
  const session = (id: string, blocks: Block[]) => ({ id, blocks }) as CalendarSession;
  const pr = { number: 1, repository: "acme/widgets", url: "https://example.com/acme/widgets/pull/1", at: 0 };
  writeStats(db, [
    // Sunday 23:00 to Monday 01:00: two hours, split across two days and two weeks.
    session("a", [block(local(4, 23), local(5, 1), { prs: [pr] })]),
    session("b", [block(local(5, 10), local(5, 11)), block(local(5, 15), local(5, 16))]),
  ]);
  const stats = (period: Period, start: string) =>
    listSummaries(db, { period, terms: [], limit: 50 }).find((s) => s.start === start)?.stats;
  expect(stats("day", "2026-10-04")).toEqual({
    sessions: 1,
    prompts: 1,
    activeMs: 3_600_000,
    costUSD: 1.5,
    linesAdded: 10,
    linesRemoved: 2,
    prs: 1,
  });
  // Monday gets the hour after midnight of a block that started on Sunday, but not its cost or PR.
  expect(stats("day", "2026-10-05")).toMatchObject({ sessions: 1, prompts: 2, activeMs: 3 * 3_600_000, prs: 0 });
  expect(stats("week", "2026-10-05")).toMatchObject({ sessions: 1, activeMs: 3 * 3_600_000, costUSD: 3 });
  expect(stats("month", "2026-10-01")).toMatchObject({ sessions: 2, activeMs: 4 * 3_600_000, costUSD: 4.5, prs: 1 });
  // A period with stats but no summary is listed with no text.
  expect(listSummaries(db, { period: "day", terms: [], limit: 1 })[0]).toMatchObject({
    start: "2026-10-05",
    text: null,
  });
});

test("lock lets one process in at a time and takes over a lock whose process is gone", () => {
  const path = join(mkdtempSync(join(tmpdir(), "csa-")), "lock");
  const first = lock(path);
  expect(first).toHaveProperty("release");
  expect(lock(path)).toEqual({ heldBy: process.pid });
  (first as { release: () => void }).release();
  expect(existsSync(path)).toBe(false);

  const gone = Bun.spawnSync(["true"]).pid;
  writeFileSync(path, String(gone));
  const taken = lock(path);
  expect(taken).toHaveProperty("release");
  expect(readFileSync(path, "utf8")).toBe(String(process.pid));

  writeFileSync(path, "");
  expect(lock(path)).toEqual({ heldBy: 0 });
  rmSync(dirname(path), { recursive: true });
});
