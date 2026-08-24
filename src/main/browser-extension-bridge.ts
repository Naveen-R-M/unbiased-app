import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";

const PROTOCOL_VERSION = 1 as const;
const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_PORT = 32_145;
const REQUEST_TIMEOUT_MS = 30_000;

const helloMessage = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal("hello"),
  extensionVersion: z.string().min(1),
});

const authMessage = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal("auth"),
  token: z.string().min(16),
});

const heartbeatMessage = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal("heartbeat"),
  at: z.number().int().nonnegative(),
});

const resultMessage = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal("result"),
  id: z.string().min(1),
  ok: z.boolean(),
  content: z.array(z.object({ kind: z.literal("text"), text: z.string() })),
  meta: z
    .object({
      url: z.string().optional(),
      title: z.string().optional(),
      truncated: z.boolean().optional(),
    })
    .optional(),
});

type ResultMessage = z.infer<typeof resultMessage>;
type ExtensionTool = "browser_snapshot" | "browser_read" | "browser_click";
type PendingRequest = {
  timeout: ReturnType<typeof setTimeout>;
  resolve: (result: ResultMessage) => void;
  reject: (error: Error) => void;
};

function tokensEqual(received: string, expected: string): boolean {
  const receivedBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  return receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes);
}

function readOrCreateToken(path: string): string {
  if (existsSync(path)) {
    const stored = readFileSync(path, "utf8").trim();
    if (stored.length >= 16) return stored;
  }
  const token = randomBytes(32).toString("base64url");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return token;
}

export class BrowserExtensionBridge {
  private server: WebSocketServer | null = null;
  private extension: WebSocket | null = null;
  private requestNumber = 1;
  private pending = new Map<string, PendingRequest>();
  private readonly token: string;

  constructor(tokenPath: string) {
    this.token = readOrCreateToken(tokenPath);
  }

  start(): void {
    if (this.server) return;
    const server = new WebSocketServer({ host: BRIDGE_HOST, port: BRIDGE_PORT });
    this.server = server;
    server.on("connection", (socket) => this.handleConnection(socket));
    server.on("error", (error) => console.error("Browser extension bridge failed", error));
  }

  stop(): void {
    this.extension?.close(1001, "Unbiased is closing");
    this.extension = null;
    this.failPending(new Error("Browser extension bridge stopped."));
    this.server?.close();
    this.server = null;
  }

  connected(): boolean {
    return this.extension?.readyState === WebSocket.OPEN;
  }

  pairingToken(): string {
    return this.token;
  }

  async call(tool: ExtensionTool, args: Record<string, unknown>): Promise<ResultMessage> {
    const socket = this.extension;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Chrome extension is not connected.");
    const id = `extension-${this.requestNumber++}`;
    const result = new Promise<ResultMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${tool} timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { timeout, resolve, reject });
    });
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "command", id, tool, args }));
    return result;
  }

  private handleConnection(socket: WebSocket): void {
    let sawHello = false;
    let authenticated = false;
    socket.on("message", (raw) => {
      let value: unknown;
      try {
        value = JSON.parse(raw.toString());
      } catch {
        socket.close(1003, "Invalid JSON");
        return;
      }

      const hello = helloMessage.safeParse(value);
      if (hello.success && !authenticated) {
        sawHello = true;
        return;
      }

      const auth = authMessage.safeParse(value);
      if (auth.success && sawHello && !authenticated) {
        if (!tokensEqual(auth.data.token, this.token)) {
          socket.close(1008, "Authentication failed");
          return;
        }
        authenticated = true;
        if (this.extension && this.extension !== socket) this.extension.close(1000, "Replaced by a new connection");
        this.extension = socket;
        return;
      }

      if (!authenticated) {
        socket.close(1008, "Authenticate first");
        return;
      }
      if (heartbeatMessage.safeParse(value).success) return;

      const result = resultMessage.safeParse(value);
      if (!result.success) {
        socket.close(1003, "Invalid bridge message");
        return;
      }
      const pending = this.pending.get(result.data.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(result.data.id);
      pending.resolve(result.data);
    });

    socket.on("close", () => {
      if (this.extension !== socket) return;
      this.extension = null;
      this.failPending(new Error("Chrome extension disconnected."));
    });
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
