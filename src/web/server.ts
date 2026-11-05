import type { Database } from "bun:sqlite";
import { getSession, listSessions, search, snippet, type Filter } from "../query";
import index from "./index.html";

function filter(p: URLSearchParams, defaultLimit: number): Filter {
  const since = p.get("since");
  return {
    project: p.get("project") || undefined,
    since: since ? new Date(`${since}T00:00:00`).toISOString() : undefined,
    limit: Number(p.get("limit")) || defaultLimit,
  };
}

// Bound to loopback only: the database holds everything that passed through the sessions.
export function serve(db: Database, port: number) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    development: false,
    routes: {
      "/": index,
      "/api/sessions": (req) => Response.json(listSessions(db, filter(new URL(req.url).searchParams, 100))),
      "/api/search": (req) => {
        const p = new URL(req.url).searchParams;
        const terms = (p.get("q") ?? "").split(/\s+/).filter(Boolean);
        if (terms.length === 0) return Response.json([]);
        return Response.json(search(db, terms, filter(p, 100)).map((h) => ({ ...h, text: snippet(h.text, terms) })));
      },
      "/api/sessions/:id": (req) => Response.json(getSession(db, req.params.id)),
    },
    fetch: () => new Response("not found", { status: 404 }),
  });
}
