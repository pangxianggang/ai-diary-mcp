#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { EntryWithTags, MemoryStore } from "./db.js";

const store = new MemoryStore();

function parseTime(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? undefined : ms;
}

function formatEntry(e: EntryWithTags): string {
  const when = new Date(e.occurred_at).toISOString();
  const parts = [`#${e.id} [${when}]`];
  if (e.category) parts.push(`(${e.category})`);
  parts.push(`★${e.importance}`);
  if (e.archived) parts.push("[archived]");
  const header = parts.join(" ");
  const tags = e.tags.length > 0 ? `\n  tags: ${e.tags.join(", ")}` : "";
  return `${header}\n  ${e.content}${tags}`;
}

function formatList(entries: EntryWithTags[], emptyMsg: string): string {
  if (entries.length === 0) return emptyMsg;
  return entries.map(formatEntry).join("\n\n");
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

const server = new McpServer({
  name: "ai-diary-mcp",
  version: "0.1.0",
});

server.registerTool(
  "remember",
  {
    description:
      "Save a new memory / diary entry. Use this to persist anything worth recalling later: facts, decisions, preferences, events, context.",
    inputSchema: {
      content: z.string().min(1).describe("The memory text to store."),
      tags: z.array(z.string()).optional().describe("Optional tags for filtering."),
      category: z
        .string()
        .optional()
        .describe("Optional category, e.g. 'decision', 'preference', 'event'."),
      importance: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe("Importance 1-5 (default 3); higher ranks above ties."),
      occurred_at: z
        .string()
        .optional()
        .describe("When it happened (ISO 8601 or epoch ms). Defaults to now."),
    },
  },
  async (args) => {
    const entry = store.remember({
      content: args.content,
      tags: args.tags,
      category: args.category,
      importance: args.importance,
      occurredAt: parseTime(args.occurred_at),
    });
    return text(`Saved memory #${entry.id}.\n\n${formatEntry(entry)}`);
  },
);

server.registerTool(
  "recall",
  {
    description:
      "Search memories by text (full-text BM25 ranking, works with Chinese and other CJK text) plus optional tag/category/time filters. Use before answering to retrieve relevant context.",
    inputSchema: {
      query: z.string().optional().describe("Search text. Omit to browse by filters."),
      tags: z.array(z.string()).optional().describe("Only entries with any of these tags."),
      category: z.string().optional().describe("Only this category."),
      from: z.string().optional().describe("Earliest occurred_at (ISO 8601 or epoch ms)."),
      to: z.string().optional().describe("Latest occurred_at (ISO 8601 or epoch ms)."),
      include_archived: z.boolean().optional().describe("Include archived entries."),
      limit: z.number().int().min(1).max(200).optional().describe("Max results (default 20)."),
    },
  },
  async (args) => {
    const results = store.search({
      query: args.query,
      tags: args.tags,
      category: args.category,
      from: parseTime(args.from),
      to: parseTime(args.to),
      includeArchived: args.include_archived,
      limit: args.limit,
    });
    return text(formatList(results, "No matching memories."));
  },
);

server.registerTool(
  "recent",
  {
    description: "List the most recently created memories.",
    inputSchema: {
      limit: z.number().int().min(1).max(200).optional().describe("Max results (default 20)."),
      include_archived: z.boolean().optional(),
    },
  },
  async (args) => {
    const results = store.recent(args.limit ?? 20, args.include_archived ?? false);
    return text(formatList(results, "No memories yet."));
  },
);

server.registerTool(
  "timeline",
  {
    description: "Browse memories chronologically by when they occurred.",
    inputSchema: {
      from: z.string().optional().describe("Start (ISO 8601 or epoch ms)."),
      to: z.string().optional().describe("End (ISO 8601 or epoch ms)."),
      limit: z.number().int().min(1).max(500).optional().describe("Max results (default 100)."),
    },
  },
  async (args) => {
    const results = store.timeline(
      parseTime(args.from),
      parseTime(args.to),
      args.limit ?? 100,
    );
    return text(formatList(results, "No memories in this range."));
  },
);

server.registerTool(
  "get",
  {
    description: "Fetch a single memory by id, including its links to other memories.",
    inputSchema: { id: z.number().int().describe("Entry id.") },
  },
  async (args) => {
    const entry = store.get(args.id);
    if (!entry) return text(`No memory with id #${args.id}.`);
    const { outgoing, incoming } = store.linksFor(args.id);
    const linkLines: string[] = [];
    for (const l of outgoing) linkLines.push(`  -> #${l.to_id} (${l.relation})`);
    for (const l of incoming) linkLines.push(`  <- #${l.from_id} (${l.relation})`);
    const linksText = linkLines.length > 0 ? `\n\nlinks:\n${linkLines.join("\n")}` : "";
    return text(`${formatEntry(entry)}${linksText}`);
  },
);

server.registerTool(
  "update",
  {
    description: "Edit an existing memory. Only provided fields change; tags replace the full set when given.",
    inputSchema: {
      id: z.number().int(),
      content: z.string().optional(),
      tags: z.array(z.string()).optional(),
      category: z.string().nullable().optional(),
      importance: z.number().int().min(1).max(5).optional(),
      occurred_at: z.string().optional(),
    },
  },
  async (args) => {
    const entry = store.update(args.id, {
      content: args.content,
      tags: args.tags,
      category: args.category,
      importance: args.importance,
      occurredAt: parseTime(args.occurred_at),
    });
    if (!entry) return text(`No memory with id #${args.id}.`);
    return text(`Updated memory #${entry.id}.\n\n${formatEntry(entry)}`);
  },
);

server.registerTool(
  "forget",
  {
    description:
      "Forget a memory. By default it is archived (recoverable). Pass hard=true to delete permanently.",
    inputSchema: {
      id: z.number().int(),
      hard: z.boolean().optional().describe("Permanently delete instead of archiving."),
    },
  },
  async (args) => {
    const ok = store.forget(args.id, args.hard ?? false);
    if (!ok) return text(`No memory with id #${args.id}.`);
    return text(
      args.hard ? `Permanently deleted memory #${args.id}.` : `Archived memory #${args.id}.`,
    );
  },
);

server.registerTool(
  "link",
  {
    description:
      "Create a relationship between two memories to build a knowledge graph (e.g. 'caused', 'related', 'follows').",
    inputSchema: {
      from_id: z.number().int(),
      to_id: z.number().int(),
      relation: z.string().optional().describe("Relation label (default 'related')."),
    },
  },
  async (args) => {
    const link = store.link(args.from_id, args.to_id, args.relation ?? "related");
    if (!link) return text("One or both memories do not exist.");
    return text(`Linked #${link.from_id} -> #${link.to_id} (${link.relation}).`);
  },
);

server.registerTool(
  "list_tags",
  {
    description: "List all tags with how many memories use each.",
    inputSchema: {},
  },
  async () => {
    const tags = store.listTags();
    if (tags.length === 0) return text("No tags yet.");
    return text(tags.map((t) => `${t.tag} (${t.count})`).join("\n"));
  },
);

server.registerTool(
  "stats",
  {
    description: "Summary statistics about the memory store.",
    inputSchema: {},
  },
  async () => {
    const s = store.stats();
    const cats = s.categories
      .map((c) => `  ${c.category ?? "(none)"}: ${c.count}`)
      .join("\n");
    const range =
      s.earliest && s.latest
        ? `${new Date(s.earliest).toISOString()} … ${new Date(s.latest).toISOString()}`
        : "n/a";
    return text(
      [
        `entries (active): ${s.total}`,
        `archived: ${s.archived}`,
        `distinct tags: ${s.tags}`,
        `links: ${s.links}`,
        `time range: ${range}`,
        `categories:\n${cats || "  (none)"}`,
        `db: ${store.path}`,
      ].join("\n"),
    );
  },
);

server.registerTool(
  "export",
  {
    description: "Export memories as Markdown, optionally filtered by query/tags/category/time.",
    inputSchema: {
      query: z.string().optional(),
      tags: z.array(z.string()).optional(),
      category: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      limit: z.number().int().min(1).max(5000).optional(),
    },
  },
  async (args) => {
    const md = store.exportMarkdown({
      query: args.query,
      tags: args.tags,
      category: args.category,
      from: parseTime(args.from),
      to: parseTime(args.to),
      limit: args.limit,
    });
    return text(md);
  },
);

server.registerTool(
  "reflect",
  {
    description:
      "Gather related memories for consolidation. Returns the raw entries plus guidance; YOU (the calling model) should synthesize a concise summary and persist it with `remember` using category 'reflection'. The server stores no model of its own.",
    inputSchema: {
      topic: z.string().optional().describe("Topic to reflect on. Omit to reflect on recent memories."),
      limit: z.number().int().min(1).max(100).optional().describe("How many entries to pull (default 30)."),
    },
  },
  async (args) => {
    const limit = args.limit ?? 30;
    const entries = args.topic
      ? store.search({ query: args.topic, limit })
      : store.recent(limit);
    const guidance =
      "Synthesize the memories below into a concise summary capturing key facts, decisions, and patterns. " +
      "Then call `remember` with category 'reflection' (and relevant tags) to persist it. " +
      "Optionally `link` the new reflection to the source memories.";
    return text(`${guidance}\n\n---\n\n${formatList(entries, "No memories to reflect on.")}`);
  },
);

// Resources: let hosts attach memories directly as context.
server.resource(
  "recent-memories",
  "memory://recent",
  {
    description: "The 20 most recent diary entries as Markdown.",
    mimeType: "text/markdown",
  },
  async (uri: URL) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "text/markdown",
        text: store.exportMarkdown({ limit: 20 }),
      },
    ],
  }),
);

// Prompt templates for common journaling flows.
server.prompt(
  "recall-about",
  "Pull everything remembered about a topic.",
  { topic: z.string().describe("Topic to recall.") },
  ({ topic }: { topic: string }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Use the recall tool to find memories about "${topic}", then summarize what is known.`,
        },
      },
    ],
  }),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`ai-diary-mcp running. db: ${store.path}\n`);
}

main().catch((err) => {
  process.stderr.write(`ai-diary-mcp fatal: ${String(err)}\n`);
  process.exit(1);
});
