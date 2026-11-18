import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { getSession, listSessions, matchesRole, search } from "./query";
import { IMPORT_VERSION, strip, sync, userText } from "./sync";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const line = (o: object) => `${JSON.stringify(o)}\n`;
const base = { sessionId: "s1", cwd: "/work/repo", gitBranch: "main" };

test("imports text and tool calls, appends incrementally, and finds Japanese substrings", async () => {
  dir = mkdtempSync(join(tmpdir(), "csa-"));
  const project = join(dir, "-work-repo");
  mkdirSync(join(project, "s1", "subagents"), { recursive: true });
  const main = join(project, "s1.jsonl");
  writeFileSync(
    main,
    line({ ...base, type: "user", timestamp: "2026-10-01T00:00:00Z", message: { content: "注文履歴が表示されない" } }) +
      line({
        ...base,
        type: "user",
        isMeta: true,
        timestamp: "2026-10-01T00:00:01Z",
        message: { content: "skill body" },
      }) +
      line({
        ...base,
        type: "assistant",
        timestamp: "2026-10-01T00:00:02Z",
        message: {
          content: [
            { type: "thinking", thinking: "" },
            { type: "text", text: "原因を切り分けます" },
            { type: "tool_use", name: "Bash", input: { command: "grep -rn OrderItems" } },
          ],
        },
      }) +
      line({
        ...base,
        type: "user",
        timestamp: "2026-10-01T00:00:03Z",
        message: { content: [{ type: "tool_result", content: "huge output" }] },
      }) +
      line({ type: "ai-title", aiTitle: "履歴の調査", sessionId: "s1" }) +
      '{"type":"user","message":{"content":"half writ',
  );
  const sub = join(project, "s1", "subagents", "agent-a1.jsonl");
  writeFileSync(
    sub,
    line({
      ...base,
      type: "assistant",
      timestamp: "2026-10-01T00:01:00Z",
      message: { content: [{ type: "text", text: "subagent report" }] },
    }),
  );
  writeFileSync(sub.replace(".jsonl", ".meta.json"), JSON.stringify({ agentType: "Explore", description: "find it" }));

  const db = openDb(":memory:");
  expect(await sync(db, dir)).toEqual({ files: 2, messages: 4 });

  expect(search(db, ["原因"], { limit: 10 }).map((h) => h.text)).toEqual(["原因を切り分けます"]);
  expect(search(db, ["表示さ"], { limit: 10 })[0]?.role).toBe("user");
  expect(search(db, ["OrderItems"], { limit: 10 })[0]?.tool).toBe("Bash");
  expect(search(db, ["OrderItems"], { limit: 10, roles: ["tool:Bash"] })).toHaveLength(1);
  expect(search(db, ["OrderItems"], { limit: 10, roles: ["user", "tool:Read"] })).toEqual([]);
  expect(matchesRole(["user", "tool:Bash"], { role: "tool", tool: "Bash" })).toBe(true);
  expect(matchesRole(["tool"], { role: "tool", tool: "Read" })).toBe(true);
  expect(matchesRole(["tool:Bash"], { role: "assistant", tool: null })).toBe(false);
  expect(search(db, ["huge output"], { limit: 10 })).toEqual([]);
  expect(search(db, ["skill body"], { limit: 10 })).toEqual([]);

  const [s] = getSession(db, "s1");
  expect(s?.session).toMatchObject({ title: "履歴の調査", cwd: "/work/repo", git_branch: "main" });
  expect(s?.subagents).toMatchObject([{ id: "agent-a1", parent_id: "s1", agent_type: "Explore" }]);
  expect(search(db, ["subagent report"], { limit: 10 })).toEqual([]);
  expect(search(db, ["subagent report"], { limit: 10, agents: true })).toHaveLength(1);
  expect(listSessions(db, { limit: 10 })).toMatchObject([{ id: "s1", prompts: 1 }]);

  expect(await sync(db, dir)).toEqual({ files: 0, messages: 0 });

  appendFileSync(main, 'ten"},"timestamp":"2026-10-01T00:05:00Z"}\n');
  expect(await sync(db, dir)).toEqual({ files: 1, messages: 1 });
  expect(search(db, ["half written"], { limit: 10 })).toHaveLength(1);
  expect(getSession(db, "s1")[0]?.session.last_ts).toBe("2026-10-01T00:05:00Z");

  writeFileSync(
    main,
    line({ ...base, type: "user", timestamp: "2026-10-02T00:00:00Z", message: { content: "rewritten" } }),
  );
  await sync(db, dir);
  expect(getSession(db, "s1")[0]?.messages.map((m) => m.text)).toEqual(["rewritten"]);
  expect(search(db, ["原因"], { limit: 10 })).toEqual([]);
});

test("records keep activity metadata without text or tool output", async () => {
  dir = mkdtempSync(join(tmpdir(), "csa-"));
  mkdirSync(join(dir, "-work-repo"));
  const main = join(dir, "-work-repo", "s1.jsonl");
  const usage = { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 11 };
  writeFileSync(
    main,
    line({
      ...base,
      type: "assistant",
      timestamp: "2026-10-01T00:00:00Z",
      message: {
        id: "msg_1",
        model: "claude-x",
        usage,
        content: [
          { type: "text", text: "secret answer" },
          { type: "tool_use", name: "Edit", input: { file_path: "/work/repo/a.ts", old_string: "secret" } },
        ],
      },
    }) +
      line({
        ...base,
        type: "user",
        timestamp: "2026-10-01T00:00:01Z",
        message: { content: [{ type: "tool_result", content: "secret output" }] },
        toolUseResult: { filePath: "/work/repo/a.ts", structuredPatch: [{ lines: ["+secret", "-old", " ctx"] }] },
      }) +
      line({ type: "system", subtype: "turn_duration", durationMs: 1500, timestamp: "2026-10-01T00:00:02Z" }) +
      line({ type: "cost-state", modelUsage: { "claude-x": { costUSD: 0.5 } } }) +
      line({ type: "file-history-snapshot", snapshot: {} }),
  );

  const db = openDb(":memory:");
  await sync(db, dir);
  const data = db
    .query<{ data: string }, []>("SELECT data FROM records ORDER BY id")
    .all()
    .map((r) => r.data);
  expect(data).toHaveLength(4);
  expect(data.join("\n")).not.toContain("secret");
  expect(JSON.parse(data[0]!)).toMatchObject({
    message: { id: "msg_1", model: "claude-x", usage, content: [{ type: "tool_use", name: "Edit" }] },
  });
  expect(JSON.parse(data[0]!)).toMatchObject({ cwd: "/work/repo", gitBranch: "main" });
  expect(JSON.parse(data[1]!)).not.toHaveProperty("cwd");
  expect(JSON.parse(data[1]!).toolUseResult.structuredPatch).toEqual([{ lines: ["+", "-", " "] }]);
  expect(JSON.parse(data[2]!)).toMatchObject({ subtype: "turn_duration", durationMs: 1500 });
  expect(JSON.parse(data[3]!)).toMatchObject({ modelUsage: { "claude-x": { costUSD: 0.5 } } });

  db.run("UPDATE sessions SET import_version = 0");
  db.run("DELETE FROM records");
  expect(await sync(db, dir)).toMatchObject({ files: 1 });
  expect(db.query("SELECT count(*) AS n FROM records").get()).toEqual({ n: 4 });
  expect(db.query("SELECT import_version AS v FROM sessions").get()).toEqual({ v: IMPORT_VERSION });
});

test("strip cuts a created file down to its newlines", () => {
  expect(
    strip({ type: "user", toolUseResult: { type: "create", filePath: "/a", content: "x\ny\n" } } as never),
  ).toEqual({
    type: "user",
    toolUseResult: { type: "create", filePath: "/a", content: "\n\n", structuredPatch: [] },
  });
});

test("--project matches whole path segments of any cwd a session was in", async () => {
  dir = mkdtempSync(join(tmpdir(), "csa-"));
  mkdirSync(join(dir, "-ws"));
  const session = (id: string, cwds: string[]) =>
    writeFileSync(
      join(dir, "-ws", `${id}.jsonl`),
      cwds
        .map((cwd, i) =>
          line({
            sessionId: id,
            cwd,
            type: "user",
            timestamp: `2026-10-01T00:00:0${i}Z`,
            message: { content: "deploy" },
          }),
        )
        .join(""),
    );
  session("moved", ["/ws", "/ws/task-1/acme/widgets/api"]);
  session("direct", ["/src/acme/widgets"]);
  session("similar", ["/src/acme/widgets-old"]);
  session("elsewhere", ["/ws"]);
  const db = openDb(":memory:");
  await sync(db, dir);

  const ids = (project: string) => [...new Set(search(db, ["deploy"], { project, limit: 10 }).map((h) => h.id))].sort();
  expect(ids("acme/widgets")).toEqual(["direct", "moved"]);
  expect(ids("/src/acme/widgets/")).toEqual(["direct"]);
  expect(ids("widgets-old")).toEqual(["similar"]);
  // Most recently active first: "moved" ran until 00:00:01, "direct" only at 00:00:00.
  expect(listSessions(db, { project: "acme/widgets", limit: 10 }).map((s) => s.id)).toEqual(["moved", "direct"]);
});

test("userText keeps what the user typed and drops what Claude Code wrote into user lines", () => {
  expect(userText("fix the orders page")).toBe("fix the orders page");
  expect(userText("<task-notification>\n<task-id>x</task-id>\n</task-notification>")).toBeNull();
  expect(userText('<teammate-message teammate_id="lead">go on</teammate-message>')).toBeNull();
  expect(userText("<local-command-stdout>done</local-command-stdout>")).toBeNull();
  expect(
    userText(
      "<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>123</command-args>",
    ),
  ).toBe("/review 123");
  expect(userText("<command-name>/clear</command-name>\n<command-args></command-args>")).toBe("/clear");
  expect(userText("<bash-input>git status</bash-input>")).toBe("! git status");
  expect(userText("<div>pasted html</div>")).toBe("<div>pasted html</div>");
});

test("openDb rewrites the user messages stored before userText, keeping the index in step", () => {
  dir = mkdtempSync(join(tmpdir(), "csa-"));
  const path = join(dir, "a.sqlite");
  const old = openDb(path);
  old.run("INSERT INTO sessions (id, file_path, project_dir) VALUES ('s', 's.jsonl', 'p')");
  const add = old.query("INSERT INTO messages (session, role, text) VALUES (1, 'user', ?)");
  for (const t of ["<task-notification>done</task-notification>", "<bash-input>ls</bash-input>", "plain request"]) {
    add.run(t);
  }
  old.run("PRAGMA user_version = 0");
  old.close();

  const db = openDb(path);
  expect(
    db
      .query<{ text: string }, []>("SELECT text FROM messages ORDER BY id")
      .all()
      .map((r) => r.text),
  ).toEqual(["! ls", "plain request"]);
  expect(search(db, ["done"], { limit: 10 })).toEqual([]);
  expect(search(db, ["! ls"], { limit: 10 })).toHaveLength(1);
  db.close();
});
