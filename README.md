# ai-diary-mcp

A **local-first MCP server** that gives any AI a private long-term memory — its own diary / journal.

- **Zero models, zero network, zero subscription.** All data lives in a single SQLite file on your machine.
- **No embeddings needed.** Retrieval uses SQLite **FTS5 full-text search with BM25 ranking** and a **trigram tokenizer**, so search works great for English *and* Chinese / other CJK text. The "thinking" (summaries, tagging, reflection) is delegated to the model your editor/platform already runs.
- **Works on every MCP host:** Claude Desktop, Cursor, Windsurf, Cline, VS Code, Zed, and anything else that speaks MCP over stdio.

## Design philosophy

> The server is the **hippocampus** — fast storage, structure, and retrieval.
> Your platform's model is the **cortex** — it reasons, summarizes, and decides what to remember.

The server never calls an LLM and never goes online. That keeps it private, free, and trivially portable.

## Quick start

```bash
git clone https://github.com/pangxianggang/ai-diary-mcp.git
cd ai-diary-mcp
npm install
npm run build
```

That produces `dist/index.js`, a stdio MCP server you can point any client at.

Run the self-test:

```bash
npm run smoke
```

## Where memories are stored

A single SQLite file:

| OS      | Default path                                         |
| ------- | ---------------------------------------------------- |
| Windows | `%APPDATA%\ai-diary\memory.db`                       |
| macOS   | `~/Library/Application Support/ai-diary/memory.db`   |
| Linux   | `$XDG_DATA_HOME/ai-diary/memory.db` (or `~/.local/share/...`) |

Override with the `AI_DIARY_DB_PATH` environment variable. Back up by copying the file. You can even keep it in a git repo for versioned memory history.

## Connecting it to a client

Use the absolute path to the built `dist/index.js`.

### Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "ai-diary": {
      "command": "node",
      "args": ["/absolute/path/to/ai-diary-mcp/dist/index.js"]
    }
  }
}
```

### Cursor

`~/.cursor/mcp.json` (or Settings → MCP):

```json
{
  "mcpServers": {
    "ai-diary": {
      "command": "node",
      "args": ["/absolute/path/to/ai-diary-mcp/dist/index.js"]
    }
  }
}
```

### Windsurf / Cline / Zed / VS Code

All use the same shape — a server entry with `command: "node"` and `args` pointing at `dist/index.js`. Add an `env` block to relocate the database:

```json
{
  "mcpServers": {
    "ai-diary": {
      "command": "node",
      "args": ["/absolute/path/to/ai-diary-mcp/dist/index.js"],
      "env": { "AI_DIARY_DB_PATH": "/absolute/path/to/my-memory.db" }
    }
  }
}
```

Restart the client after editing its config.

## Tools

| Tool         | What it does |
| ------------ | ------------ |
| `remember`   | Save a memory (`content`, optional `tags`, `category`, `importance` 1–5, `occurred_at`). Identical content is de-duplicated. |
| `recall`     | Search by text (FTS5 BM25, CJK-aware) with optional `tags` / `category` / time filters. |
| `recent`     | List the most recently created memories. |
| `timeline`   | Browse chronologically by when things occurred. |
| `get`        | Fetch one memory by id, including its links. |
| `update`     | Edit an existing memory. |
| `forget`     | Archive (default) or hard-delete a memory. |
| `link`       | Connect two memories into a knowledge graph (e.g. `caused`, `related`). |
| `list_tags`  | All tags with usage counts. |
| `stats`      | Totals, categories, time range, db location. |
| `export`     | Export memories as Markdown. |
| `reflect`    | Pull related memories so the host model can summarize and persist a consolidated "reflection". |

### Resources & prompts

- Resource `memory://recent` — the 20 most recent entries as Markdown, attachable as context.
- Prompt `recall-about` — a template that recalls and summarizes everything about a topic.

## How search works (without embeddings)

1. **FTS5 + BM25** ranks entries by relevance. The **trigram** tokenizer indexes 3-character sequences, which is what makes substring and CJK search work.
2. **Metadata filters** (tags, category, time range, importance) narrow results.
3. Queries shorter than 3 characters fall back to a `LIKE` substring scan.
4. Optional: a host that supports MCP *sampling* can expand queries or re-rank results — but the core works fully without it.

## Development

```bash
npm run dev        # tsc --watch
npm run typecheck  # type-check only
npm run smoke      # in-memory end-to-end check
```

## License

MIT
