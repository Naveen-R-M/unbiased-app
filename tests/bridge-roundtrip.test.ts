import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { BrowserExtensionBridge } from "../src/main/browser-extension-bridge";

const PROTOCOL_VERSION = 1 as const;

function once(socket: WebSocket, event: "open" | "close"): Promise<void> {
  return new Promise((resolve) => socket.addEventListener(event, () => resolve(), { once: true }));
}

test("round-trips a command through the real bridge module", async () => {
  const tokenPath = join(await mkdtemp(join(tmpdir(), "unbiased-bridge-")), "token");
  const bridge = new BrowserExtensionBridge(tokenPath);
  bridge.start();
  const socket = new WebSocket("ws://127.0.0.1:32145");
  try {
    const token = bridge.pairingToken();
    await once(socket, "open");

    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "hello", extensionVersion: "0.0.1" }));
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "auth", token }));

    // Wait until the bridge marks itself connected before issuing a command.
    const deadline = Date.now() + 5_000;
    while (!bridge.connected() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(bridge.connected(), true, "extension did not authenticate in time");

    const commandReceived = new Promise<string>((resolve) => {
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as { type: string; id: string };
        if (message.type === "command") resolve(message.id);
      });
    });

    const resultPromise = bridge.call("browser_snapshot", {});
    const commandId = await Promise.race([
      commandReceived,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("command not received")), 5_000)),
    ]);

    socket.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: "result",
        id: commandId,
        ok: true,
        content: [{ kind: "text", text: "- button \"Click me\" [ref=e1]" }],
        meta: { url: "https://example.test/", title: "Example" },
      }),
    );

    const result = await Promise.race([
      resultPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("result timed out")), 5_000)),
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.id, commandId);
    assert.match(result.content[0]!.text, /Click me/);
  } finally {
    socket.close();
    bridge.stop();
    await rm(join(tokenPath, ".."), { recursive: true, force: true });
  }
});

test("rejects an unauthenticated command", async () => {
  const tokenPath = join(await mkdtemp(join(tmpdir(), "unbiased-bridge-")), "token");
  const bridge = new BrowserExtensionBridge(tokenPath);
  bridge.start();
  const socket = new WebSocket("ws://127.0.0.1:32145");
  try {
    await once(socket, "open");
    const closed = once(socket, "close");
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "hello", extensionVersion: "0.0.1" }));
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "command", id: "sneaky", tool: "browser_snapshot", args: {} }));
    await Promise.race([closed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("close timed out")), 5_000))]);
  } finally {
    socket.close();
    bridge.stop();
    await rm(join(tokenPath, ".."), { recursive: true, force: true });
  }
});
