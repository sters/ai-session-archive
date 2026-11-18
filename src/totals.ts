import type { Block, Interval } from "./calendar";

// Totals over calendar blocks for a time range, shared by the calendar page and the stored period stats.
// Runs in the browser too, so it imports types only.

export type Totals = {
  sessions: number;
  prompts: number;
  // Time Claude was running inside the range. Sessions running in parallel are each counted.
  activeMs: number;
  costUSD: number;
  linesAdded: number;
  linesRemoved: number;
  prs: number;
};

export type BlockOf = { session: string; block: Block };

// Time is measured inside [from, to), so a block running past midnight counts towards both days. Sessions, prompts,
// cost, lines and PRs belong to the range their block starts in.
export function totals(blocks: BlockOf[], from: number, to: number): Totals {
  const t: Totals = { sessions: 0, prompts: 0, activeMs: 0, costUSD: 0, linesAdded: 0, linesRemoved: 0, prs: 0 };
  const sessions = new Set<string>();
  for (const { session, block: b } of blocks) {
    for (const iv of b.active) t.activeMs += clippedMs(iv, from, to);
    if (b.start < from || b.start >= to) continue;
    sessions.add(session);
    t.prompts += b.prompts;
    t.costUSD += b.costUSD;
    t.linesAdded += b.linesAdded;
    t.linesRemoved += b.linesRemoved;
    t.prs += b.prs.length;
  }
  t.sessions = sessions.size;
  return t;
}

const clippedMs = (iv: Interval, from: number, to: number) =>
  Math.max(0, Math.min(iv.end, to) - Math.max(iv.start, from));

// One line of a period's stats, for the CLI and the summaries page.
export function statsLine(t: Totals): string {
  const n = (v: number, digits = 0) =>
    v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return [
    `${n(t.sessions)} sessions`,
    `${n(t.prompts)} prompts`,
    `active ${n(t.activeMs / 3_600_000, 1)}h`,
    `$${n(t.costUSD, 2)}`,
    `${n(t.prs)} PRs`,
    `+${n(t.linesAdded)} −${n(t.linesRemoved)} lines`,
  ].join(" · ");
}
