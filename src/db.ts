import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Entry {
  id: number;
  content: string;
  category: string | null;
  importance: number;
  created_at: number;
  updated_at: number;
  occurred_at: number;
  archived: number;
  content_hash: string;
}

export interface EntryWithTags extends Entry {
  tags: string[];
}

export interface Link {
  from_id: number;
  to_id: number;
  relation: string;
  created_at: number;
}

export interface Collection {
  id: number;
  name: string;
  description: string | null;
  created_at: number;
}

export interface CollectionWithCount extends Collection {
  count: number;
}

export interface GraphResult {
  nodes: EntryWithTags[];
  edges: Link[];
}

export interface DuplicatePair {
  a: EntryWithTags;
  b: EntryWithTags;
  score: number;
}

export interface SearchOptions {
  query?: string;
  tags?: string[];
  category?: string;
  collectionId?: number;
  from?: number;
  to?: number;
  includeArchived?: boolean;
  limit?: number;
}

/**
 * Resolves the on-disk location of the SQLite memory file.
 * Override with AI_DIARY_DB_PATH; otherwise a per-user data dir is used.
 */
export function resolveDbPath(): string {
  const override = process.env.AI_DIARY_DB_PATH;
  if (override && override.trim().length > 0) return override.trim();

  const base =
    process.platform === "win32"
      ? process.env.APPDATA ?? join(homedir(), "AppData", "Roaming")
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support")
        : process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");

  return join(base, "ai-diary", "memory.db");
}

function normalize(content: string): string {
  return content.trim().replace(/\s+/g, " ");
}

function hashContent(content: string): string {
  return createHash("sha256").update(normalize(content)).digest("hex");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY,
  content TEXT NOT NULL,
  category TEXT,
  importance INTEGER NOT NULL DEFAULT 3,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  occurred_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_entries_created ON entries(created_at);
CREATE INDEX IF NOT EXISTS idx_entries_occurred ON entries(occurred_at);
CREATE INDEX IF NOT EXISTS idx_entries_category ON entries(category);
CREATE INDEX IF NOT EXISTS idx_entries_hash ON entries(content_hash);

CREATE TABLE IF NOT EXISTS entry_tags (
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (entry_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_entry_tags_tag ON entry_tags(tag);

CREATE TABLE IF NOT EXISTS links (
  from_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  relation TEXT NOT NULL DEFAULT 'related',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id, relation)
);

CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_entries (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (collection_id, entry_id)
);
CREATE INDEX IF NOT EXISTS idx_collection_entries_entry ON collection_entries(entry_id);

CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  content,
  content='entries',
  content_rowid='id',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, content) VALUES('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO entries_fts(rowid, content) VALUES (new.id, new.content);
END;
`;

export class MemoryStore {
  private db: Database.Database;

  constructor(dbPath: string = resolveDbPath()) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  get path(): string {
    return this.db.name;
  }

  close(): void {
    this.db.close();
  }

  private tagsFor(entryId: number): string[] {
    const rows = this.db
      .prepare("SELECT tag FROM entry_tags WHERE entry_id = ? ORDER BY tag")
      .all(entryId) as { tag: string }[];
    return rows.map((r) => r.tag);
  }

  private withTags(entry: Entry): EntryWithTags {
    return { ...entry, tags: this.tagsFor(entry.id) };
  }

  private setTags(entryId: number, tags: string[]): void {
    this.db.prepare("DELETE FROM entry_tags WHERE entry_id = ?").run(entryId);
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO entry_tags(entry_id, tag) VALUES (?, ?)",
    );
    for (const raw of tags) {
      const tag = raw.trim();
      if (tag.length > 0) insert.run(entryId, tag);
    }
  }

  remember(input: {
    content: string;
    tags?: string[];
    category?: string;
    importance?: number;
    occurredAt?: number;
  }): EntryWithTags {
    const now = Date.now();
    const hash = hashContent(input.content);

    const existing = this.db
      .prepare("SELECT * FROM entries WHERE content_hash = ? AND archived = 0")
      .get(hash) as Entry | undefined;
    if (existing) {
      // Idempotent write: identical content is not duplicated.
      return this.withTags(existing);
    }

    const tx = this.db.transaction(() => {
      const info = this.db
        .prepare(
          `INSERT INTO entries(content, category, importance, created_at, updated_at, occurred_at, archived, content_hash)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
        )
        .run(
          input.content,
          input.category ?? null,
          clampImportance(input.importance),
          now,
          now,
          input.occurredAt ?? now,
          hash,
        );
      const id = Number(info.lastInsertRowid);
      if (input.tags && input.tags.length > 0) this.setTags(id, input.tags);
      return id;
    });

    const id = tx();
    return this.get(id)!;
  }

  get(id: number): EntryWithTags | null {
    const entry = this.db
      .prepare("SELECT * FROM entries WHERE id = ?")
      .get(id) as Entry | undefined;
    return entry ? this.withTags(entry) : null;
  }

  update(
    id: number,
    fields: {
      content?: string;
      tags?: string[];
      category?: string | null;
      importance?: number;
      occurredAt?: number;
    },
  ): EntryWithTags | null {
    const entry = this.db.prepare("SELECT * FROM entries WHERE id = ?").get(id) as
      | Entry
      | undefined;
    if (!entry) return null;

    const tx = this.db.transaction(() => {
      const content = fields.content ?? entry.content;
      this.db
        .prepare(
          `UPDATE entries SET content = ?, category = ?, importance = ?, occurred_at = ?, updated_at = ?, content_hash = ?
           WHERE id = ?`,
        )
        .run(
          content,
          fields.category === undefined ? entry.category : fields.category,
          fields.importance === undefined
            ? entry.importance
            : clampImportance(fields.importance),
          fields.occurredAt ?? entry.occurred_at,
          Date.now(),
          hashContent(content),
          id,
        );
      if (fields.tags !== undefined) this.setTags(id, fields.tags);
    });
    tx();
    return this.get(id);
  }

  /** Soft-delete by default (archive); pass hard=true to permanently remove. */
  forget(id: number, hard = false): boolean {
    const entry = this.db.prepare("SELECT id FROM entries WHERE id = ?").get(id);
    if (!entry) return false;
    if (hard) {
      this.db.prepare("DELETE FROM entries WHERE id = ?").run(id);
    } else {
      this.db
        .prepare("UPDATE entries SET archived = 1, updated_at = ? WHERE id = ?")
        .run(Date.now(), id);
    }
    return true;
  }

  recent(limit = 20, includeArchived = false): EntryWithTags[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM entries ${includeArchived ? "" : "WHERE archived = 0"}
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as Entry[];
    return rows.map((e) => this.withTags(e));
  }

  timeline(from?: number, to?: number, limit = 100): EntryWithTags[] {
    const clauses: string[] = ["archived = 0"];
    const args: unknown[] = [];
    if (from !== undefined) {
      clauses.push("occurred_at >= ?");
      args.push(from);
    }
    if (to !== undefined) {
      clauses.push("occurred_at <= ?");
      args.push(to);
    }
    args.push(limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM entries WHERE ${clauses.join(" AND ")}
         ORDER BY occurred_at ASC LIMIT ?`,
      )
      .all(...args) as Entry[];
    return rows.map((e) => this.withTags(e));
  }

  search(opts: SearchOptions): EntryWithTags[] {
    const limit = opts.limit ?? 20;
    const ftsQuery = buildFtsQuery(opts.query);

    const where: string[] = [];
    const args: unknown[] = [];

    if (!opts.includeArchived) where.push("e.archived = 0");
    if (opts.category) {
      where.push("e.category = ?");
      args.push(opts.category);
    }
    if (opts.from !== undefined) {
      where.push("e.occurred_at >= ?");
      args.push(opts.from);
    }
    if (opts.to !== undefined) {
      where.push("e.occurred_at <= ?");
      args.push(opts.to);
    }
    if (opts.tags && opts.tags.length > 0) {
      const placeholders = opts.tags.map(() => "?").join(", ");
      where.push(
        `e.id IN (SELECT entry_id FROM entry_tags WHERE tag IN (${placeholders}))`,
      );
      args.push(...opts.tags);
    }
    if (opts.collectionId !== undefined) {
      where.push(
        "e.id IN (SELECT entry_id FROM collection_entries WHERE collection_id = ?)",
      );
      args.push(opts.collectionId);
    }

    let sql: string;
    let bind: unknown[];

    if (ftsQuery) {
      // Full-text path: BM25 relevance, then importance / recency.
      const whereSql = where.length > 0 ? `AND ${where.join(" AND ")}` : "";
      sql = `SELECT e.* FROM entries_fts
             JOIN entries e ON e.id = entries_fts.rowid
             WHERE entries_fts MATCH ? ${whereSql}
             ORDER BY bm25(entries_fts), e.importance DESC, e.created_at DESC
             LIMIT ?`;
      bind = [ftsQuery, ...args, limit];
    } else if (opts.query && opts.query.trim().length > 0) {
      // Short-query fallback: substring LIKE when below trigram threshold.
      const whereSql = where.length > 0 ? `AND ${where.join(" AND ")}` : "";
      sql = `SELECT e.* FROM entries e
             WHERE e.content LIKE ? ${whereSql}
             ORDER BY e.importance DESC, e.created_at DESC
             LIMIT ?`;
      bind = [`%${opts.query.trim()}%`, ...args, limit];
    } else {
      // No query: pure metadata browse.
      const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
      sql = `SELECT e.* FROM entries e ${whereSql}
             ORDER BY e.importance DESC, e.created_at DESC
             LIMIT ?`;
      bind = [...args, limit];
    }

    const rows = this.db.prepare(sql).all(...bind) as Entry[];
    return rows.map((e) => this.withTags(e));
  }

  link(fromId: number, toId: number, relation = "related"): Link | null {
    const a = this.db.prepare("SELECT id FROM entries WHERE id = ?").get(fromId);
    const b = this.db.prepare("SELECT id FROM entries WHERE id = ?").get(toId);
    if (!a || !b) return null;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO links(from_id, to_id, relation, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(fromId, toId, relation, now);
    return { from_id: fromId, to_id: toId, relation, created_at: now };
  }

  linksFor(id: number): { outgoing: Link[]; incoming: Link[] } {
    const outgoing = this.db
      .prepare("SELECT * FROM links WHERE from_id = ?")
      .all(id) as Link[];
    const incoming = this.db
      .prepare("SELECT * FROM links WHERE to_id = ?")
      .all(id) as Link[];
    return { outgoing, incoming };
  }

  /** Breadth-first traversal of the link graph around an entry. */
  graph(id: number, depth = 1): GraphResult | null {
    const root = this.get(id);
    if (!root) return null;
    const visited = new Set<number>([id]);
    const edges: Link[] = [];
    let frontier = [id];
    for (let d = 0; d < Math.max(0, depth); d++) {
      const next: number[] = [];
      for (const node of frontier) {
        const { outgoing, incoming } = this.linksFor(node);
        for (const l of [...outgoing, ...incoming]) {
          edges.push(l);
          for (const neighbor of [l.from_id, l.to_id]) {
            if (!visited.has(neighbor)) {
              visited.add(neighbor);
              next.push(neighbor);
            }
          }
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
    const nodes: EntryWithTags[] = [];
    for (const nodeId of visited) {
      const e = this.get(nodeId);
      if (e) nodes.push(e);
    }
    const seen = new Set<string>();
    const uniqueEdges = edges.filter((l) => {
      const key = `${l.from_id}->${l.to_id}:${l.relation}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { nodes, edges: uniqueEdges };
  }

  createCollection(name: string, description?: string): Collection {
    const now = Date.now();
    this.db
      .prepare(
        "INSERT OR IGNORE INTO collections(name, description, created_at) VALUES (?, ?, ?)",
      )
      .run(name, description ?? null, now);
    return this.db
      .prepare("SELECT * FROM collections WHERE name = ?")
      .get(name) as Collection;
  }

  listCollections(): CollectionWithCount[] {
    return this.db
      .prepare(
        `SELECT c.*, COUNT(ce.entry_id) AS count
         FROM collections c
         LEFT JOIN collection_entries ce ON ce.collection_id = c.id
         GROUP BY c.id ORDER BY c.name ASC`,
      )
      .all() as CollectionWithCount[];
  }

  addToCollection(collectionId: number, entryId: number): boolean {
    const c = this.db
      .prepare("SELECT id FROM collections WHERE id = ?")
      .get(collectionId);
    const e = this.db.prepare("SELECT id FROM entries WHERE id = ?").get(entryId);
    if (!c || !e) return false;
    this.db
      .prepare(
        "INSERT OR IGNORE INTO collection_entries(collection_id, entry_id, added_at) VALUES (?, ?, ?)",
      )
      .run(collectionId, entryId, Date.now());
    return true;
  }

  removeFromCollection(collectionId: number, entryId: number): boolean {
    const info = this.db
      .prepare(
        "DELETE FROM collection_entries WHERE collection_id = ? AND entry_id = ?",
      )
      .run(collectionId, entryId);
    return info.changes > 0;
  }

  collectionEntries(collectionId: number, limit = 200): EntryWithTags[] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM collection_entries ce
         JOIN entries e ON e.id = ce.entry_id
         WHERE ce.collection_id = ? AND e.archived = 0
         ORDER BY ce.added_at DESC LIMIT ?`,
      )
      .all(collectionId, limit) as Entry[];
    return rows.map((e) => this.withTags(e));
  }

  /** Finds near-duplicate active entries via trigram Jaccard similarity. */
  findDuplicates(threshold = 0.6, limit = 50): DuplicatePair[] {
    const entries = this.recent(2000);
    const grams = entries.map((e) => trigramSet(e.content));
    const pairs: DuplicatePair[] = [];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const score = jaccard(grams[i], grams[j]);
        if (score >= threshold) {
          pairs.push({ a: entries[i], b: entries[j], score });
        }
      }
    }
    pairs.sort((x, y) => y.score - x.score);
    return pairs.slice(0, limit);
  }

  listTags(): { tag: string; count: number }[] {
    return this.db
      .prepare(
        `SELECT t.tag AS tag, COUNT(*) AS count
         FROM entry_tags t JOIN entries e ON e.id = t.entry_id
         WHERE e.archived = 0
         GROUP BY t.tag ORDER BY count DESC, t.tag ASC`,
      )
      .all() as { tag: string; count: number }[];
  }

  stats(): {
    total: number;
    archived: number;
    tags: number;
    links: number;
    categories: { category: string | null; count: number }[];
    earliest: number | null;
    latest: number | null;
  } {
    const total = (
      this.db.prepare("SELECT COUNT(*) c FROM entries WHERE archived = 0").get() as {
        c: number;
      }
    ).c;
    const archived = (
      this.db.prepare("SELECT COUNT(*) c FROM entries WHERE archived = 1").get() as {
        c: number;
      }
    ).c;
    const tags = (
      this.db
        .prepare("SELECT COUNT(DISTINCT tag) c FROM entry_tags")
        .get() as { c: number }
    ).c;
    const links = (
      this.db.prepare("SELECT COUNT(*) c FROM links").get() as { c: number }
    ).c;
    const categories = this.db
      .prepare(
        `SELECT category, COUNT(*) AS count FROM entries WHERE archived = 0
         GROUP BY category ORDER BY count DESC`,
      )
      .all() as { category: string | null; count: number }[];
    const range = this.db
      .prepare(
        "SELECT MIN(occurred_at) lo, MAX(occurred_at) hi FROM entries WHERE archived = 0",
      )
      .get() as { lo: number | null; hi: number | null };
    return {
      total,
      archived,
      tags,
      links,
      categories,
      earliest: range.lo,
      latest: range.hi,
    };
  }

  exportMarkdown(opts: SearchOptions = {}): string {
    const entries = opts.query
      ? this.search({ ...opts, limit: opts.limit ?? 1000 })
      : this.timeline(opts.from, opts.to, opts.limit ?? 1000);

    const lines: string[] = ["# AI Diary Export", ""];
    for (const e of entries) {
      const when = new Date(e.occurred_at).toISOString();
      lines.push(`## #${e.id} — ${when}`);
      const meta: string[] = [];
      if (e.category) meta.push(`category: ${e.category}`);
      meta.push(`importance: ${e.importance}`);
      if (e.tags.length > 0) meta.push(`tags: ${e.tags.join(", ")}`);
      lines.push(`> ${meta.join(" · ")}`, "", e.content, "");
    }
    return lines.join("\n");
  }
}

function trigramSet(text: string): Set<string> {
  const s = text.toLowerCase().replace(/\s+/g, " ").trim();
  const set = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i++) set.add(s.slice(i, i + 3));
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const g of small) if (large.has(g)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function clampImportance(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value)) return 3;
  return Math.max(1, Math.min(5, Math.round(value)));
}

/**
 * Builds an FTS5 trigram query. Tokens shorter than 3 chars cannot be indexed
 * by the trigram tokenizer, so they are dropped here and handled by the LIKE
 * fallback in `search`. Returns null when no usable token remains.
 */
export function buildFtsQuery(query: string | undefined): string | null {
  if (!query) return null;
  const tokens = query
    .trim()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" AND ");
}
