import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryStore } from "./db.js";
import { gitSnapshot } from "./history.js";

const store = new MemoryStore();
const PUBLIC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const PORT = Number(process.env.AI_DIARY_PORT ?? 4178);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (rel.includes("..")) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const file = join(PUBLIC_DIR, rel);
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

function num(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const { pathname } = url;
    const q = url.searchParams;

    if (!pathname.startsWith("/api/")) {
      await serveStatic(res, pathname);
      return;
    }

    if (req.method === "GET" && pathname === "/api/stats") {
      return sendJson(res, 200, store.stats());
    }
    if (req.method === "GET" && pathname === "/api/tags") {
      return sendJson(res, 200, store.listTags());
    }
    if (req.method === "GET" && pathname === "/api/collections") {
      return sendJson(res, 200, store.listCollections());
    }
    if (req.method === "GET" && pathname === "/api/entries") {
      const results = store.search({
        query: q.get("q") ?? undefined,
        category: q.get("category") ?? undefined,
        tags: q.get("tag") ? [q.get("tag") as string] : undefined,
        collectionId: num(q.get("collection")),
        limit: num(q.get("limit")) ?? 50,
      });
      return sendJson(res, 200, results);
    }
    if (req.method === "GET" && pathname === "/api/timeline") {
      return sendJson(
        res,
        200,
        store.timeline(num(q.get("from")), num(q.get("to")), num(q.get("limit")) ?? 200),
      );
    }
    if (req.method === "GET" && pathname === "/api/duplicates") {
      return sendJson(res, 200, store.findDuplicates(num(q.get("threshold")) ?? 0.6));
    }
    const entryMatch = pathname.match(/^\/api\/entry\/(\d+)$/);
    if (req.method === "GET" && entryMatch) {
      const id = Number(entryMatch[1]);
      const entry = store.get(id);
      if (!entry) return sendJson(res, 404, { error: "not found" });
      return sendJson(res, 200, { entry, links: store.linksFor(id) });
    }
    const graphMatch = pathname.match(/^\/api\/graph\/(\d+)$/);
    if (req.method === "GET" && graphMatch) {
      const g = store.graph(Number(graphMatch[1]), num(q.get("depth")) ?? 2);
      if (!g) return sendJson(res, 404, { error: "not found" });
      return sendJson(res, 200, g);
    }

    if (req.method === "POST" && pathname === "/api/remember") {
      const body = (await readBody(req)) as {
        content?: string;
        tags?: string[];
        category?: string;
        importance?: number;
      };
      if (!body.content || body.content.trim() === "") {
        return sendJson(res, 400, { error: "content required" });
      }
      const entry = store.remember({
        content: body.content,
        tags: body.tags,
        category: body.category,
        importance: body.importance,
      });
      return sendJson(res, 200, entry);
    }
    if (req.method === "POST" && pathname === "/api/forget") {
      const body = (await readBody(req)) as { id?: number; hard?: boolean };
      if (typeof body.id !== "number") return sendJson(res, 400, { error: "id required" });
      return sendJson(res, 200, { ok: store.forget(body.id, body.hard ?? false) });
    }
    if (req.method === "POST" && pathname === "/api/snapshot") {
      const body = (await readBody(req)) as { message?: string };
      return sendJson(res, 200, gitSnapshot(store.path, body.message));
    }

    sendJson(res, 404, { error: "unknown endpoint" });
  } catch (err) {
    sendJson(res, 500, { error: String(err) });
  }
});

server.listen(PORT, () => {
  process.stdout.write(
    `ai-diary dashboard running at http://localhost:${PORT}\ndb: ${store.path}\n`,
  );
});
