/// <reference lib="dom" />
/** @jsx h */
import type { Summary } from "../../summary";
import { statsLine } from "../../totals";
import { getJSON, h, highlight, termsOf, type Child, type View } from "../h";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\)|https?:\/\/[^\s)）」]+)/;

// Links only http(s) URLs: the text came from transcripts, so a `javascript:` link must not become clickable.
function link(href: string, label: Child): Child {
  return /^https?:\/\//.test(href) ? (
    <a href={href} target="_blank" rel="noreferrer">
      {label}
    </a>
  ) : (
    label
  );
}

function inline(text: string, terms: string[]): Child[] {
  return text.split(INLINE).map((part, i) => {
    if (i % 2 === 0) return highlight(part, terms);
    if (part.startsWith("`")) {
      const code = part.slice(1, -1);
      const inner = <code>{highlight(code, terms)}</code>;
      return SESSION_ID.test(code) ? <a href={`/?s=${code}`}>{inner}</a> : inner;
    }
    if (part.startsWith("**")) return <b>{inline(part.slice(2, -2), terms)}</b>;
    const md = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (md) return link(md[2]!, inline(md[1]!, terms));
    return link(part, part);
  });
}

// The Markdown that summaries are written in: headings, nested lists, tables, fenced code, rules and paragraphs.
function markdown(src: string, terms: string[]): HTMLElement {
  const root = <div class="body" />;
  const lines = src.split("\n");
  // Open lists, innermost last, with the indent of their items.
  let lists: { el: HTMLElement; indent: number }[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) root.append(<p>{inline(para.join(" "), terms)}</p>);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const indent = item[1]!.length;
      const tag = /\d/.test(item[2]!) ? "ol" : "ul";
      while (lists.length && lists.at(-1)!.indent > indent) lists.pop();
      if (!lists.length || lists.at(-1)!.indent < indent) {
        const list = h(tag, null);
        (lists.at(-1)?.el.lastElementChild ?? root).append(list);
        lists.push({ el: list, indent });
      }
      lists.at(-1)!.el.append(<li>{inline(item[3]!, terms)}</li>);
      continue;
    }
    // A non-blank line indented under a list item continues it.
    if (lists.length && /^\s+\S/.test(line)) {
      lists.at(-1)!.el.lastElementChild?.append(h("span", null, " ", inline(line.trim(), terms)));
      continue;
    }
    lists = [];
    if (line.startsWith("```")) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i]!);
      root.append(
        <pre>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      root.append(h(`h${Math.min(6, heading[1]!.length + 2)}`, null, inline(heading[2]!, terms)));
      continue;
    }
    if (/^\s*\|/.test(line)) {
      flush();
      const rows: string[][] = [];
      for (; i < lines.length && /^\s*\|/.test(lines[i]!); i++) {
        const cells = lines[i]!.trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim());
        if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push(cells);
      }
      i--;
      const [head, ...body] = rows;
      root.append(
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                {head?.map((c) => (
                  <th>{inline(c, terms)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((r) => (
                <tr>
                  {r.map((c) => (
                    <td>{inline(c, terms)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      root.append(<hr />);
      continue;
    }
    if (line.trim() === "") flush();
    else para.push(line.trim());
  }
  flush();
  return root;
}

const DAY_MS = 86_400_000;
function label(s: Summary): string {
  if (s.period === "day") {
    const d = new Date(`${s.start}T00:00:00`);
    return `${s.start} (${d.toLocaleDateString(undefined, { weekday: "short" })})`;
  }
  if (s.period === "month") return s.start.slice(0, 7);
  const end = new Date(new Date(`${s.start}T00:00:00`).getTime() + 6.5 * DAY_MS);
  return `${s.start} – ${end.toLocaleDateString("sv-SE")}`;
}

export const summaries: View = async (params, signal) => {
  const terms = termsOf(params);
  const rows = await getJSON<Summary[]>(`/api/summaries?${params}`, signal);
  const select = (
    <select name="period">
      <option value="">All periods</option>
      <option value="day">Day</option>
      <option value="week">Week</option>
      <option value="month">Month</option>
    </select>
  ) as HTMLSelectElement;
  select.value = params.get("period") ?? "";
  return {
    title: "ai-session-archive summaries",
    body: (
      <div class="page summaries">
        <form action="/summaries">
          {select}
          <input name="q" placeholder="terms (all must match)" value={params.get("q") ?? ""} />
          <input name="since" type="date" value={params.get("since") ?? ""} />
          <button>Show</button>
        </form>
        {rows.length === 0 && <p>No summaries. Run `summarize`, or `sync --summarize`.</p>}
        {rows.map((s, i) => (
          <article>
            <details open={i === 0 || terms.length > 0}>
              <summary>
                <span class={`period ${s.period}`}>{s.period}</span>
                {label(s)}{" "}
                {s.model && s.created_at && (
                  <span class="meta">
                    {s.model} · {new Date(s.created_at).toLocaleString()}
                  </span>
                )}
                {s.stats && <div class="stats">{statsLine(s.stats)}</div>}
              </summary>
              {s.text ? markdown(s.text, terms) : <p class="meta">Not summarized yet.</p>}
            </details>
          </article>
        ))}
      </div>
    ),
  };
};
