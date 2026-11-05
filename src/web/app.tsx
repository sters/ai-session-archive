/// <reference lib="dom" />
/** @jsx h */
import { local, type getSession, type Hit, type ListedSession } from "../query";

type Child = Node | string | number | null | undefined | false | Child[];

declare global {
  namespace JSX {
    type Element = HTMLElement;
    interface IntrinsicElements {
      [tag: string]: Record<string, string | boolean | null | undefined>;
    }
  }
}

function h(tag: string, props: Record<string, unknown> | null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v != null && v !== false) el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity as 1)) {
    if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

function highlight(text: string, terms: string[]): Child {
  const words = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (words.length === 0) return text;
  return text.split(new RegExp(`(${words.join("|")})`, "i")).map((part, i) => (i % 2 ? <mark>{part}</mark> : part));
}

const params = new URLSearchParams(location.search);
const terms = (params.get("q") ?? "").split(/\s+/).filter(Boolean);
const hits = (text: string) => terms.some((t) => text.toLowerCase().includes(t.toLowerCase()));
const sessionHref = (id: string) => `/?${new URLSearchParams({ s: id, q: terms.join(" ") })}`;

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${path}?${params}`);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

async function sessions() {
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

async function results() {
  const hits = await get<Hit[]>("/api/search");
  if (hits.length === 0) return <p>No matches.</p>;
  return hits.map((m) => (
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

const COLLAPSE_KEY = "collapse-tools";
let collapsed = true;
try {
  collapsed = localStorage.getItem(COLLAPSE_KEY) !== "0";
} catch {}

function collapseToggle(): HTMLElement {
  const box = <input type="checkbox" checked={collapsed} />;
  box.addEventListener("change", () => {
    collapsed = (box as HTMLInputElement).checked;
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    } catch {}
    for (const d of document.querySelectorAll<HTMLDetailsElement>("details.tool")) {
      d.open = !collapsed || d.classList.contains("hit");
    }
  });
  return (
    <label class="toggle">
      {box} Collapse tool calls
    </label>
  );
}

async function session(id: string) {
  const found = await get<ReturnType<typeof getSession>>(`/api/sessions/${encodeURIComponent(id)}`);
  if (found.length === 0) return <p>No session {id}.</p>;
  document.title = found[0]?.session.title ?? id;
  return found.map(({ session: s, messages, subagents }) => [
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
}

const form = document.querySelector("form")!;
for (const name of ["q", "project", "since"]) {
  const input = form.elements.namedItem(name) as HTMLInputElement;
  input.value = params.get(name) ?? "";
}

const id = params.get("s");
const main = document.querySelector("main")!;
try {
  main.append(<div>{await (id ? session(id) : terms.length ? results() : sessions())}</div>);
  if (id) main.querySelector("mark")?.scrollIntoView({ block: "center" });
} catch (e) {
  main.append(<p>{String(e)}</p>);
}
