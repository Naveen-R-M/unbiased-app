// EngineClient: spawns unbiased-app-engine and speaks the codex app-server
// JSON-RPC protocol over stdio (newline-delimited JSON).
//
// This is the only place in the app that knows a child process exists. The
// renderer sees typed events; the engine sees one well-behaved client. The
// framing and correlation logic mirrors the conformance client in
// unbiased-app-engine — that suite is the executable spec for this file.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";

type Pending = {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
};

export type EngineStatus =
  | { state: "starting" }
  | { state: "connected"; userAgent: string; engineVersion: string; codexHome: string }
  | { state: "exited"; code: number | null; detail: string };

export class EngineClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  /** Engine process id, for resource accounting. Null before start/after exit. */
  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  start(enginePath: string, extraEnv?: Record<string, string>): void {
    this.emitStatus({ state: "starting" });
    // Held in a local as well as on `this`, because every handler below has to
    // know WHICH process it is speaking for. A restart (stop() then start())
    // leaves the old child's events to arrive asynchronously, after the new
    // child is already live and owns `this.proc` and `this.pending` — so an
    // unguarded handler acts on the new engine's state using the dead one's
    // news. That surfaced as "engine exited with code null" sitting in the
    // footer while a perfectly healthy engine was running, and could reject
    // the new engine's in-flight handshake. `code` is null there because our
    // own stop() kills with SIGTERM rather than the child exiting on its own.
    const proc = spawn(enginePath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      // extraEnv lets the caller pin the API key for THIS launch (login flow)
      // so a stale process-level UNBIASED_API_KEY can't override the key the
      // user just signed in with.
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    this.proc = proc;

    const lines = createInterface({ input: proc.stdout });
    lines.on("line", (line) => {
      if (this.proc !== proc) return; // superseded: not our protocol stream
      const text = line.trim();
      if (!text) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(text);
      } catch {
        return; // not a protocol line; engines may burp non-JSON on stdout
      }
      this.dispatch(msg);
    });

    // Engine logs (RUST_LOG etc.) arrive on stderr; keep them out of the
    // protocol path but visible for debugging. Not gated on the identity
    // check: a dying engine's last words are the most useful ones.
    proc.stderr.on("data", (chunk: Buffer) => {
      console.error("[engine]", chunk.toString().trimEnd());
    });

    proc.on("exit", (code, signal) => {
      // Superseded by a newer child: its exit is ours to expect, not to
      // report, and `this.pending` no longer belongs to it.
      if (this.proc !== proc) return;
      // Name the signal. "code null" alone is what a kill looks like, and it
      // reads as a mystery crash to anyone who did not send the signal.
      const detail = signal
        ? `engine stopped (${signal})`
        : `engine exited with code ${code}`;
      for (const p of this.pending.values()) p.reject(new Error(detail));
      this.pending.clear();
      this.proc = null;
      this.emitStatus({ state: "exited", code, detail });
    });
  }

  stop(): void {
    this.proc?.kill();
    this.proc = null;
  }

  /** Send the initialize/initialized handshake; resolves with engine identity. */
  async handshake(appVersion: string): Promise<{ userAgent: string; codexHome: string }> {
    const result = (await this.request("initialize", {
      clientInfo: { name: "unbiased_app", title: "Unbiased", version: appVersion },
      // experimentalApi unlocks thread/start.experimentalRawEvents — the raw
      // item stream is the only client-visible copy of what a spawned
      // sub-agent was told (its task text never appears as a thread item).
      capabilities: { experimentalApi: true },
    })) as { userAgent: string; codexHome: string };
    this.notify("initialized");
    return result;
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const proc = this.proc;
    if (!proc) return Promise.reject(new Error("engine not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      proc.stdin.write(JSON.stringify({ method, id, params }) + "\n");
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.proc?.stdin.write(JSON.stringify(params ? { method, params } : { method }) + "\n");
  }

  /** Answer a server-initiated request (approvals etc.). */
  respond(id: number | string, result: Record<string, unknown>): void {
    this.proc?.stdin.write(JSON.stringify({ id, result }) + "\n");
  }

  private dispatch(msg: Record<string, unknown>): void {
    const { id, method } = msg as { id?: number | string; method?: string };
    if (method !== undefined && id !== undefined) {
      // Server-initiated request: the engine is asking US something
      // (command approval, file-change approval, user input).
      this.emit("server-request", msg);
      return;
    }
    if (method !== undefined) {
      this.emit("notification", msg);
      return;
    }
    if (typeof id === "number" && this.pending.has(id)) {
      const p = this.pending.get(id)!;
      this.pending.delete(id);
      if ("error" in msg) {
        p.reject(new Error(`rpc error: ${JSON.stringify(msg.error)}`));
      } else {
        p.resolve(msg.result);
      }
    }
  }

  private emitStatus(status: EngineStatus): void {
    this.emit("status", status);
  }
}

/** Engine version as reported in the initialize userAgent, e.g.
 *  "unbiased_app/0.147.0 (Mac OS 26.5.2; arm64) unknown (Unbiased; 1.0.0)". */
export function engineVersionFromUserAgent(userAgent: string): string {
  const m = /^[^/]+\/(\S+)/.exec(userAgent);
  return m ? m[1] : "unknown";
}
