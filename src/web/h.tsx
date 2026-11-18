/// <reference lib="dom" />
/** @jsx h */
export type Child = Node | string | number | null | undefined | false | Child[];

declare global {
  namespace JSX {
    type Element = HTMLElement;
    interface IntrinsicElements {
      [tag: string]: Record<string, string | boolean | null | undefined>;
    }
  }
}

export function h(tag: string, props: Record<string, unknown> | null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v != null && v !== false) el.setAttribute(k, v === true ? "" : String(v));
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
