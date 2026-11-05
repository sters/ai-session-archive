import { expect, test } from "bun:test";
import { Calendar, eventsBetween, parseSession } from "./calendar";
import { openDb } from "./db";
import { strip, type TranscriptRecord } from "./sync";

const HOUR = 3_600_000;
const t = (v: string) => Date.parse(v);
// Lines go through strip first, as sync stores them.
const parse = (lines: object[], gap = 30 * 60_000, subagents: object[][] = []) =>
  parseSession(
    "s",
    lines.map((l) => strip(l as TranscriptRecord, {}) as Record<string, unknown>).filter(Boolean),
    subagents.map((s) => s.map((l) => strip(l as TranscriptRecord, {}) as Record<string, unknown>)),
    gap,
  );

test("splits blocks and counts prompts, tokens, cost, lines, tools and PRs", () => {
  const s = parse([
    {
      type: "user",
      timestamp: "2026-10-01T10:00:00Z",
      version: "2.1.0",
      slug: "calm-fox",
      promptSource: "typed",
      cwd: "/w",
      message: { content: "edit it" },
    },
    // Two parts of one response repeat its usage; it must count once.
    {
      type: "assistant",
      timestamp: "2026-10-01T10:00:10Z",
      attributionSkill: "review",
      message: {
        id: "m1",
        model: "opus",
        usage: { input_tokens: 100, output_tokens: 10 },
        content: [{ type: "tool_use", name: "Edit", input: { file_path: "/w/a.go" } }],
      },
    },
    {
      type: "assistant",
      timestamp: "2026-10-01T10:00:11Z",
      message: {
        id: "m1",
        model: "opus",
        usage: { input_tokens: 100, output_tokens: 20 },
        content: [{ type: "tool_use", name: "Bash", input: { command: "sed -i s/a/b/ b.go" } }],
      },
    },
    {
      type: "user",
      timestamp: "2026-10-01T10:00:12Z",
      toolUseResult: { filePath: "/w/a.go", structuredPatch: [{ lines: [" ctx", "-old", "+new", "+more"] }] },
      message: { content: [{ type: "tool_result", content: "ok" }] },
    },
    {
      type: "user",
      timestamp: "2026-10-01T10:00:13Z",
      toolUseResult: {
        stdout: "",
        bashEditDiff: { files: [{ filePath: "/w/b.go", hunks: [{ lines: ["-x", "+y"] }] }] },
      },
      message: { content: [{ type: "tool_result", content: "ok" }] },
    },
    {
      type: "assistant",
      timestamp: "2026-10-01T10:00:20Z",
      attributionMcpServer: "example-mcp",
      message: {
        id: "m2",
        model: "<synthetic>",
        content: [{ type: "tool_use", name: "Write", input: { file_path: "/w/a.go" } }],
      },
    },
    {
      type: "user",
      timestamp: "2026-10-01T10:00:21Z",
      toolUseResult: { type: "create", filePath: "/w/c.go", content: "package c\n\nfunc C() {}\n" },
      message: { content: [{ type: "tool_result", content: "ok" }] },
    },
    { type: "system", subtype: "turn_duration", timestamp: "2026-10-01T10:01:00Z", durationMs: 60000 },
    {
      type: "user",
      timestamp: "2026-10-01T10:03:00Z",
      promptSource: "system",
      message: { content: "message from another session" },
    },
    { type: "system", subtype: "turn_duration", timestamp: "2026-10-01T10:04:00Z", durationMs: 60000 },
    {
      type: "pr-link",
      timestamp: "2026-10-01T10:04:30Z",
      prNumber: 7,
      prRepository: "o/r",
      prUrl: "https://github.com/o/r/pull/7",
    },
    {
      type: "pr-link",
      timestamp: "2026-10-01T10:04:40Z",
      prNumber: 7,
      prRepository: "o/r",
      prUrl: "https://github.com/o/r/pull/7",
    },
    { type: "user", timestamp: "2026-10-01T12:00:00Z", promptSource: "queued", message: { content: "next" } },
    {
      type: "assistant",
      timestamp: "2026-10-01T12:00:05Z",
      message: {
        id: "m3",
        model: "opus",
        usage: {
          input_tokens: 50,
          output_tokens: 10,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        },
        content: [],
      },
    },
    { type: "system", subtype: "api_error", timestamp: "2026-10-01T12:00:06Z" },
    { type: "system", subtype: "turn_duration", timestamp: "2026-10-01T12:00:30Z", durationMs: 30000 },
    // Written once at the end; the [1m] suffix is not in message model names, and haiku made background
    // calls that left no messages.
    {
      type: "cost-state",
      modelUsage: { "opus[1m]": { outputTokens: 30, costUSD: 3 }, haiku: { outputTokens: 5, costUSD: 1 } },
    },
  ]);

  expect(s).toMatchObject({ version: "2.1.0", slug: "calm-fox", cwd: "/w", title: "edit it" });
  expect(s.blocks).toHaveLength(2);
  const [b, b2] = s.blocks as [(typeof s.blocks)[0], (typeof s.blocks)[0]];
  expect(b.prompts).toBe(1);
  expect(b.activeMs).toBe(120000);
  expect(b.active).toEqual([{ start: t("2026-10-01T10:00:00Z"), end: t("2026-10-01T10:04:00Z") }]);
  expect(b.tokens?.opus).toMatchObject({ input: 100, output: 20 });
  // Weights: block 1 = 100 + 5*20 = 200, block 2 = 50 + 5*10 = 100.
  expect(b.costUSD).toBeCloseTo((3 * 2) / 3 + (1 * 2) / 3);
  expect(b2.costUSD).toBeCloseTo(3 / 3 + 1 / 3);
  expect([b.linesAdded, b.linesRemoved]).toEqual([2 + 4, 1]);
  expect(b.tools).toEqual({ Edit: 1, Bash: 1, Write: 1 });
  expect(b.files).toEqual(["/w/a.go", "/w/b.go", "/w/c.go"]);
  expect(b.models).toEqual({ opus: 2 });
  expect([b.skills, b.mcp]).toEqual([{ review: 1 }, { "example-mcp": 1 }]);
  expect(b.prs.map((p) => p.number)).toEqual([7]);
  expect([b2.prompts, b2.errors, b2.activeMs]).toEqual([1, 1, 30000]);
  expect(s.usage?.["opus[1m]"]?.outputTokens).toBe(30);
});

test("a cost total that restarted adds to what came before", () => {
  const s = parse([
    {
      type: "assistant",
      timestamp: "2026-10-01T10:00:00Z",
      message: { id: "m1", model: "opus", usage: { output_tokens: 10 }, content: [] },
    },
    { type: "cost-state", modelUsage: { opus: { costUSD: 2 } } },
    { type: "cost-state", modelUsage: { opus: { costUSD: 3 } } },
    { type: "cost-state", modelUsage: { opus: { costUSD: 0.5 } } },
  ]);
  expect(s.blocks[0]?.costUSD).toBe(3.5);
});

test("turns are estimated when there are no turn durations", () => {
  const s = parse(
    [
      { type: "user", timestamp: "2026-10-01T10:00:00Z", promptSource: "sdk", message: { content: "task 1" } },
      { type: "assistant", timestamp: "2026-10-01T10:00:30Z", message: { content: [] } },
      { type: "assistant", timestamp: "2026-10-01T10:01:00Z", message: { content: [] } },
      { type: "user", timestamp: "2026-10-01T10:20:00Z", promptSource: "sdk", message: { content: "task 2" } },
      { type: "assistant", timestamp: "2026-10-01T10:22:00Z", message: { content: [] } },
      { type: "user", timestamp: "2026-10-01T10:25:00Z", promptSource: "sdk", message: { content: "unanswered" } },
    ],
    HOUR,
  );
  expect(s.blocks[0]).toMatchObject({ activeEstimated: true, activeMs: (60 + 120) * 1000 });
  expect(s.blocks[0]?.active).toHaveLength(2);
});

test("titles fall back from ai-title to the first prompt to the last prompt", () => {
  expect(
    parse([
      { type: "user", timestamp: "2026-10-01T10:00:00Z", message: { content: "<command-name>/clear</command-name>" } },
      { type: "user", timestamp: "2026-10-01T10:00:01Z", message: { content: "fix the   flaky\ntest" } },
    ]).title,
  ).toBe("fix the flaky test");
  expect(
    parse([
      { type: "user", timestamp: "2026-10-01T10:00:00Z", message: { content: "first" } },
      { type: "ai-title", aiTitle: "Latest" },
    ]).title,
  ).toBe("Latest");
  expect(parse([{ type: "last-prompt", lastPrompt: "only this" }]).title).toBe("only this");
  expect(
    parse([{ type: "user", timestamp: "2026-10-01T10:00:00Z", message: { content: "あ".repeat(100) } }]).title,
  ).toBe(`${"あ".repeat(80)}…`);
});

test("subagents add tokens and tools to their parent's block, not messages", () => {
  const s = parse([{ type: "user", timestamp: "2026-10-01T10:00:00Z", message: { content: "go" } }], HOUR, [
    [
      {
        type: "assistant",
        timestamp: "2026-10-01T10:00:05Z",
        message: {
          id: "a1",
          model: "opus",
          usage: { output_tokens: 4 },
          content: [{ type: "tool_use", name: "Grep", input: {} }],
        },
      },
    ],
  ]);
  expect(s.blocks[0]).toMatchObject({ messages: 1, tools: { Grep: 1 }, tokens: { opus: { output: 4 } } });
});

test("sessions archived before records were kept are laid out from their messages", () => {
  const db = openDb(":memory:");
  db.run(
    `INSERT INTO sessions (id, file_path, project_dir, cwd, title, imported_bytes, import_version)
     VALUES ('old', '/gone/old.jsonl', 'p', '/work/repo', 'Old work', 10, 0)`,
  );
  db.run(
    `INSERT INTO messages (session, ts, role, tool, text) VALUES
       (1, '2026-09-01T10:00:00Z', 'user', NULL, 'do it'),
       (1, '2026-09-01T10:10:00Z', 'tool', 'Bash', '{}')`,
  );
  const sessions = new Calendar(db, 30 * 60_000).sessions();
  expect(sessions).toMatchObject([{ id: "old", cwd: "/work/repo", title: "Old work" }]);
  expect(sessions[0]?.blocks[0]).toMatchObject({ prompts: 1, messages: 2, tools: { Bash: 1 }, activeEstimated: true });

  const events = eventsBetween(sessions, t("2026-09-01T00:00:00Z"), t("2026-09-02T00:00:00Z"));
  expect(events.map((e) => e.id)).toEqual(["old#0"]);
  expect(eventsBetween(sessions, t("2026-09-02T00:00:00Z"), t("2026-09-03T00:00:00Z"))).toEqual([]);
});
