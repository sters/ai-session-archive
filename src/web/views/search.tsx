/// <reference lib="dom" />
/** @jsx h */
import type { CalendarEvent } from "../../calendar";
import { local, type getSession, type Hit, type ListedSession } from "../../query";
import { getJSON, h, highlight, termsOf, type Child, type View } from "../h";
import { detailOf } from "./calendar";

const COLLAPSE_KEY = "collapse-tools";
let collapsed = true;
try {
  collapsed = localStorage.getItem(COLLAPSE_KEY) !== "0";
} catch {
  // storage unavailable
}

export const search: View = async (params, signal) => {
  const terms = termsOf(params);
  const hits = (text: string) => terms.some((t) => text.toLowerCase().includes(t.toLowerCase()));
  const sessionHref = (id: string) => `/?${new URLSearchParams({ s: id, q: terms.join(" ") })}`;
  const get = <T,>(path: string) => getJSON<T>(`${path}?${params}`, signal);

  async function sessions(): Promise<Child> {
    const rows = await get<ListedSession[]>("/api/sessions");
    return rows.map((s) => (
      <div class="row">
        {s.structured === 1 && <span class="badge">StructuredOutput</span>}
        <a href={sessionHref(s.id)}>{s.title ?? s.id}</a>
        <div class="meta">
          {local(s.first_ts)} {s.cwd ?? "-"}
        </div>
      </div>
    ));
  }

  async function results(): Promise<Child> {
    const found = await get<Hit[]>("/api/search");
    if (found.length === 0) return <p>No matches.</p>;
    return found.map((m) => (
      <div class="row">
        <div class="meta">
          {local(m.ts)} <a href={sessionHref(m.id)}>{m.id}</a> {m.cwd ?? "-"}
        </div>
        <div>
          <b>{m.role === "tool" ? `tool:${m.tool}` : m.role}</b> {highlight(m.text, terms)}
        </div>
      </div>
    ));
  }

  function collapseToggle(): HTMLElement {
    const onChange = (ev: Event) => {
      collapsed = (ev.currentTarget as HTMLInputElement).checked;
      try {
        localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
      } catch {
        // storage unavailable
      }
      for (const d of document.querySelectorAll<HTMLDetailsElement>("details.tool")) {
        d.open = !collapsed || d.classList.contains("hit");
      }
    };
    return (
      <label class="collapse">
        <input type="checkbox" checked={collapsed} onChange={onChange} /> Collapse tool calls
      </label>
    );
  }

  // The calendar's detail pane for the session's blocks; subagent sessions have no blocks of their own.
  async function sidebar(id: string): Promise<Child> {
    const events = await getJSON<CalendarEvent[]>(`/api/sessions/${encodeURIComponent(id)}/events`, signal);
    if (events.length === 0) return null;
    const body = <div />;
    const show = (e: CalendarEvent) => {
      body.replaceChildren(h("div", null, detailOf(e, false)));
      for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.id === e.id));
    };
    const fmt = new Intl.DateTimeFormat(undefined, {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    const buttons = events.map((e) => (
      <button type="button" data-id={e.id} onClick={() => show(e)}>
        {fmt.format(new Date(e.start))}
      </button>
    ));
    show(events[0]!);
    return (
      <aside class="detail">
        {events.length > 1 && (
          <div class="block-picker" role="group" aria-label="Block">
            {buttons}
          </div>
        )}
        {body}
      </aside>
    );
  }

  async function session(id: string): Promise<[string, Child, Child]> {
    const [found, aside] = await Promise.all([
      get<ReturnType<typeof getSession>>(`/api/sessions/${encodeURIComponent(id)}`),
      sidebar(id),
    ]);
    if (found.length === 0) return [id, <p>No session {id}.</p>, null];
    const body = found.map(({ session: s, messages, subagents }) => [
      <h1>{s.title ?? s.description ?? s.id}</h1>,
      <div class="meta">
        {s.id} {s.parent_id && <a href={sessionHref(s.parent_id)}>parent ({s.agent_type})</a>}
        <br />
        {s.cwd ?? "-"} {s.git_branch ?? "-"} {local(s.first_ts)} - {local(s.last_ts)}
        <br />
        {s.file_path}
      </div>,
      messages.some((m) => m.role === "tool") && collapseToggle(),
      messages.map((m) =>
        m.role === "tool" ? (
          <details class={`msg tool${hits(m.text) ? " hit" : ""}`} open={!collapsed || hits(m.text)}>
            <summary class="meta">
              {local(m.ts)} tool:{m.tool} <code>{m.text.slice(0, 120)}</code>
            </summary>
            <pre>{highlight(m.text, terms)}</pre>
          </details>
        ) : (
          <div class={`msg ${m.role}`}>
            <div class="meta">
              {local(m.ts)} {m.role}
            </div>
            <pre>{highlight(m.text, terms)}</pre>
          </div>
        ),
      ),
      subagents.length > 0 && [
        <h2>Subagents</h2>,
        subagents.map((a) => (
          <div class="row">
            <a href={sessionHref(a.id)}>{a.description ?? a.id}</a> <span class="meta">{a.agent_type}</span>
          </div>
        )),
      ],
    ]);
    return [found[0]?.session.title ?? id, body, aside];
  }

  const id = params.get("s");
  const [title, content, aside] = id
    ? await session(id)
    : ["ai-session-archive", await (terms.length ? results() : sessions()), null];
  const form = (
    <form action="/">
      <input name="q" placeholder="terms (all must match)" value={params.get("q") ?? ""} />
      <input name="project" placeholder="project (e.g. acme/widgets)" value={params.get("project") ?? ""} />
      <input name="since" type="date" value={params.get("since") ?? ""} />
      <button>Search</button>
    </form>
  );
  return {
    title,
    body: aside ? (
      <div class="session-view">
        <div class="page search">
          {form}
          {content}
        </div>
        {aside}
      </div>
    ) : (
      <div class="page search">
        {form}
        {content}
      </div>
    ),
    mounted: () => {
      if (id) document.querySelector("mark")?.scrollIntoView({ block: "center" });
      else (form.querySelector("input[name=q]") as HTMLInputElement).focus();
    },
  };
};
