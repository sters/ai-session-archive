import type { Database } from "bun:sqlite";
import { Calendar, eventsBetween } from "../calendar";
import { getSession, listSessions, search, snippet, type Filter } from "../query";
import calendarPage from "./calendar.html";
import index from "./index.html";

function filter(p: URLSearchParams, defaultLimit: number): Filter {
  const since = p.get("since");
  return {
    project: p.get("project") || undefined,
    since: since ? new Date(`${since}T00:00:00`).toISOString() : undefined,
    limit: Number(p.get("limit")) || defaultLimit,
  };
}

// Rejects requests whose Host is not a loopback name. A site whose domain resolves to 127.0.0.1 (DNS
// rebinding) counts as same-origin to the browser, but its requests still carry its own domain as Host.
function loopbackOnly<R extends Request>(handler: (req: R) => Response): (req: R) => Response {
  return (req) => {
    const host = new URL(req.url).hostname;
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) return new Response("forbidden host", { status: 403 });
    return handler(req);
  };
}

// A time without an offset is the browser's local time, and the browser runs on this machine. Date.parse
// already reads a date-time that way, but a bare date as UTC.
const parseTime = (v: string | null) => (v ? Date.parse(/^\d{4}-\d\d-\d\d$/.test(v) ? `${v}T00:00:00` : v) : NaN);

// Bound to loopback only: the database holds everything that passed through the sessions.
export function serve(db: Database, port: number, gapMs: number) {
  const calendar = new Calendar(db, gapMs);
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    development: false,
    routes: {
      "/": index,
      "/calendar": calendarPage,
      "/api/sessions": loopbackOnly((req) =>
        Response.json(listSessions(db, filter(new URL(req.url).searchParams, 100))),
      ),
      "/api/search": loopbackOnly((req) => {
        const p = new URL(req.url).searchParams;
        const terms = (p.get("q") ?? "").split(/\s+/).filter(Boolean);
        if (terms.length === 0) return Response.json([]);
        return Response.json(search(db, terms, filter(p, 100)).map((h) => ({ ...h, text: snippet(h.text, terms) })));
      }),
      "/api/sessions/:id": loopbackOnly((req) => Response.json(getSession(db, req.params.id))),
      "/api/events": loopbackOnly((req) => {
        const p = new URL(req.url).searchParams;
        const start = parseTime(p.get("start"));
        const end = parseTime(p.get("end"));
        if (Number.isNaN(start) || Number.isNaN(end)) return new Response("invalid start or end", { status: 400 });
        return Response.json(eventsBetween(calendar.sessions(), start, end));
      }),
    },
    fetch: () => new Response("not found", { status: 404 }),
  });
}
