import type { Database } from "bun:sqlite";
import { IMPORT_VERSION } from "./sync";

// Splits sessions into blocks of activity for the calendar page, from the `records` table.

const FALLBACK_TITLE_CHARS = 80;
// Turns separated by less than this are merged into one active interval, so a quick back-and-forth
// reads as one stretch of work.
const ACTIVE_JOIN_MS = 5 * 60_000;
// Keeps a block made of a single message visible on the calendar.
const MIN_EVENT_MS = 5 * 60_000;

// Relative prices of each token kind against uncached input, used only to split a model's session
// cost across blocks. The session total stays the cost-state figure; prices that vary per message
// (fast mode, long context) make the split approximate.
const WEIGHT = { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 };

export type TokenCounts = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
};
export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
};
// Times are epoch milliseconds.
export type Interval = { start: number; end: number };
export type PR = { number: number; repository: string; url: string; at: number };
type Counts = Record<string, number>;

export type Block = {
  start: number;
  end: number;
  prompts: number;
  messages: number;
  // Time Claude spent working on turns in this block, and those turns merged when close together.
  // activeEstimated is set when the transcript has no turn durations (SDK runs, older Claude Code,
  // sessions archived before records were kept); each turn then runs from a prompt to the last
  // message before the next one.
  activeMs: number;
  active: Interval[];
  activeEstimated?: boolean;
  // This block's share of the session cost, split by tokens.
  costUSD: number;
  tokens?: Record<string, TokenCounts>;
  linesAdded: number;
  linesRemoved: number;
  tools?: Counts;
  models?: Counts;
  skills?: Counts;
  mcp?: Counts;
  files: string[];
  prs: PR[];
  errors: number;
};

export type CalendarSession = {
  id: string;
  cwd: string;
  branch: string;
  title: string;
  // "cli" for an interactive session, "sdk-cli" for one driven by a program through the SDK.
  entrypoint: string;
  version: string;
  slug: string;
  // Per-model usage from the session's last cost-state; absent while a session runs or when it
  // ended without writing one.
  usage?: Record<string, ModelUsage>;
  // Set when the blocks' cost was estimated from their tokens because there is no cost-state.
  costEstimated?: boolean;
  blocks: Block[];
};

type Rec = Record<string, unknown>;
type Activity = {
  at: number;
  isPrompt: boolean;
  model: string;
  skill: string;
  mcp: string;
  tools: string[];
  files: string[];
  linesAdded: number;
  linesRemoved: number;
};
type ApiMessage = { at: number; model: string; counts: TokenCounts };
// Something that happened at a point in time, credited to whichever block that time falls in.
type Extra = {
  at: number;
  turn?: Interval;
  pr?: PR;
  apiError?: boolean;
  tools?: string[];
  files?: string[];
  linesAdded?: number;
  linesRemoved?: number;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const obj = (v: unknown): Rec | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Rec) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
// 0 stands for a missing time; such a record is credited to the first block.
const time = (v: unknown): number => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? 0 : t;
};

const zero = (): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
const addCounts = (a: TokenCounts, b: TokenCounts): TokenCounts => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
  cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
});
const weight = (t: TokenCounts) =>
  WEIGHT.input * t.input +
  WEIGHT.output * t.output +
  WEIGHT.cacheRead * t.cacheRead +
  WEIGHT.cacheWrite5m * t.cacheWrite5m +
  WEIGHT.cacheWrite1h * t.cacheWrite1h;

function usageCounts(u: Rec): TokenCounts {
  const c = {
    ...zero(),
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
  };
  const cc = obj(u.cache_creation);
  if (cc) {
    c.cacheWrite5m = num(cc.ephemeral_5m_input_tokens);
    c.cacheWrite1h = num(cc.ephemeral_1h_input_tokens);
  } else {
    c.cacheWrite5m = num(u.cache_creation_input_tokens);
  }
  return c;
}

// Whether a message came from a model rather than from Claude Code itself, which marks those "<synthetic>".
const realModel = (m: string) => m !== "" && !m.startsWith("<");
// Strips a variant suffix such as "[1m]", which cost-state keeps in model names but API messages do not.
const baseModel = (m: string) => (m.includes("[") ? m.slice(0, m.indexOf("[")) : m);

function inc(m: Counts | undefined, key: string): Counts | undefined {
  if (!key) return m;
  m ??= {};
  m[key] = (m[key] ?? 0) + 1;
  return m;
}

// The text of a user message's content, or null when it is a tool result fed back to the model.
function promptText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  let text = "";
  for (const p of content) {
    const part = obj(p);
    if (part?.type === "tool_result") return null;
    if (part?.type === "text" && !text) text = str(part.text);
  }
  return text || null;
}

// The text of an instruction given to the session, as opposed to a tool result, a meta message, or a
// message sent by another session or a scheduler. Older transcripts have no promptSource.
function prompt(l: Rec): string | null {
  if (l.isMeta === true || l.isCompactSummary === true) return null;
  const text = promptText(obj(l.message)?.content);
  if (text === null) return null;
  return ["", "typed", "queued", "sdk"].includes(str(l.promptSource)) ? text : null;
}

function toolUses(content: unknown): { tools: string[]; files: string[] } {
  const tools: string[] = [];
  const files: string[] = [];
  for (const p of arr(content)) {
    const part = obj(p);
    const name = str(part?.name);
    if (part?.type !== "tool_use" || !name) continue;
    tools.push(name);
    const input = obj(part.input);
    const file = ["Edit", "MultiEdit", "Write"].includes(name)
      ? str(input?.file_path)
      : name === "NotebookEdit"
        ? str(input?.notebook_path)
        : "";
    if (file) files.push(file);
  }
  return { tools, files };
}

// The files a tool result changed and the lines it added and removed, counted the way Claude Code's
// own totals count them: from edit tools only, with a created file's trailing newline starting one
// more line. Files changed by a Bash command are listed but their lines are not counted.
function fileChanges(raw: unknown): { files: string[]; added: number; removed: number } {
  const r = obj(raw);
  const out = { files: [] as string[], added: 0, removed: 0 };
  if (!r) return out;
  const path = str(r.filePath);
  const patch = arr(r.structuredPatch);
  if (r.type === "create" && path) {
    out.files.push(path);
    out.added = str(r.content).split("\n").length;
  } else if (patch.length > 0 && path) {
    out.files.push(path);
    for (const h of patch) {
      for (const line of arr(obj(h)?.lines)) {
        if (str(line).startsWith("+")) out.added++;
        else if (str(line).startsWith("-")) out.removed++;
      }
    }
  }
  for (const f of arr(obj(r.bashEditDiff)?.files)) {
    const p = str(obj(f)?.filePath);
    if (p) out.files.push(p);
  }
  return out;
}

function truncate(s: string, n: number): string {
  const t = s.split(/\s+/).filter(Boolean).join(" ");
  const chars = [...t];
  return chars.length <= n ? t : `${chars.slice(0, n).join("")}…`;
}

// The index of the last block starting at or before t, or 0 when t comes before every block.
function blockAt(blocks: Block[], t: number): number {
  let lo = 0;
  let hi = blocks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid]!.start > t) hi = mid;
    else lo = mid + 1;
  }
  return Math.max(lo - 1, 0);
}

function mergeIntervals(ivs: Interval[], join: number): Interval[] {
  if (ivs.length === 0) return [];
  const sorted = [...ivs].sort((a, b) => a.start - b.start);
  const out = [{ ...sorted[0]! }];
  for (const iv of sorted.slice(1)) {
    const last = out[out.length - 1]!;
    if (iv.start - last.end <= join) last.end = Math.max(last.end, iv.end);
    else out.push({ ...iv });
  }
  return out;
}

class Parser {
  session: CalendarSession;
  acts: Activity[] = [];
  extras: Extra[] = [];
  apiMessages = new Map<string, ApiMessage>();
  // Each model's session cost, accumulated over cost-states so a total that restarted from zero still adds up.
  modelCost = new Map<string, number>();
  lastModelCost = new Map<string, number>();
  lastPrompt = "";
  firstPrompt = "";

  constructor(id: string) {
    this.session = { id, cwd: "", branch: "", title: "", entrypoint: "", version: "", slug: "", blocks: [] };
  }

  line(l: Rec) {
    if (str(l.slug)) this.session.slug = str(l.slug);
    switch (l.type) {
      case "ai-title":
        this.session.title = str(l.aiTitle);
        break;
      case "last-prompt":
        this.lastPrompt = str(l.lastPrompt);
        break;
      case "user":
      case "assistant":
        this.message(l);
        break;
      case "system":
        this.system(l);
        break;
      case "pr-link":
        if (str(l.prUrl)) {
          const at = time(l.timestamp);
          this.extras.push({
            at,
            pr: { number: num(l.prNumber), repository: str(l.prRepository), url: str(l.prUrl), at },
          });
        }
        break;
      case "cost-state":
        this.costState(l);
        break;
    }
  }

  // A subagent works inside its parent's blocks, so it adds no messages, prompts or blocks of its own.
  subagentLine(l: Rec) {
    const at = time(l.timestamp);
    if (!at) return;
    const e: Extra = { at };
    if (l.type === "user") {
      const c = fileChanges(l.toolUseResult);
      Object.assign(e, { files: c.files, linesAdded: c.added, linesRemoved: c.removed });
    } else if (l.type === "assistant") {
      if (realModel(str(obj(l.message)?.model))) this.apiMessage(l, at);
      Object.assign(e, toolUses(obj(l.message)?.content));
    } else {
      return;
    }
    if (e.tools?.length || e.files?.length || e.linesAdded || e.linesRemoved) this.extras.push(e);
  }

  message(l: Rec) {
    const s = this.session;
    s.cwd ||= str(l.cwd);
    s.entrypoint ||= str(l.entrypoint);
    if (str(l.gitBranch)) s.branch = str(l.gitBranch);
    if (str(l.version)) s.version = str(l.version);
    const at = time(l.timestamp);
    if (!at) return;
    const a: Activity = {
      at,
      isPrompt: false,
      model: "",
      skill: "",
      mcp: "",
      tools: [],
      files: [],
      linesAdded: 0,
      linesRemoved: 0,
    };
    const m = obj(l.message);
    if (l.type === "user") {
      const text = prompt(l);
      if (text !== null) {
        a.isPrompt = true;
        if (!this.firstPrompt && !text.startsWith("<")) this.firstPrompt = text;
      }
      const c = fileChanges(l.toolUseResult);
      Object.assign(a, { files: c.files, linesAdded: c.added, linesRemoved: c.removed });
    } else {
      if (realModel(str(m?.model))) {
        a.model = str(m?.model);
        this.apiMessage(l, at);
      }
      a.skill = str(l.attributionSkill);
      a.mcp = str(l.attributionMcpServer);
      Object.assign(a, toolUses(m?.content));
    }
    this.acts.push(a);
  }

  system(l: Rec) {
    const at = time(l.timestamp);
    if (l.subtype === "turn_duration") {
      // Stamped when the turn ends.
      const ms = num(l.durationMs);
      if (!at || ms <= 0) return;
      this.extras.push({ at, turn: { start: at - ms, end: at } });
    } else if (l.subtype === "api_error") {
      this.extras.push({ at, apiError: true });
    }
  }

  // A response's usage is repeated on every line carrying a part of it; it is recorded at the time of
  // its first part, with the counts of its last part, which has the final output token count.
  apiMessage(l: Rec, at: number) {
    const m = obj(l.message);
    const id = str(m?.id);
    const usage = obj(m?.usage);
    if (!id || !usage) return;
    let am = this.apiMessages.get(id);
    if (!am) {
      am = { at, model: str(m?.model), counts: zero() };
      this.apiMessages.set(id, am);
    }
    am.counts = usageCounts(usage);
  }

  // cost-state carries running totals and is written only now and then, often once at the end.
  costState(l: Rec) {
    const mu = obj(l.modelUsage);
    if (!mu || Object.keys(mu).length === 0) return;
    const usage: Record<string, ModelUsage> = {};
    for (const [model, v] of Object.entries(mu)) {
      const u = obj(v);
      const cost = num(u?.costUSD);
      usage[model] = {
        inputTokens: num(u?.inputTokens),
        outputTokens: num(u?.outputTokens),
        cacheReadInputTokens: num(u?.cacheReadInputTokens),
        cacheCreationInputTokens: num(u?.cacheCreationInputTokens),
        costUSD: cost,
      };
      let prev = this.lastModelCost.get(model) ?? 0;
      // The total restarted from zero.
      if (cost < prev) prev = 0;
      this.modelCost.set(model, (this.modelCost.get(model) ?? 0) + cost - prev);
      this.lastModelCost.set(model, cost);
    }
    this.session.usage = usage;
  }

  finish(gap: number): CalendarSession {
    const s = this.session;
    s.title = truncate(s.title || this.firstPrompt || this.lastPrompt, FALLBACK_TITLE_CHARS);
    s.blocks = splitBlocks(this.acts, gap);
    if (s.blocks.length === 0) return s;
    applyExtras(s.blocks, this.extras);
    estimateTurns(s.blocks, this.acts);
    for (const m of this.apiMessages.values()) {
      const b = s.blocks[blockAt(s.blocks, m.at)]!;
      b.tokens ??= {};
      b.tokens[m.model] = addCounts(b.tokens[m.model] ?? zero(), m.counts);
    }
    allocateCost(s.blocks, this.modelCost);
    return s;
  }
}

function newBlock(at: number): Block {
  return {
    start: at,
    end: at,
    prompts: 0,
    messages: 0,
    activeMs: 0,
    active: [],
    costUSD: 0,
    linesAdded: 0,
    linesRemoved: 0,
    files: [],
    prs: [],
    errors: 0,
  };
}

// Splits activity into blocks wherever two consecutive messages are more than gap apart. Sorts acts.
function splitBlocks(acts: Activity[], gap: number): Block[] {
  if (acts.length === 0) return [];
  acts.sort((a, b) => a.at - b.at);
  const blocks: Block[] = [];
  let cur = newBlock(acts[0]!.at);
  for (const a of acts) {
    if (a.at - cur.end > gap) {
      blocks.push(cur);
      cur = newBlock(a.at);
    }
    cur.end = a.at;
    cur.messages++;
    cur.linesAdded += a.linesAdded;
    cur.linesRemoved += a.linesRemoved;
    if (a.isPrompt) cur.prompts++;
    cur.models = inc(cur.models, a.model);
    cur.skills = inc(cur.skills, a.skill);
    cur.mcp = inc(cur.mcp, a.mcp);
    for (const t of a.tools) cur.tools = inc(cur.tools, t);
    cur.files.push(...a.files);
  }
  blocks.push(cur);
  return blocks;
}

function applyExtras(blocks: Block[], extras: Extra[]) {
  const seenPR = new Set<string>();
  for (const e of extras) {
    const b = blocks[blockAt(blocks, e.at)]!;
    if (e.turn) {
      const t = { start: Math.max(e.turn.start, b.start), end: e.turn.end };
      b.activeMs += t.end - t.start;
      b.active.push(t);
    } else if (e.pr) {
      if (!seenPR.has(e.pr.url)) {
        seenPR.add(e.pr.url);
        b.prs.push(e.pr);
      }
    } else if (e.apiError) {
      b.errors++;
    } else {
      for (const t of e.tools ?? []) b.tools = inc(b.tools, t);
      b.files.push(...(e.files ?? []));
      b.linesAdded += e.linesAdded ?? 0;
      b.linesRemoved += e.linesRemoved ?? 0;
    }
  }
  for (const b of blocks) {
    b.active = mergeIntervals(b.active, ACTIVE_JOIN_MS);
    b.files = [...new Set(b.files)];
  }
}

// Fills in the turns of blocks that have no turn durations. acts must be sorted.
function estimateTurns(blocks: Block[], acts: Activity[]) {
  const turns: Interval[][] = blocks.map(() => []);
  let cur: Interval | null = null;
  let curBlk = -1;
  const close = () => {
    if (cur && cur.end > cur.start) turns[curBlk]!.push(cur);
    cur = null;
  };
  for (const a of acts) {
    const i = blockAt(blocks, a.at);
    if (blocks[i]!.active.length > 0) continue;
    if (i !== curBlk || a.isPrompt) {
      close();
      curBlk = i;
      cur = { start: a.at, end: a.at };
      continue;
    }
    if (cur) (cur as Interval).end = a.at;
  }
  close();
  turns.forEach((ts, i) => {
    if (ts.length === 0) return;
    const b = blocks[i]!;
    for (const t of ts) b.activeMs += t.end - t.start;
    b.active = mergeIntervals(ts, ACTIVE_JOIN_MS);
    b.activeEstimated = true;
  });
}

// Splits each model's session cost across blocks by that model's weighted tokens in each block. A model
// with no messages in the transcript, such as one used for background calls, is split by every model's
// tokens instead.
function allocateCost(blocks: Block[], modelCost: Map<string, number>) {
  const byModel = new Map<string, number[]>();
  const all = blocks.map(() => 0);
  blocks.forEach((b, i) => {
    for (const [model, t] of Object.entries(b.tokens ?? {})) {
      const w = byModel.get(model) ?? blocks.map(() => 0);
      byModel.set(model, w);
      w[i]! += weight(t);
      all[i]! += weight(t);
    }
  });
  const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  for (const [model, cost] of modelCost) {
    let weights = byModel.get(baseModel(model)) ?? [];
    if (total(weights) === 0) weights = all;
    const w = total(weights);
    if (w === 0) {
      blocks[blocks.length - 1]!.costUSD += cost;
      continue;
    }
    blocks.forEach((b, i) => (b.costUSD += (cost * weights[i]!) / w));
  }
}

export function parseSession(id: string, lines: Rec[], subagents: Rec[][], gap: number): CalendarSession {
  const p = new Parser(id);
  for (const l of lines) p.line(l);
  for (const sub of subagents) for (const l of sub) p.subagentLine(l);
  return p.finish(gap);
}

// Each model's cost per weighted token over the sessions whose cost-state reports a cost for it.
function pricePerWeight(sessions: CalendarSession[]): Map<string, number> {
  const cost = new Map<string, number>();
  const w = new Map<string, number>();
  for (const s of sessions) {
    for (const [model, u] of Object.entries(s.usage ?? {})) {
      const base = baseModel(model);
      const sw = s.blocks.reduce((t, b) => t + (b.tokens?.[base] ? weight(b.tokens[base]) : 0), 0);
      if (sw > 0 && u.costUSD > 0) {
        cost.set(base, (cost.get(base) ?? 0) + u.costUSD);
        w.set(base, (w.get(base) ?? 0) + sw);
      }
    }
  }
  return new Map([...cost].map(([m, c]) => [m, c / w.get(m)!]));
}

function estimateCost(s: CalendarSession, prices: Map<string, number>): CalendarSession {
  let estimated = false;
  const blocks = s.blocks.map((b) => {
    let cost = b.costUSD;
    for (const [model, t] of Object.entries(b.tokens ?? {})) {
      const p = prices.get(model);
      if (p !== undefined) {
        cost += weight(t) * p;
        estimated = true;
      }
    }
    return { ...b, costUSD: cost };
  });
  return { ...s, blocks, costEstimated: estimated || undefined };
}

type SessionMeta = {
  rowid: number;
  id: string;
  parent_id: string | null;
  cwd: string | null;
  git_branch: string | null;
  title: string | null;
  imported_bytes: number;
  import_version: number;
};

// Keeps the parsed sessions between requests and re-parses only those whose main or subagent
// transcripts were imported further since. Parsed sessions are held in memory, all at once.
export class Calendar {
  private cache = new Map<number, { key: string; session: CalendarSession }>();

  constructor(
    private db: Database,
    private gap: number,
  ) {}

  sessions(): CalendarSession[] {
    const rows = this.db
      .query<SessionMeta, []>(
        // A response can appear in several subagent transcripts; reading them in path order makes the
        // one whose usage counts deterministic.
        "SELECT rowid, id, parent_id, cwd, git_branch, title, imported_bytes, import_version FROM sessions ORDER BY file_path",
      )
      .all();
    const subs = new Map<string, SessionMeta[]>();
    for (const r of rows) if (r.parent_id) subs.set(r.parent_id, [...(subs.get(r.parent_id) ?? []), r]);
    const next = new Map<number, { key: string; session: CalendarSession }>();
    for (const r of rows) {
      if (r.parent_id) continue;
      const mine = subs.get(r.id) ?? [];
      const key = [r, ...mine].map((x) => `${x.rowid}:${x.imported_bytes}:${x.import_version}`).join(",");
      const hit = this.cache.get(r.rowid);
      next.set(r.rowid, hit?.key === key ? hit : { key, session: this.load(r, mine) });
    }
    this.cache = next;
    const sessions = [...next.values()].map((e) => e.session);
    const prices = pricePerWeight(sessions);
    return sessions.map((s) => (s.usage ? s : estimateCost(s, prices)));
  }

  private load(r: SessionMeta, subagents: SessionMeta[]): CalendarSession {
    const s = parseSession(
      r.id,
      this.records(r),
      subagents.map((a) => this.records(a)),
      this.gap,
    );
    s.cwd ||= r.cwd ?? "";
    s.branch ||= r.git_branch ?? "";
    // The ai-title, which a session archived from its messages alone has nowhere else.
    if (r.title) s.title = r.title;
    return s;
  }

  // A session imported before records were kept, whose transcript is gone, still has its messages;
  // they are turned into records that give its blocks, prompts and tools.
  private records(r: SessionMeta): Rec[] {
    if (r.import_version >= IMPORT_VERSION) {
      return this.db
        .query<{ data: string }, [number]>("SELECT data FROM records WHERE session = ? ORDER BY id")
        .all(r.rowid)
        .map((x) => JSON.parse(x.data) as Rec);
    }
    return this.db
      .query<{ ts: string | null; role: string; tool: string | null; text: string }, [number]>(
        "SELECT ts, role, tool, text FROM messages WHERE session = ? ORDER BY id",
      )
      .all(r.rowid)
      .map((m) =>
        m.role === "user"
          ? { type: "user", timestamp: m.ts, message: { content: m.text } }
          : {
              type: "assistant",
              timestamp: m.ts,
              message: { content: m.role === "tool" ? [{ type: "tool_use", name: m.tool }] : [] },
            },
      );
  }
}

export type CalendarEvent = {
  id: string;
  title: string;
  start: number;
  end: number;
  extendedProps: { session: SessionInfo; block: Block };
};

// A session without its blocks, plus totals over all of them.
export type SessionInfo = Omit<CalendarSession, "blocks" | "title"> & {
  blocks: number;
  costUSD: number;
  activeMs: number;
  linesAdded: number;
  linesRemoved: number;
  prs: PR[];
};

function sessionInfo(s: CalendarSession): SessionInfo {
  const { blocks, title: _, ...rest } = s;
  return {
    ...rest,
    blocks: blocks.length,
    costUSD: blocks.reduce((t, b) => t + b.costUSD, 0),
    activeMs: blocks.reduce((t, b) => t + b.activeMs, 0),
    linesAdded: blocks.reduce((t, b) => t + b.linesAdded, 0),
    linesRemoved: blocks.reduce((t, b) => t + b.linesRemoved, 0),
    prs: blocks.flatMap((b) => b.prs),
  };
}

export function eventsBetween(sessions: CalendarSession[], start: number, end: number): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  for (const s of sessions) {
    let info: SessionInfo | null = null;
    s.blocks.forEach((b, i) => {
      const shownEnd = Math.max(b.end, b.start + MIN_EVENT_MS);
      if (shownEnd <= start || b.start >= end) return;
      info ??= sessionInfo(s);
      events.push({
        id: `${s.id}#${i}`,
        title: s.title,
        start: b.start,
        end: shownEnd,
        extendedProps: { session: info, block: b },
      });
    });
  }
  return events.sort((a, b) => a.start - b.start);
}
