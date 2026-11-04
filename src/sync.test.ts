import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { getSession, search } from "./query";
import { sync } from "./sync";

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
  expect(search(db, ["huge output"], { limit: 10 })).toEqual([]);
  expect(search(db, ["skill body"], { limit: 10 })).toEqual([]);

  const [s] = getSession(db, "s1");
  expect(s?.session).toMatchObject({ title: "履歴の調査", cwd: "/work/repo", git_branch: "main" });
  expect(s?.subagents).toMatchObject([{ id: "agent-a1", parent_id: "s1", agent_type: "Explore" }]);

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
