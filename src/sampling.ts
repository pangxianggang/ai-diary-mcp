import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Borrows the host platform's model via MCP sampling. Returns null whenever
 * sampling is unavailable or fails, so every caller must degrade gracefully.
 * The server itself never ships or calls a model.
 */
export async function trySample(
  mcp: McpServer,
  userPrompt: string,
  options: { systemPrompt?: string; maxTokens?: number } = {},
): Promise<string | null> {
  const caps = mcp.server.getClientCapabilities();
  if (!caps?.sampling) return null;
  try {
    const result = await mcp.server.createMessage({
      messages: [
        { role: "user", content: { type: "text", text: userPrompt } },
      ],
      systemPrompt: options.systemPrompt,
      maxTokens: options.maxTokens ?? 512,
    });
    if (result.content.type === "text") return result.content.text;
    return null;
  } catch {
    return null;
  }
}

/** Expands a search query into related keywords using the host model. */
export async function expandQuery(
  mcp: McpServer,
  query: string,
): Promise<string[]> {
  const out = await trySample(
    mcp,
    `Expand this memory-search query into up to 6 alternative keywords or short phrases that capture the same intent (include synonyms; keep the original language). Return ONLY a JSON array of strings, no prose.\n\nQuery: ${query}`,
    {
      systemPrompt:
        "You expand search queries for a memory database. Output strict JSON arrays only.",
      maxTokens: 200,
    },
  );
  if (!out) return [];
  return parseStringArray(out).slice(0, 6);
}

/**
 * Re-ranks candidate ids by relevance to the query using the host model.
 * Returns an ordered id list, or null to keep the original order.
 */
export async function rerank(
  mcp: McpServer,
  query: string,
  candidates: { id: number; content: string }[],
): Promise<number[] | null> {
  if (candidates.length === 0) return null;
  const list = candidates
    .map((c) => `#${c.id}: ${c.content.slice(0, 200).replace(/\s+/g, " ")}`)
    .join("\n");
  const out = await trySample(
    mcp,
    `Given the query and candidate memories, return ONLY a JSON array of the memory ids ordered from most to least relevant. Drop clearly irrelevant ones.\n\nQuery: ${query}\n\nCandidates:\n${list}`,
    {
      systemPrompt:
        "You rank memory search results by relevance. Output strict JSON arrays of integers only.",
      maxTokens: 300,
    },
  );
  if (!out) return null;
  const ids = parseNumberArray(out);
  return ids.length > 0 ? ids : null;
}

function extractJson(text: string): string {
  const start = text.search(/[[]/);
  const end = text.lastIndexOf("]");
  if (start !== -1 && end !== -1 && end > start) {
    return text.slice(start, end + 1);
  }
  return text;
}

function parseStringArray(text: string): string[] {
  try {
    const parsed = JSON.parse(extractJson(text));
    if (Array.isArray(parsed)) {
      return parsed
        .filter((x): x is string => typeof x === "string")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
  } catch {
    /* fall through */
  }
  return [];
}

function parseNumberArray(text: string): number[] {
  try {
    const parsed = JSON.parse(extractJson(text));
    if (Array.isArray(parsed)) {
      return parsed
        .map((x) => (typeof x === "number" ? x : Number(x)))
        .filter((n) => Number.isInteger(n));
    }
  } catch {
    /* fall through */
  }
  return [];
}
