import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

/** The accessibility bridge: apps, windows, and element trees as text with
 *  stable ids, plus actions on those elements. Lives in the unbiased-ax repo;
 *  this file is everything the app needs to find it, talk to it, and describe
 *  what it is about to do. No electron import, so it is tested under node. */

export const AX_PROTOCOL_VERSION = 1;
export const AX_REQUEST_TIMEOUT_MS = 10_000;

export type AxManifest = { entryPath: string; args: string[]; version: string; protocolVersion: number };

/** manifest.json beside the binary. Same shape as the learning sidecar's
 *  manifest, except runtime is "native": the entry is executed directly. */
export function readAxManifest(dir: string): AxManifest | { error: string } | null {
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  } catch (err) {
    return { error: `manifest.json is not readable JSON: ${String(err)}` };
  }
  if (typeof raw.protocolVersion !== "number") return { error: "manifest.json has no numeric protocolVersion" };
  if (raw.protocolVersion !== AX_PROTOCOL_VERSION) {
    return { error: `bridge speaks protocol ${raw.protocolVersion}, this app speaks ${AX_PROTOCOL_VERSION}` };
  }
  if (raw.runtime !== "native") return { error: `unsupported bridge runtime ${JSON.stringify(raw.runtime)}` };
  if (typeof raw.entry !== "string" || !raw.entry) return { error: "manifest.json has no entry" };
  const entryPath = resolve(dir, raw.entry);
  if (!entryPath.startsWith(resolve(dir) + sep)) return { error: `entry escapes the bundle: ${raw.entry}` };
  if (!existsSync(entryPath)) return { error: `entry does not exist: ${entryPath}` };
  return {
    entryPath,
    args: Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === "string") : [],
    protocolVersion: raw.protocolVersion,
    version: typeof raw.version === "string" ? raw.version : "unknown",
  };
}

/** Override → packaged Contents/Resources/ax → a sibling checkout found by
 *  walking up from appPath, so a git worktree under .claude/worktrees finds
 *  it too (the plain `..` guess does not). */
export function resolveAxDir(opts: { isPackaged: boolean; resourcesPath: string; appPath: string }): string {
  const override = process.env.UNBIASED_AX_DIR;
  if (override) return override;
  if (opts.isPackaged) return join(opts.resourcesPath, "ax");
  let at = opts.appPath;
  for (let i = 0; i < 8; i++) {
    const candidate = join(at, "unbiased-ax", "dist");
    if (existsSync(candidate)) return candidate;
    const up = dirname(at);
    if (up === at) break;
    at = up;
  }
  return join(opts.appPath, "..", "unbiased-ax", "dist");
}

export function axLooksInstalled(dir: string): boolean {
  try {
    return isAbsolute(dir) && statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export class AxError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AxError";
  }
}

export type AxResult = Record<string, unknown>;
type Pending = { resolve: (r: AxResult) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/** One long-running bridge process. Ids and diffs live in that process, so it
 *  is spawned once and kept. A request that gets no answer times out rather
 *  than hanging a turn; an exit rejects everything in flight. */
export class AxClient {
  private proc: ChildProcess | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  alive = false;
  trusted = false;

  constructor(
    private readonly manifest: AxManifest,
    private readonly timeoutMs = AX_REQUEST_TIMEOUT_MS,
  ) {}

  async start(): Promise<{ trusted: boolean; version: string }> {
    const proc = spawn(this.manifest.entryPath, this.manifest.args, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    this.alive = true;
    createInterface({ input: proc.stdout! }).on("line", (line) => this.onLine(line));
    createInterface({ input: proc.stderr! }).on("line", (line) => console.warn(`[ax] ${line}`));
    const died = (why: string) => {
      this.alive = false;
      // Node closes a dead child's stdout/stderr readers but never its stdin
      // writer; that one open pipe is enough to keep the event loop alive.
      proc.stdin?.destroy();
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new AxError("bridge_exited", why));
      }
      this.pending.clear();
    };
    proc.on("exit", (code, signal) => died(`unbiased-ax exited (${code ?? signal})`));
    proc.on("error", (err) => died(`unbiased-ax failed to start: ${err.message}`));
    const hello = await this.request("hello", {});
    if (hello.protocolVersion !== AX_PROTOCOL_VERSION) {
      this.stop();
      throw new AxError("protocol", `bridge speaks protocol ${String(hello.protocolVersion)}`);
    }
    this.trusted = hello.trusted === true;
    return { trusted: this.trusted, version: this.manifest.version };
  }

  /** `timeoutMs` overrides the client default for one call: a `windows` read
   *  can afford far less patience than a `tree` of a browser with fifty tabs. */
  request(method: string, params: Record<string, unknown>, timeoutMs = this.timeoutMs): Promise<AxResult> {
    if (!this.alive || !this.proc?.stdin) return Promise.reject(new AxError("bridge_exited", "unbiased-ax is not running"));
    const id = this.nextId++;
    return new Promise<AxResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AxError("timeout", `${method} did not answer within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin!.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  private onLine(line: string): void {
    let msg: { id?: unknown; result?: AxResult; error?: { code?: string; message?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not ours; the bridge only writes JSON to stdout
    }
    if (typeof msg.id !== "number") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new AxError(msg.error.code ?? "error", msg.error.message ?? "bridge error"));
    else p.resolve(msg.result ?? {});
  }

  stop(): void {
    this.proc?.stdin?.end();
    this.proc?.kill();
    this.alive = false;
  }
}

/** id -> element line, accumulated across every tree and diff the model saw of
 *  an app. A diff omits unchanged elements, so the last text alone cannot name
 *  an id the model read two turns ago; the index can. */
export function indexElementLines(text: string, into: Map<number, string> = new Map()): Map<number, string> {
  for (const line of text.split("\n")) {
    const m = /^[~+]?\s*(\d+)\s+(.*)$/.exec(line);
    if (m) into.set(Number(m[1]), m[2]!.trim());
  }
  return into;
}

/** What the approval card says: `press #643 in Brave — link "Tame Impala…"`,
 *  not a bare number. Kept short; the reason text below carries the rest. */
export function describeAxAction(tool: string, rawArgs: unknown, lines?: Map<number, string>): string {
  const a = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  const app = typeof a.app === "string" && a.app ? a.app : "the app";
  const clip = (s: string) => (s.length > 60 ? s.slice(0, 60) + "…" : s);
  switch (tool) {
    case "computer_apps":
      return "List running apps";
    case "computer_app_state":
      return `Read the UI of ${app}`;
    case "computer_raise":
      return `Bring ${app} to the front`;
    case "computer_act": {
      const id = typeof a.id === "number" ? a.id : null;
      const line = id !== null ? lines?.get(id) ?? null : null;
      const target = id !== null ? `#${id} in ${app}${line ? ` — ${clip(line)}` : ""}` : app;
      if (typeof a.key === "string") return `Press ${a.key} in ${app}`;
      if (typeof a.value === "string") return `Set ${target} to "${clip(a.value)}"`;
      return `${typeof a.action === "string" ? a.action : "press"} ${target}`;
    }
    default:
      return tool;
  }
}
