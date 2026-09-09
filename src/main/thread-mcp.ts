/** Per-conversation MCP servers.
 *
 *  Measured 2026-09-09 on a Figma task: the first request was 56,495 tokens
 *  before the model said a word, and ~35k of that was the tool schemas of
 *  four connected MCP servers the task never used (Figma remote 41 tools,
 *  Honeycomb 23, PostHog 1, Figma desktop 10). The engine fixes a thread's
 *  MCP set when the thread is created or loaded, and takes a per-thread
 *  `config` override in which `mcp_servers.<name>.enabled = false` removes a
 *  server for that thread only. So: nothing is on until the user turns it on
 *  for THIS conversation, and the override rides every start, resume and fork. */

export const THREAD_MCP_FILE = "thread-mcp.json";

/** The `config` override for one thread: every configured server the
 *  conversation has not enabled is switched off. Always an object — the
 *  engine accepts an empty table, and a caller that has to special-case
 *  undefined will one day forget to. Names that are enabled but no longer
 *  configured are simply not mentioned. */
export function mcpConfigOverride(
  configured: readonly string[],
  enabled: ReadonlySet<string>,
): { mcp_servers: Record<string, { enabled: false }> } {
  const mcp_servers: Record<string, { enabled: false }> = {};
  for (const name of configured) if (!enabled.has(name)) mcp_servers[name] = { enabled: false };
  return { mcp_servers };
}

/** The servers the engine actually holds as `[mcp_servers.*]` tables, which
 *  are the only ones a thread override can switch off.
 *
 *  Mirrors renderMCPServers/managedPluginServers in the engine wrapper
 *  (internal/engine/mcp.go): a server carrying an OAuth client SECRET is
 *  written as a managed plugin instead, and one switched off globally is not
 *  written at all. Measured 2026-09-09 by getting this wrong — an override
 *  naming google-drive invented `[mcp_servers.google-drive]` with no command
 *  and no url, and every turn died with "failed to load configuration:
 *  invalid transport". A client ID alone is not enough; only a secret routes
 *  a server down the plugin path. */
export function overridableServerNames(servers: readonly { name: string; enabled?: boolean; oauthClientSecret?: string }[]): string[] {
  return servers.filter((s) => s.enabled !== false && !s.oauthClientSecret).map((s) => s.name);
}

export function serializeThreadMcp(m: ReadonlyMap<string, ReadonlySet<string>>): string {
  const out: Record<string, string[]> = {};
  for (const [root, names] of m) if (names.size) out[root] = [...names].sort();
  return JSON.stringify(out, null, 2);
}

export function parseThreadMcp(text: string): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return m;
  }
  if (!parsed || typeof parsed !== "object") return m;
  for (const [root, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(v)) continue;
    const names = new Set(v.filter((x): x is string => typeof x === "string"));
    if (names.size) m.set(root, names);
  }
  return m;
}

/** The composer chip says only whether this conversation has any server on.
 *  The switches themselves live in the MCP panel under +: a second popover
 *  hanging off the composer sat on top of the + menu with both open at once,
 *  and the names are long enough that the chip grew with them. */
export function mcpChipLabel(enabled: readonly string[]): string {
  return enabled.length ? "MCP on" : "MCP off";
}

/** Measured 2026-09-09: thread/resume on a LOADED thread hands back the
 *  loaded session and ignores config; thread/unsubscribe then thread/resume
 *  re-creates it with the new set in ~2 s, same id, history intact. A resume
 *  mid-turn would kill the turn, so a running thread waits for turn/completed. */
export type McpApplyDecision = "apply" | "queue" | "pending-new-thread";

export function mcpApplyDecision(s: { threadId: string | null; running: boolean }): McpApplyDecision {
  if (!s.threadId) return "pending-new-thread";
  return s.running ? "queue" : "apply";
}
