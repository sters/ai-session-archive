/// <reference lib="dom" />
import type { CalendarEvent, Interval, ModelUsage, PR } from "../calendar";

// The part of FullCalendar's global build that this page uses; it is loaded from jsDelivr.
type FcEvent = {
  title: string;
  extendedProps: CalendarEvent["extendedProps"] & { summary?: boolean; lines?: string[] };
};
type FcInput = Record<string, unknown>;
type FcCalendar = { render(): void; refetchEvents(): void };
declare const FullCalendar: { Calendar: new (el: HTMLElement, options: Record<string, unknown>) => FcCalendar };

const HIDDEN_KEY = "calendar.hiddenProjects";
const SHOW_SDK_KEY = "calendar.showSdk";
const MODE_KEY = "calendar.mode";
const REFRESH_MS = 60_000;
const MIN_EVENT_MS = 5 * 60_000;
const FILES_SHOWN = 15;
const ACTIVE_HINT = "Total time Claude was running. Sessions running in parallel are each counted";

function load<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? "null") as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable
  }
}

const hidden = new Set(load<string[]>(HIDDEN_KEY, []));
let showSdk = load(SHOW_SDK_KEY, false);
let mode = load<"block" | "active">(MODE_KEY, "block");
let lastEvents: CalendarEvent[] = [];
let range = { start: new Date(), end: new Date() };

type Child = Node | string | number | null | undefined | false | Child[];
function h(tag: string, props?: Record<string, string> | null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity as 1)) {
    if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  }
  return el;
}
const byId = (id: string) => document.getElementById(id)!;

const isSdk = (e: CalendarEvent) => e.extendedProps.session.entrypoint === "sdk-cli";
const visible = () => lastEvents.filter((e) => (showSdk || !isSdk(e)) && !hidden.has(e.extendedProps.session.cwd));

const projectLabel = (cwd: string) => (cwd ? cwd.split("/").filter(Boolean).slice(-2).join("/") : "(unknown)");

// FNV-1a with a final avalanche, so paths sharing a long prefix still land on distant hues.
function hue(s: string) {
  let x = 0x811c9dc5;
  for (const c of s) x = Math.imul(x ^ c.codePointAt(0)!, 0x01000193);
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) % 360;
}
const colorOf = (cwd: string) => `hsl(${hue(cwd || "")} 55% 48%)`;

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const usd = (v: number | undefined) => `$${(v ?? 0).toFixed(2)}`;
const int = (v: number | undefined) => (v ?? 0).toLocaleString("en-US");
function dur(ms: number) {
  if (!ms) return "0m";
  const m = Math.round(ms / 60000);
  if (m < 1) return `${Math.round(ms / 1000)}s`;
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
const hours = (ms: number) => `${(ms / 3_600_000).toFixed(1)}h`;
function compact(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
const est = (on: boolean | undefined) => (on ? h("span", { class: "est", text: "estimated" }) : null);
const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const sortedEntries = (m: Record<string, number> | undefined) => Object.entries(m ?? {}).sort((a, b) => b[1] - a[1]);
const safeUrl = (u: string) => (/^https:\/\//.test(u) ? u : null);

const timeFmt = new Intl.DateTimeFormat("en-US", {
  month: "numeric",
  day: "numeric",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const hmFmt = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

// Active intervals of the events, clipped to [from, to).
function activeWithin(events: CalendarEvent[], from: number, to: number): Interval[] {
  const out: Interval[] = [];
  for (const e of events) {
    for (const iv of e.extendedProps.block.active) {
      const start = Math.max(iv.start, from);
      const end = Math.min(iv.end, to);
      if (end > start) out.push({ start, end });
    }
  }
  return out;
}
const sumMs = (ivs: Interval[]) => ivs.reduce((t, iv) => t + (iv.end - iv.start), 0);

// Time is measured inside [from, to); cost, prompts, lines and PRs belong to the day their block starts.
function sum(events: CalendarEvent[], from: number, to: number) {
  const t = {
    sessions: new Set<string>(),
    activeMs: sumMs(activeWithin(events, from, to)),
    costUSD: 0,
    prompts: 0,
    linesAdded: 0,
    linesRemoved: 0,
    prs: 0,
  };
  for (const e of events) {
    const b = e.extendedProps.block;
    t.sessions.add(e.extendedProps.session.id);
    t.costUSD += b.costUSD;
    t.prompts += b.prompts;
    t.linesAdded += b.linesAdded;
    t.linesRemoved += b.linesRemoved;
    t.prs += b.prs.length;
  }
  return t;
}

function renderTotals(events: CalendarEvent[]) {
  const t = sum(events, range.start.getTime(), range.end.getTime());
  const cell = (k: string, v: Child, attrs?: Record<string, string>) =>
    h("div", attrs, h("div", { class: "k", text: k }), v);
  byId("totals").replaceChildren(
    cell("Active", h("div", { class: "v num", text: hours(t.activeMs) }), { title: ACTIVE_HINT }),
    cell("Cost", h("div", { class: "v num", text: usd(t.costUSD) }), { title: "API-price equivalent" }),
    cell("Sessions", h("div", { class: "v num", text: int(t.sessions.size) })),
    cell("Prompts", h("div", { class: "v num", text: int(t.prompts) })),
    cell("PRs", h("div", { class: "v num", text: int(t.prs) })),
    cell("Changed lines", [
      h("div", { class: "v num add", text: `+${int(t.linesAdded)}` }),
      h("div", { class: "v num del", text: `−${int(t.linesRemoved)}` }),
    ]),
  );
  fitValues();
}

const MAX_VALUE_PX = 18;
const MIN_VALUE_PX = 10;
function fitValues() {
  for (const el of document.querySelectorAll<HTMLElement>(".totals .v")) {
    let px = MAX_VALUE_PX;
    el.style.fontSize = `${px}px`;
    while (el.scrollWidth > el.clientWidth && px > MIN_VALUE_PX) {
      px -= 1;
      el.style.fontSize = `${px}px`;
    }
  }
}
window.addEventListener("resize", fitValues);

function renderProjects() {
  const counts = new Map<string, number>();
  for (const e of lastEvents) {
    if (!showSdk && isSdk(e)) continue;
    const cwd = e.extendedProps.session.cwd;
    counts.set(cwd, (counts.get(cwd) ?? 0) + 1);
  }
  byId("projects").replaceChildren(
    ...[...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cwd, n]) => {
        const input = h("input", { type: "checkbox" }) as HTMLInputElement;
        input.checked = !hidden.has(cwd);
        input.addEventListener("change", () => {
          if (input.checked) hidden.delete(cwd);
          else hidden.add(cwd);
          save(HIDDEN_KEY, [...hidden]);
          calendar.refetchEvents();
        });
        const sw = h("span", { class: "swatch" });
        sw.style.background = colorOf(cwd);
        return h(
          "li",
          { title: cwd },
          h(
            "label",
            {},
            input,
            sw,
            h("span", { class: "name", text: projectLabel(cwd) }),
            h("span", { class: "count num", text: String(n) }),
          ),
        );
      }),
  );
  byId("sdk-count").textContent = String(lastEvents.filter(isSdk).length);
}

function dailySummaries(events: CalendarEvent[]): FcInput[] {
  const byDay = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    const k = dayKey(new Date(e.start));
    byDay.set(k, [...(byDay.get(k) ?? []), e]);
  }
  return [...byDay.entries()].map(([day, evs]) => {
    const from = new Date(`${day}T00:00:00`);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    const t = sum(evs, from.getTime(), to.getTime());
    // Blocks that started the day before can still run into this day.
    const active = sumMs(activeWithin(events, from.getTime(), to.getTime()));
    const parts = [`Active ${hours(active)}`, usd(t.costUSD)];
    if (t.prs) parts.push(`PR ${t.prs}`);
    return {
      id: `summary-${day}`,
      title: parts.join(" · "),
      start: day,
      allDay: true,
      classNames: ["summary-event"],
      order: 0,
      extendedProps: { summary: true, lines: parts },
    };
  });
}

function toCalendarEvents(events: CalendarEvent[]): FcInput[] {
  const out: FcInput[] = [];
  for (const e of events) {
    const base = { ...e, color: colorOf(e.extendedProps.session.cwd), order: 1 };
    const active = e.extendedProps.block.active;
    if (mode !== "active") {
      out.push(base);
    } else if (active.length === 0) {
      out.push({ ...base, classNames: ["no-turns"] });
    } else {
      active.forEach((iv, i) => {
        out.push({ ...base, id: `${e.id}~${i}`, start: iv.start, end: Math.max(iv.end, iv.start + MIN_EVENT_MS) });
      });
    }
  }
  return out;
}

const detail = byId("detail");
// A click anywhere on the calendar closes the pane; a click on another session's event is handled by
// eventClick, which switches the pane instead.
document.querySelector("main")!.addEventListener("click", (ev) => {
  if ((ev.target as Element).closest(".fc-event:not(.summary-event)")) return;
  detail.hidden = true;
});
detail.querySelector(".close")!.addEventListener("click", () => (detail.hidden = true));
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") detail.hidden = true;
});

function chips(map: Record<string, number> | undefined) {
  const entries = sortedEntries(map);
  if (!entries.length) return h("span", { class: "muted", text: "-" });
  return h(
    "div",
    { class: "chips" },
    entries.map(([k, n]) => h("span", { class: "chip" }, k, h("span", { class: "n num", text: String(n) }))),
  );
}

function prList(prs: PR[]) {
  if (!prs.length) return h("span", { class: "muted", text: "-" });
  return h(
    "div",
    {},
    prs.map((p) => {
      const label = `${p.repository}#${p.number}`;
      const url = safeUrl(p.url);
      return h(
        "div",
        {},
        url ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer", text: label }) : label,
      );
    }),
  );
}

function fileList(files: string[], cwd: string) {
  if (!files.length) return h("span", { class: "muted", text: "-" });
  const rel = (f: string) => (cwd && f.startsWith(`${cwd}/`) ? f.slice(cwd.length + 1) : f);
  const li = (f: string) => h("li", { title: f, text: rel(f) });
  const rest = files.slice(FILES_SHOWN);
  return h(
    "div",
    {},
    h("ul", { class: "files" }, files.slice(0, FILES_SHOWN).map(li)),
    rest.length
      ? h("details", {}, h("summary", { text: `${rest.length} more` }), h("ul", { class: "files" }, rest.map(li)))
      : null,
  );
}

function lines(added: number, removed: number) {
  return h(
    "span",
    { class: "num" },
    h("span", { class: "add", text: `+${int(added)}` }),
    " ",
    h("span", { class: "del", text: `−${int(removed)}` }),
  );
}

function usageTable(usage: Record<string, ModelUsage> | undefined) {
  const rows = Object.entries(usage ?? {});
  if (!rows.length) return null;
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      { class: "usage num" },
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          ["Model", "Input", "Output", "Cache read", "Cache write", "Cost"].map((c) => h("th", { text: c })),
        ),
      ),
      h(
        "tbody",
        {},
        rows.map(([model, u]) =>
          h(
            "tr",
            {},
            h("td", { text: model }),
            h("td", { text: int(u.inputTokens) }),
            h("td", { text: int(u.outputTokens) }),
            h("td", { text: int(u.cacheReadInputTokens) }),
            h("td", { text: int(u.cacheCreationInputTokens) }),
            h("td", { text: usd(u.costUSD) }),
          ),
        ),
      ),
    ),
  );
}

function showDetail(ev: FcEvent) {
  const { session: s, block: b } = ev.extendedProps;
  const start = new Date(b.start);
  const end = new Date(b.end);
  const row = (k: string, v: Child) => [h("dt", { text: k }), h("dd", {}, v)];
  const cmd = `${s.cwd ? `cd ${shellQuote(s.cwd)} && ` : ""}claude --resume ${s.id}`;
  const copy = h("button", { type: "button", text: "Copy" });
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      copy.textContent = "Copied";
    } catch {
      copy.textContent = "Failed";
    }
  });

  const blockRows = [
    row(
      "Active",
      b.active.length
        ? h(
            "span",
            {},
            `${dur(b.activeMs)} (${b.active.length} ${b.active.length === 1 ? "span" : "spans"})`,
            est(b.activeEstimated),
          )
        : h("span", { class: "muted", text: "not recorded" }),
    ),
    row("Cost", h("span", {}, usd(b.costUSD), est(s.costEstimated))),
    b.tokens
      ? row(
          "Tokens",
          h(
            "div",
            { class: "chips" },
            Object.entries(b.tokens).map(([m, t]) =>
              h(
                "span",
                {
                  class: "chip",
                  title: `Input ${int(t.input)} / Output ${int(t.output)} / Cache read ${int(t.cacheRead)} / Cache write ${int(t.cacheWrite5m + t.cacheWrite1h)}`,
                },
                m,
                h("span", { class: "n num", text: `out ${compact(t.output)} · read ${compact(t.cacheRead)}` }),
              ),
            ),
          ),
        )
      : null,
    row("Changed lines", lines(b.linesAdded, b.linesRemoved)),
    row("Prompts", `${int(b.prompts)} / ${int(b.messages)} messages`),
    row("PRs", prList(b.prs)),
    row("Models", chips(b.models)),
    row("Tools", chips(b.tools)),
    b.skills ? row("Skills", chips(b.skills)) : null,
    b.mcp ? row("MCP", chips(b.mcp)) : null,
    b.errors ? row("API errors", String(b.errors)) : null,
    row("Edited files", fileList(b.files, s.cwd)),
  ];
  const sessionTotals = [
    row("Blocks", String(s.blocks)),
    row("Active", dur(s.activeMs)),
    row("Cost", h("span", {}, usd(s.costUSD), est(s.costEstimated))),
    row("Changed lines", lines(s.linesAdded, s.linesRemoved)),
    row("PRs", prList(s.prs)),
  ];
  const sessionMeta = [
    row("Project", s.cwd || "-"),
    row("Branch", s.branch || "-"),
    row("Entrypoint", s.entrypoint || "-"),
    row("Version", s.version || "-"),
    row("Session", s.slug ? `${s.id} (${s.slug})` : s.id),
  ];
  // A session that was not split into several blocks is the block itself, so its totals would only
  // repeat the block's figures.
  const split = s.blocks > 1;

  byId("detail-body").replaceChildren(
    h("h3", { text: ev.title || "(untitled)" }),
    h("div", { class: "when", text: `${timeFmt.format(start)} – ${hmFmt.format(end)} (${dur(b.end - b.start)})` }),
    ...(split
      ? [
          h("h4", { text: "This block" }),
          h("dl", {}, blockRows),
          h("h4", { text: "Whole session" }),
          h("dl", {}, sessionTotals, sessionMeta),
        ]
      : [h("h4", { text: "Session" }), h("dl", {}, blockRows, sessionMeta)]),
    usageTable(s.usage) ?? "",
    h("div", { class: "cmd" }, h("code", { text: cmd }), copy),
    h("a", { class: "open-archive", href: `/?${new URLSearchParams({ s: s.id })}`, text: "Open session messages" }),
  );
  detail.hidden = false;
}

const modeButtons = document.querySelectorAll<HTMLButtonElement>(".seg button");
function syncMode() {
  modeButtons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
}
modeButtons.forEach((b) =>
  b.addEventListener("click", () => {
    mode = b.dataset.mode === "active" ? "active" : "block";
    save(MODE_KEY, mode);
    syncMode();
    calendar.refetchEvents();
  }),
);
syncMode();

const sdkToggle = byId("show-sdk") as HTMLInputElement;
sdkToggle.checked = showSdk;
sdkToggle.addEventListener("change", () => {
  showSdk = sdkToggle.checked;
  save(SHOW_SDK_KEY, showSdk);
  calendar.refetchEvents();
});

type FetchInfo = { start: Date; end: Date; startStr: string; endStr: string };
const calendar = new FullCalendar.Calendar(byId("calendar"), {
  initialView: "timeGridWeek",
  headerToolbar: { left: "prev,next today", center: "title", right: "dayGridMonth,timeGridWeek,timeGridDay,listWeek" },
  height: "100%",
  firstDay: 1,
  nowIndicator: true,
  allDayText: "Daily",
  scrollTime: "08:00:00",
  slotDuration: "00:30:00",
  slotEventOverlap: false,
  dayMaxEvents: 6,
  eventOrder: "order,start,-duration",
  eventTimeFormat: { hour: "2-digit", minute: "2-digit", hour12: false },
  slotLabelFormat: { hour: "2-digit", minute: "2-digit", hour12: false },
  events: async (info: FetchInfo, success: (events: FcInput[]) => void, failure: (err: unknown) => void) => {
    try {
      const res = await fetch(`/api/events?${new URLSearchParams({ start: info.startStr, end: info.endStr })}`);
      if (!res.ok) throw new Error(await res.text());
      lastEvents = (await res.json()) as CalendarEvent[];
      range = { start: info.start, end: info.end };
      const shown = visible();
      renderProjects();
      renderTotals(shown);
      success([...dailySummaries(shown), ...toCalendarEvents(shown)]);
    } catch (err) {
      failure(err);
    }
  },
  eventContent: (arg: { event: FcEvent }) => {
    const p = arg.event.extendedProps;
    if (!p.summary) return true;
    return { domNodes: (p.lines ?? []).map((l) => h("div", { text: l })) };
  },
  eventDidMount: (info: { event: FcEvent; el: HTMLElement }) => {
    const p = info.event.extendedProps;
    if (p.summary) {
      info.el.title = ACTIVE_HINT;
      return;
    }
    const b = p.block;
    info.el.title = [
      info.event.title,
      `${projectLabel(p.session.cwd)}${p.session.branch ? ` (${p.session.branch})` : ""}`,
      `Active ${dur(b.activeMs)}${b.activeEstimated ? " (estimated)" : ""} · ${usd(b.costUSD)} · ${b.prompts} prompts`,
    ].join("\n");
  },
  eventClick: (info: { event: FcEvent }) => {
    if (!info.event.extendedProps.summary) showDetail(info.event);
  },
});
calendar.render();
setInterval(() => calendar.refetchEvents(), REFRESH_MS);
