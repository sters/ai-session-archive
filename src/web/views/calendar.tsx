/// <reference lib="dom" />
/** @jsx h */
import type { CalendarEvent, ModelUsage, PR } from "../../calendar";
import { totals, type BlockOf } from "../../totals";
import { getJSON, h, type Child, type View } from "../h";

// The part of FullCalendar's global build that this page uses; it is loaded from jsDelivr.
type FcEvent = {
  title: string;
  extendedProps: CalendarEvent["extendedProps"] & { summary?: boolean; lines?: string[] };
};
type FcInput = Record<string, unknown>;
type FcCalendar = { render(): void; refetchEvents(): void; destroy(): void };
declare const FullCalendar: { Calendar: new (el: HTMLElement, options: Record<string, unknown>) => FcCalendar };

const FULLCALENDAR_URL = "https://cdn.jsdelivr.net/npm/fullcalendar@6.1.21/index.global.min.js";
const HIDDEN_KEY = "calendar.hiddenProjects";
const SHOW_SDK_KEY = "calendar.showSdk";
const MODE_KEY = "calendar.mode";
const REFRESH_MS = 60_000;
const MIN_EVENT_MS = 5 * 60_000;
const FILES_SHOWN = 15;
const ACTIVE_HINT = "Total time Claude was running. Sessions running in parallel are each counted";
const MAX_VALUE_PX = 18;
const MIN_VALUE_PX = 10;

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
let showSdk = load(SHOW_SDK_KEY, true);
let mode = load<"block" | "active">(MODE_KEY, "block");

let fullCalendar: Promise<void> | undefined;
function loadFullCalendar() {
  fullCalendar ??= new Promise<void>((resolve, reject) => {
    const script = <script src={FULLCALENDAR_URL} />;
    script.addEventListener("load", () => resolve());
    script.addEventListener("error", () => {
      script.remove();
      fullCalendar = undefined;
      reject(new Error(`Could not load ${FULLCALENDAR_URL}`));
    });
    document.head.append(script);
  });
  return fullCalendar;
}

const isSdk = (e: CalendarEvent) => e.extendedProps.session.entrypoint === "sdk-cli";
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
const est = (on: boolean | undefined) => on && <span class="est">estimated</span>;
const muted = (text: string) => <span class="muted">{text}</span>;
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

const blocksOf = (events: CalendarEvent[]): BlockOf[] =>
  events.map((e) => ({ session: e.extendedProps.session.id, block: e.extendedProps.block }));

function totalCards(events: CalendarEvent[], range: { start: Date; end: Date }): HTMLElement[] {
  const t = totals(blocksOf(events), range.start.getTime(), range.end.getTime());
  const cell = (k: string, v: Child, title?: string) => (
    <div title={title}>
      <div class="k">{k}</div>
      {v}
    </div>
  );
  const value = (text: string, cls = "") => <div class={`v num ${cls}`}>{text}</div>;
  return [
    cell("Active", value(hours(t.activeMs)), ACTIVE_HINT),
    cell("Cost", value(usd(t.costUSD)), "API-price equivalent"),
    cell("Sessions", value(int(t.sessions))),
    cell("Prompts", value(int(t.prompts))),
    cell("PRs", value(int(t.prs))),
    cell("Changed lines", [value(`+${int(t.linesAdded)}`, "add"), value(`−${int(t.linesRemoved)}`, "del")]),
  ];
}

// Lowers each value's size from MAX_VALUE_PX until it fits its card.
function fitValues(root: HTMLElement) {
  for (const el of root.querySelectorAll<HTMLElement>(".v")) {
    let px = MAX_VALUE_PX;
    el.style.fontSize = `${px}px`;
    while (el.scrollWidth > el.clientWidth && px > MIN_VALUE_PX) {
      px -= 1;
      el.style.fontSize = `${px}px`;
    }
  }
}

function dailySummaries(events: CalendarEvent[]): FcInput[] {
  const days = new Set(events.map((e) => dayKey(new Date(e.start))));
  return [...days].map((day) => {
    const from = new Date(`${day}T00:00:00`);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    // All events, not only this day's: blocks that started the day before can still run into it.
    const t = totals(blocksOf(events), from.getTime(), to.getTime());
    const parts = [`Active ${hours(t.activeMs)}`, usd(t.costUSD)];
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

function chips(map: Record<string, number> | undefined) {
  const entries = sortedEntries(map);
  if (!entries.length) return muted("-");
  return (
    <div class="chips">
      {entries.map(([k, n]) => (
        <span class="chip">
          {k}
          <span class="n num">{n}</span>
        </span>
      ))}
    </div>
  );
}

function prList(prs: PR[]) {
  if (!prs.length) return muted("-");
  return (
    <div>
      {prs.map((p) => {
        const label = `${p.repository}#${p.number}`;
        const url = safeUrl(p.url);
        return (
          <div>
            {url ? (
              <a href={url} target="_blank" rel="noopener noreferrer">
                {label}
              </a>
            ) : (
              label
            )}
          </div>
        );
      })}
    </div>
  );
}

function fileList(files: string[], cwd: string) {
  if (!files.length) return muted("-");
  const rel = (f: string) => (cwd && f.startsWith(`${cwd}/`) ? f.slice(cwd.length + 1) : f);
  const li = (f: string) => <li title={f}>{rel(f)}</li>;
  const rest = files.slice(FILES_SHOWN);
  return (
    <div>
      <ul class="files">{files.slice(0, FILES_SHOWN).map(li)}</ul>
      {rest.length > 0 && (
        <details>
          <summary>{rest.length} more</summary>
          <ul class="files">{rest.map(li)}</ul>
        </details>
      )}
    </div>
  );
}

const lines = (added: number, removed: number) => (
  <span class="num">
    <span class="add">+{int(added)}</span> <span class="del">−{int(removed)}</span>
  </span>
);

function usageTable(usage: Record<string, ModelUsage> | undefined) {
  const rows = Object.entries(usage ?? {});
  if (!rows.length) return null;
  return (
    <div class="table-wrap">
      <table class="usage num">
        <thead>
          <tr>
            {["Model", "Input", "Output", "Cache read", "Cache write", "Cost"].map((c) => (
              <th>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([model, u]) => (
            <tr>
              <td>{model}</td>
              <td>{int(u.inputTokens)}</td>
              <td>{int(u.outputTokens)}</td>
              <td>{int(u.cacheReadInputTokens)}</td>
              <td>{int(u.cacheCreationInputTokens)}</td>
              <td>{usd(u.costUSD)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function detailOf(ev: FcEvent): Child {
  const { session: s, block: b } = ev.extendedProps;
  const row = (k: string, v: Child) => [<dt>{k}</dt>, <dd>{v}</dd>];
  const cmd = `${s.cwd ? `cd ${shellQuote(s.cwd)} && ` : ""}claude --resume ${s.id}`;
  const copy = (e: Event) => {
    const button = e.currentTarget as HTMLElement;
    navigator.clipboard.writeText(cmd).then(
      () => (button.textContent = "Copied"),
      () => (button.textContent = "Failed"),
    );
  };

  const blockRows = [
    row(
      "Active",
      b.active.length ? (
        <span>
          {`${dur(b.activeMs)} (${b.active.length} ${b.active.length === 1 ? "span" : "spans"})`}
          {est(b.activeEstimated)}
        </span>
      ) : (
        muted("not recorded")
      ),
    ),
    row(
      "Cost",
      <span>
        {usd(b.costUSD)}
        {est(s.costEstimated)}
      </span>,
    ),
    b.tokens &&
      row(
        "Tokens",
        <div class="chips">
          {Object.entries(b.tokens).map(([m, t]) => (
            <span
              class="chip"
              title={`Input ${int(t.input)} / Output ${int(t.output)} / Cache read ${int(t.cacheRead)} / Cache write ${int(t.cacheWrite5m + t.cacheWrite1h)}`}
            >
              {m}
              <span class="n num">{`out ${compact(t.output)} · read ${compact(t.cacheRead)}`}</span>
            </span>
          ))}
        </div>,
      ),
    row("Changed lines", lines(b.linesAdded, b.linesRemoved)),
    row("Prompts", `${int(b.prompts)} / ${int(b.messages)} messages`),
    row("PRs", prList(b.prs)),
    row("Models", chips(b.models)),
    row("Tools", chips(b.tools)),
    b.skills && row("Skills", chips(b.skills)),
    b.mcp && row("MCP", chips(b.mcp)),
    b.errors > 0 && row("API errors", String(b.errors)),
    row("Edited files", fileList(b.files, s.cwd)),
  ];
  const sessionTotals = [
    row("Blocks", String(s.blocks)),
    row("Active", dur(s.activeMs)),
    row(
      "Cost",
      <span>
        {usd(s.costUSD)}
        {est(s.costEstimated)}
      </span>,
    ),
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

  return [
    <h3>{ev.title || "(untitled)"}</h3>,
    <div class="when">{`${timeFmt.format(new Date(b.start))} – ${hmFmt.format(new Date(b.end))} (${dur(b.end - b.start)})`}</div>,
    // A session that was not split into several blocks is the block itself, so its totals would only
    // repeat the block's figures.
    s.blocks > 1
      ? [
          <h4>This block</h4>,
          <dl>{blockRows}</dl>,
          <h4>Whole session</h4>,
          <dl>
            {sessionTotals}
            {sessionMeta}
          </dl>,
        ]
      : [
          <h4>Session</h4>,
          <dl>
            {blockRows}
            {sessionMeta}
          </dl>,
        ],
    usageTable(s.usage),
    <div class="cmd">
      <code>{cmd}</code>
      <button type="button" onClick={copy}>
        Copy
      </button>
    </div>,
    <a class="open-archive" href={`/?${new URLSearchParams({ s: s.id })}`}>
      Open session messages
    </a>,
  ];
}

export const calendar: View = async (_params, signal) => {
  await loadFullCalendar();
  let lastEvents: CalendarEvent[] = [];

  const totalsEl = <div class="totals" />;
  const projectsEl = <ul class="projects" />;
  const sdkCount = <span class="count num" />;
  const detailBody = <div />;
  const closeDetail = () => (detail.hidden = true);
  const detail = (
    <section id="detail" hidden>
      <button class="close" type="button" aria-label="Close" onClick={closeDetail}>
        ×
      </button>
      {detailBody}
    </section>
  );
  const host = <div class="fc-host" />;
  // A click anywhere on the calendar closes the pane; a click on another session's event is handled by
  // eventClick, which switches the pane instead.
  const calendarPane = (
    <div
      class="calendar-main"
      onClick={(ev) => {
        if (!(ev.target as Element).closest(".fc-event:not(.summary-event)")) closeDetail();
      }}
    >
      {host}
    </div>
  );

  const modeButton = (value: typeof mode, label: string) => (
    <button
      type="button"
      data-mode={value}
      aria-pressed={String(mode === value)}
      onClick={() => {
        mode = value;
        save(MODE_KEY, mode);
        for (const b of modeButtons) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
        fc.refetchEvents();
      }}
    >
      {label}
    </button>
  );
  const modeButtons = [modeButton("block", "Blocks"), modeButton("active", "Active spans")];

  const visible = () => lastEvents.filter((e) => (showSdk || !isSdk(e)) && !hidden.has(e.extendedProps.session.cwd));

  function renderProjects() {
    const counts = new Map<string, number>();
    for (const e of lastEvents) {
      if (!showSdk && isSdk(e)) continue;
      const cwd = e.extendedProps.session.cwd;
      counts.set(cwd, (counts.get(cwd) ?? 0) + 1);
    }
    const toggle = (cwd: string) => (ev: Event) => {
      if ((ev.currentTarget as HTMLInputElement).checked) hidden.delete(cwd);
      else hidden.add(cwd);
      save(HIDDEN_KEY, [...hidden]);
      fc.refetchEvents();
    };
    projectsEl.replaceChildren(
      ...[...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([cwd, n]) => (
          <li title={cwd}>
            <label>
              <input type="checkbox" checked={!hidden.has(cwd)} onChange={toggle(cwd)} />
              <span class="swatch" style={`background: ${colorOf(cwd)}`} />
              <span class="name">{projectLabel(cwd)}</span>
              <span class="count num">{n}</span>
            </label>
          </li>
        )),
    );
    sdkCount.textContent = String(lastEvents.filter(isSdk).length);
  }

  type FetchInfo = { start: Date; end: Date; startStr: string; endStr: string };
  const fc = new FullCalendar.Calendar(host, {
    initialView: "timeGridWeek",
    headerToolbar: {
      left: "prev,next today",
      center: "title",
      right: "dayGridMonth,timeGridWeek,timeGridDay,listWeek",
    },
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
        const q = new URLSearchParams({ start: info.startStr, end: info.endStr });
        lastEvents = await getJSON<CalendarEvent[]>(`/api/events?${q}`, signal);
        const shown = visible();
        renderProjects();
        totalsEl.replaceChildren(...totalCards(shown, info));
        fitValues(totalsEl);
        success([...dailySummaries(shown), ...toCalendarEvents(shown)]);
      } catch (err) {
        failure(err);
      }
    },
    eventContent: (arg: { event: FcEvent }) => {
      const p = arg.event.extendedProps;
      if (!p.summary) return true;
      return { domNodes: (p.lines ?? []).map((l) => <div>{l}</div>) };
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
      if (info.event.extendedProps.summary) return;
      detailBody.replaceChildren(h("div", null, detailOf(info.event)));
      detail.hidden = false;
    },
  });

  return {
    title: "ai-session-archive calendar",
    body: (
      <div class="calendar-view">
        <aside>
          <div class="seg" role="group" aria-label="Display unit">
            {modeButtons}
          </div>
          <label class="toggle">
            <input
              type="checkbox"
              checked={showSdk}
              onChange={(ev) => {
                showSdk = (ev.currentTarget as HTMLInputElement).checked;
                save(SHOW_SDK_KEY, showSdk);
                fc.refetchEvents();
              }}
            />{" "}
            Show SDK runs {sdkCount}
          </label>
          <h2>This period</h2>
          {totalsEl}
          <h2>Projects</h2>
          {projectsEl}
        </aside>
        {calendarPane}
        {detail}
      </div>
    ),
    mounted: () => {
      fc.render();
      const timer = setInterval(() => fc.refetchEvents(), REFRESH_MS);
      window.addEventListener("resize", () => fitValues(totalsEl), { signal });
      document.addEventListener("keydown", (ev) => ev.key === "Escape" && closeDetail(), { signal });
      signal.addEventListener("abort", () => {
        clearInterval(timer);
        fc.destroy();
      });
    },
  };
};
