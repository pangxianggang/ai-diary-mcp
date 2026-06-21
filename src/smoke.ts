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

  process.stdout.write("\nALL SMOKE TESTS PASSED\n");
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
