/// <reference lib="dom" />
/** @jsx h */
import { h, type View } from "./h";
import { calendar } from "./views/calendar";
import { search } from "./views/search";
import { summaries } from "./views/summaries";

const routes: Record<string, View> = { "/": search, "/summaries": summaries, "/calendar": calendar };

const app = document.getElementById("app")!;
let current: AbortController | undefined;

// Scroll position of each history entry this document has shown, saved when the app leaves the entry.
const scrolls = new Map<string, number>();
const entryOf = (state: unknown) => (state as { entry?: string } | null)?.entry ?? crypto.randomUUID();
let entry = entryOf(history.state);
history.replaceState({ entry }, "");

async function render(scroll: number) {
  current?.abort();
  const ctl = new AbortController();
  current = ctl;
  for (const a of document.querySelectorAll("header a")) {
    if ((a as HTMLAnchorElement).pathname === location.pathname) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  const view = routes[location.pathname];
  try {
    if (!view) throw new Error(`No page ${location.pathname}.`);
    const { title, body, mounted } = await view(new URLSearchParams(location.search), ctl.signal);
    if (ctl.signal.aborted) return;
    document.title = title;
    app.replaceChildren(h("div", { class: "view" }, body));
    app.scrollTop = 0;
    mounted?.();
    if (scroll) app.scrollTop = scroll;
  } catch (e) {
    if (!ctl.signal.aborted) app.replaceChildren(<p class="error">{String(e)}</p>);
  }
}

function go(url: string) {
  scrolls.set(entry, app.scrollTop);
  entry = crypto.randomUUID();
  history.pushState({ entry }, "", url);
  void render(0);
}

document.addEventListener("click", (ev) => {
  if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
  const a = (ev.target as Element).closest("a");
  if (!a || a.target || a.origin !== location.origin || !(a.pathname in routes)) return;
  ev.preventDefault();
  go(a.href);
});

document.addEventListener("submit", (ev) => {
  const form = ev.target as HTMLFormElement;
  ev.preventDefault();
  const params = new URLSearchParams();
  for (const [k, v] of new FormData(form)) if (typeof v === "string" && v) params.set(k, v);
  go(`${new URL(form.action).pathname}?${params}`);
});

window.addEventListener("popstate", (ev) => {
  scrolls.set(entry, app.scrollTop);
  entry = entryOf(ev.state);
  void render(scrolls.get(entry) ?? 0);
});
history.scrollRestoration = "manual";
void render(0);
