import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./db.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  process.stdout.write(`ok: ${msg}\n`);
}

const dir = mkdtempSync(join(tmpdir(), "ai-diary-smoke-"));
const dbPath = join(dir, "memory.db");
const store = new MemoryStore(dbPath);

try {
  const a = store.remember({
    content: "用户喜欢用 TypeScript 写 MCP 服务器，不需要本地 embedding 模型。",
    tags: ["偏好", "mcp"],
    category: "preference",
    importance: 5,
  });
  const b = store.remember({
    content: "Decided to store memories in a single local SQLite file with FTS5.",
    tags: ["decision", "storage"],
    category: "decision",
  });
  assert(a.id > 0 && b.id > 0, "remember returns ids");
  assert(a.tags.includes("偏好"), "tags persisted");

  const dup = store.remember({ content: a.content });
  assert(dup.id === a.id, "identical content is deduplicated");

  const cn = store.search({ query: "TypeScript" });
  assert(cn.some((e) => e.id === a.id), "english token search via FTS5 trigram");

  const cn2 = store.search({ query: "服务器" });
  assert(cn2.some((e) => e.id === a.id), "chinese (CJK) search via FTS5 trigram");

  const short = store.search({ query: "MCP" });
  assert(short.some((e) => e.id === a.id), "search finds 'MCP' substring");

  const byTag = store.search({ tags: ["decision"] });
  assert(byTag.length === 1 && byTag[0].id === b.id, "tag filter");

  const byCat = store.search({ category: "preference" });
  assert(byCat.length === 1 && byCat[0].id === a.id, "category filter");

  const linked = store.link(a.id, b.id, "informs");
  assert(linked !== null, "link created");
  assert(store.linksFor(a.id).outgoing.length === 1, "outgoing link present");

  const updated = store.update(b.id, { importance: 1, tags: ["decision"] });
  assert(updated?.importance === 1, "update importance");
  assert(updated?.tags.length === 1, "update replaces tags");

  store.forget(b.id);
  assert(store.search({ tags: ["decision"] }).length === 0, "archived hidden by default");
  assert(store.search({ tags: ["decision"], includeArchived: true }).length === 1, "archived visible when requested");

  const tags = store.listTags();
  assert(tags.some((t) => t.tag === "偏好"), "list_tags includes active tags");

  const s = store.stats();
  assert(s.total === 1 && s.archived === 1, "stats counts active/archived");

  const md = store.exportMarkdown({});
  assert(md.includes("# AI Diary Export"), "markdown export header");

  // Phase 3: collections
  const col = store.createCollection("project", "MCP work");
  assert(col.id > 0, "create collection");
  assert(store.addToCollection(col.id, a.id), "add to collection");
  const colList = store.listCollections();
  assert(colList.some((c) => c.id === col.id && c.count === 1), "list collections with count");
  assert(store.search({ collectionId: col.id }).some((e) => e.id === a.id), "search by collection filter");
  assert(store.collectionEntries(col.id).length === 1, "collection entries");
  assert(store.removeFromCollection(col.id, a.id), "remove from collection");

  // Phase 3: knowledge graph
  const c1 = store.remember({ content: "Graph node alpha about MCP transport." });
  const c2 = store.remember({ content: "Graph node beta about SQLite storage." });
  const c3 = store.remember({ content: "Graph node gamma about FTS5 ranking." });
  store.link(c1.id, c2.id, "related");
  store.link(c2.id, c3.id, "related");
  const g1 = store.graph(c1.id, 1);
  assert(g1 !== null && g1.nodes.some((n) => n.id === c2.id), "graph depth 1 reaches neighbor");
  const g2 = store.graph(c1.id, 2);
  assert(g2 !== null && g2.nodes.some((n) => n.id === c3.id), "graph depth 2 reaches 2-hop node");

  // Phase 4: duplicate detection
  store.remember({ content: "The quick brown fox jumps over the lazy dog near the river." });
  store.remember({ content: "The quick brown fox jumps over the lazy dog beside the river." });
  const dups = store.findDuplicates(0.6);
  assert(dups.length >= 1 && dups[0].score >= 0.6, "find near-duplicate pair");

  process.stdout.write("\nALL SMOKE TESTS PASSED\n");
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
