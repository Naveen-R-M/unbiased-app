import { test } from "node:test";
import assert from "node:assert/strict";
import { mcpApplyDecision, mcpConfigOverride, parseThreadMcp, serializeThreadMcp, mcpChipLabel, THREAD_MCP_FILE } from "./thread-mcp";

// Measured 2026-09-09: the Figma run started at 56,495 tokens, ~35k of them
// MCP tool schemas from four connected servers the task never used. The
// engine takes a per-thread override, so a conversation carries only what
// the user switched on for it.

test("the override disables every configured server the conversation has not enabled", () => {
  assert.deepEqual(mcpConfigOverride(["Honeycomb", "figma", "figma_mcp"], new Set(["figma_mcp"])), {
    mcp_servers: { Honeycomb: { enabled: false }, figma: { enabled: false } },
  });
});

test("nothing enabled disables everything; nothing configured is an empty table, never undefined", () => {
  assert.deepEqual(mcpConfigOverride(["a", "b"], new Set()), { mcp_servers: { a: { enabled: false }, b: { enabled: false } } });
  assert.deepEqual(mcpConfigOverride([], new Set(["ghost"])), { mcp_servers: {} });
});

test("an enabled name that is no longer configured is ignored, not written", () => {
  assert.deepEqual(mcpConfigOverride(["a"], new Set(["a", "gone"])), { mcp_servers: {} });
});

test("the store round-trips and tolerates garbage", () => {
  const m = new Map([["root-1", new Set(["figma_mcp", "Honeycomb"])], ["root-2", new Set<string>()]]);
  const text = serializeThreadMcp(m);
  assert.equal(text, JSON.stringify({ "root-1": ["Honeycomb", "figma_mcp"] }, null, 2), "sorted, and empty sets are dropped");
  assert.deepEqual(parseThreadMcp(text), new Map([["root-1", new Set(["Honeycomb", "figma_mcp"])]]));
  assert.deepEqual(parseThreadMcp("not json"), new Map());
  assert.deepEqual(parseThreadMcp('{"r":"nope","s":[1,"ok"]}'), new Map([["s", new Set(["ok"])]]), "non-arrays and non-strings are skipped");
  assert.equal(THREAD_MCP_FILE, "thread-mcp.json");
});

test("the chip says only on or off", () => {
  assert.equal(mcpChipLabel([]), "MCP off");
  assert.equal(mcpChipLabel(["figma_mcp"]), "MCP on");
  assert.equal(mcpChipLabel(["a", "b", "c"]), "MCP on", "the names live in the panel, not the chip");
});

test("a switch applies now on an idle thread, queues while a turn runs, and is only a note for a thread that has not started", () => {
  assert.equal(mcpApplyDecision({ threadId: null, running: false }), "pending-new-thread");
  assert.equal(mcpApplyDecision({ threadId: "t", running: false }), "apply");
  assert.equal(mcpApplyDecision({ threadId: "t", running: true }), "queue");
});
