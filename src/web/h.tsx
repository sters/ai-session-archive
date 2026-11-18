/// <reference lib="dom" />
/** @jsx h */
export type Child = Node | string | number | null | undefined | false | Child[];
type Prop = string | number | boolean | null | undefined | ((ev: Event) => void);

declare global {
  namespace JSX {
    type Element = HTMLElement;
    interface IntrinsicElements {
      [tag: string]: Record<string, Prop>;
    }
  }
}

// A function prop named onX becomes a listener for the event x; any other prop becomes an attribute.
export function h(tag: string, props: Record<string, Prop> | null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v != null && v !== false) el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity as 1)) {
    if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export function highlight(text: string, terms: string[]): Child {
  const words = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (words.length === 0) return text;
  return text.split(new RegExp(`(${words.join("|")})`, "i")).map((part, i) => (i % 2 ? <mark>{part}</mark> : part));
}

export const termsOf = (params: URLSearchParams) => (params.get("q") ?? "").split(/\s+/).filter(Boolean);

export async function getJSON<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

// What a view renders for the current URL. The signal aborts when the app leaves the view, which cancels its
// requests and is where a view releases timers and listeners. `mounted` runs once body is in the document.
export type Rendered = { title: string; body: Child; mounted?: () => void };
export type View = (params: URLSearchParams, signal: AbortSignal) => Promise<Rendered>;
