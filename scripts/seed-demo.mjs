// Seeds the demo database directly via the store (UTF-8 safe, no shell quoting).
import { MemoryStore } from "../dist/db.js";

const store = new MemoryStore(process.env.AI_DIARY_DB_PATH);

const seed = [
  { content: "用户喜欢用 TypeScript 写 MCP 服务器，不需要本地 embedding 模型。", tags: ["偏好", "mcp"], category: "preference", importance: 5 },
  { content: "决定把记忆存到本地单个 SQLite 文件，用 FTS5 的 trigram 分词器支持中文检索。", tags: ["决策", "存储"], category: "decision", importance: 4 },
  { content: "Phase 5 adds a beautiful local web dashboard to browse, search and add memories.", tags: ["dashboard", "ui"], category: "event", importance: 3 },
  { content: "记得每天写日记，记录与 AI 的关键决策和偏好。", tags: ["日记", "习惯"], category: "habit", importance: 4 },
  { content: "The knowledge graph links related memories so the AI can traverse context.", tags: ["graph", "design"], category: "design", importance: 3 },
  { content: "Reflection consolidates scattered memories into a concise summary, like sleep.", tags: ["reflection", "design"], category: "design", importance: 4 },
];

const ids = seed.map((s) => store.remember(s).id);
store.link(ids[4], ids[5], "related");
store.link(ids[0], ids[1], "informs");
const col = store.createCollection("MCP Project", "Everything about building this server");
store.addToCollection(col.id, ids[0]);
store.addToCollection(col.id, ids[1]);
store.addToCollection(col.id, ids[2]);

console.log("seeded", ids.length, "memories at", store.path);
store.close();
