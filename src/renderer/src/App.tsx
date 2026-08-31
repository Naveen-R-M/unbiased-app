import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
// The changelog SHIPS with the build so the Updates tab works offline and on
// first run, and is superseded at runtime by whatever the releases repo has —
// which is generated from this same file, so the two cannot disagree.
import changelogMd from "../../../CHANGELOG.md?raw";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import Prism from "prismjs";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-json";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-python";
import "prismjs/components/prism-go";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-toml";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-markdown";
import "prismjs/themes/prism-tomorrow.css";

type EngineStatus =
  | { state: "starting" }
  | { state: "connected"; userAgent: string; engineVersion: string; codexHome: string }
  | { state: "exited"; code: number | null; detail: string };

type CommandItem = {
  id?: string;
  command?: string;
  status?: string;
  exitCode?: number;
  aggregatedOutput?: string;
  output?: string;
};

type Entry =
  | { kind: "user"; text: string; annotations?: SentAnnotation[] }
  | { kind: "compaction" }
  | { kind: "assistant"; text: string; interrupted?: boolean; at?: number }
  // Sub-agent lifecycle row in the transcript flow (Codex-style
  // "Created an agent" / "Closed an agent" markers).
  | { kind: "agent"; event: string; name: string; path?: string; agentThreadId?: string; prompt?: string | null }
  // A scheduled task the agent created and the user approved. Carries the key
  // so the row can link through to the task it made.
  | { kind: "scheduled"; key: string; name: string; cadence: string }
  // A completed turn's work — everything before its final message —
  // collapsed under a "Worked for Ns" header, Codex-style.
  | { kind: "work"; duration: number | null; entries: Entry[] }
  | {
      kind: "command";
      itemId: string;
      command: string;
      status: string; // inProgress | completed | failed | declined | awaitingApproval | canceled
      exitCode?: number;
      output?: string;
      approval?: {
        /** The turn behind this card is gone — quitting the app is the usual
         *  way. Kept visible rather than dropped, because the request really
         *  was made; it just cannot be answered now. */
        expired?: boolean;
        requestId: string;
        reason: string | null;
        kind?: "command" | "fileChange" | "mcpTool";
        grantRoot?: string | null;
        /** The engine's own wording for the question. codex writes it for MCP
         *  tool calls and it is the only place the tool's name appears, so it
         *  is shown verbatim rather than rebuilt here. */
        message?: string | null;
        decision?: ApprovalDecision;
      };
    };

type ApprovalDecision = "accept" | "acceptForSession" | "decline";
// "main" or a dynamic side-chat pane ("side:<n>").
type PaneId = string;
type ThreadSummary = { id: string; title: string; createdAt?: string };
// A transcript excerpt staged for the next send, with an optional comment.
// The live Range (when still valid) keeps the excerpt tinted in the DOM.
// tag = what kind of thing was annotated (element tag, "selection",
// "link"); thumb = page screenshot for browser annotations.
type Annotation = { text: string; comment?: string; range?: Range; tag?: string; thumb?: string };
// What a sent user message keeps for its annotation card.
type SentAnnotation = { text: string; comment?: string; tag?: string; thumb?: string };
// A message composed while a turn was running — held above the composer
// until the turn finishes (or the user steers/edits/deletes it).
type QueuedMsg = {
  id: number;
  text: string; // display text for the transcript entry
  wire: string; // what actually goes to the engine
  attachments: Attachment[];
  annotations?: SentAnnotation[];
};
// kind: "image" sends as a localImage input item (model sees the pixels);
// everything else rides as a mention (engine pulls in the file's text).
// thumb is a small data-URL preview for the composer card.
type Attachment = { name: string; path: string; kind?: "image" | "folder" | "file"; thumb?: string };
type DirEntry = { name: string; dir: boolean };
type BrowserState = { id: number; url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean };
// How agent actions get approved — maps to engine approvalPolicy+sandbox
// pairs in the main process.
type AccessMode = "ask" | "auto" | "full";
const ACCESS_MODES: { id: AccessMode; name: string; desc: string; danger?: boolean }[] = [
  { id: "ask", name: "Ask for approval", desc: "Read-only — every command needs your approval" },
  { id: "auto", name: "Approve for me", desc: "Can edit project files and use the network; asks before writing elsewhere" },
  { id: "full", name: "Full access", desc: "Unrestricted commands and file access", danger: true },
];
type RefHit = { path: string; rel: string; line: number; text: string };
type DirtyFile = { file: string; plus: number; minus: number };
type ReviewLine = { t: "a" | "d" | "c"; no: number; text: string };
type ReviewHunk = { newStart: number; lines: ReviewLine[] };
type ReviewFile = { path: string; plus: number; minus: number; hunks: ReviewHunk[] };
type ReviewData = {
  files: ReviewFile[];
  plus: number;
  minus: number;
  branch: string;
  baseLabel: string;
  error?: string;
};
type BlameInfo = {
  hash?: string;
  author?: string;
  time?: number;
  summary?: string;
  uncommitted?: boolean;
  url?: string | null;
  error?: string;
};

// Monospace character width per font string, measured once — the code
// view is monospace, so line width = chars × charWidth.
const monoWidthCache = new Map<string, number>();
let measureCanvas: HTMLCanvasElement | null = null;
function monoCharWidth(font: string): number {
  const cached = monoWidthCache.get(font);
  if (cached !== undefined) return cached;
  measureCanvas ??= document.createElement("canvas");
  const ctx = measureCanvas.getContext("2d");
  if (!ctx) return 7.5;
  ctx.font = font;
  const w = ctx.measureText("0000000000").width / 10;
  monoWidthCache.set(font, w);
  return w;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** "just now", "40 minutes ago", "3 days ago", else a locale date. */
function relTime(ms: number): string {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) {
    const m = Math.floor(s / 60);
    return `${m} minute${m === 1 ? "" : "s"} ago`;
  }
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  if (s < 30 * 86400) {
    const d = Math.floor(s / 86400);
    return `${d} day${d === 1 ? "" : "s"} ago`;
  }
  return new Date(ms).toLocaleDateString();
}
type OpenFileInfo = {
  name: string;
  relPath: string;
  fullPath: string;
  content?: string;
  imageSrc?: string; // data URL — the viewer renders an image instead of code
  line?: number; // scroll target + highlight stripe (references navigation)
  error?: string;
};

/** Does an inline code chip look like a file reference worth opening? */
function looksLikeFilePath(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 260 || /\s/.test(t)) return false;
  if (t.includes("/") && /^[./~]?[\w.@/-]+\.[A-Za-z0-9]{1,8}$/.test(t)) return true;
  return /^[\w.-]+\.(ts|tsx|js|jsx|mjs|cjs|json|go|rs|py|sh|bash|zsh|toml|yaml|yml|css|scss|html|md|sql|txt|lock)$/.test(t);
}
type ProjectInfo = {
  name: string;
  path: string;
  icon?: string;
  color?: string | null;
  folders?: string[];
  threads: ThreadSummary[];
};
/** A thread we know exists because we just created it, but which the engine
 *  will not return from thread/list yet — verified: a list issued straight
 *  after thread/start does not include the new id. Without a stand-in row, a
 *  chat you start and leave running is invisible until its first turn ends,
 *  which for a long job reads as "it deleted my chat". */
type PendingThread = { id: string; title: string; projectPath: string | null };

/** Stand-in title until the engine names the thread — the first line of what
 *  was sent, which is roughly what it derives its own title from anyway. */
function provisionalTitle(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  if (!line) return "New chat";
  return line.length > 80 ? line.slice(0, 79) + "…" : line;
}

type SidebarData = {
  projects: ProjectInfo[];
  recents: ThreadSummary[];
  running?: string[];
};

/** The engine's thread list plus any thread it does not know about yet, so a
 *  chat is never missing from the nav between pressing Enter and the engine
 *  deciding it exists. A stand-in drops out the moment the real row lands —
 *  matched on id, so the handover never shows the thread twice. Pure so the
 *  merge can be tested without a renderer. */
function mergePendingThreads(sidebar: SidebarData, pending: PendingThread[]): SidebarData {
  if (pending.length === 0) return sidebar;
  const known = new Set([
    ...sidebar.projects.flatMap((p) => p.threads.map((t) => t.id)),
    ...sidebar.recents.map((t) => t.id),
  ]);
  const extra = pending.filter((p) => !known.has(p.id));
  if (extra.length === 0) return sidebar;
  const row = (p: PendingThread): ThreadSummary => ({ id: p.id, title: p.title });
  const paths = new Set(sidebar.projects.map((p) => p.path));
  return {
    ...sidebar,
    projects: sidebar.projects.map((pr) => {
      const mine = extra.filter((p) => p.projectPath === pr.path);
      return mine.length ? { ...pr, threads: [...mine.map(row), ...pr.threads] } : pr;
    }),
    // A stand-in whose project is gone still belongs somewhere visible.
    recents: [
      ...extra.filter((p) => !p.projectPath || !paths.has(p.projectPath)).map(row),
      ...sidebar.recents,
    ],
  };
}

// Project identity: 8 colors + a compact icon set (Codex-style customizer).
const PROJECT_COLORS = ["#E8E8E8", "#FF6B5E", "#FF9F43", "#FFD54F", "#66BB6A", "#42A5F5", "#AB7BF7", "#FF8AC2"];
const PROJECT_ICON_PATHS: Record<string, React.ReactNode> = {
  folder: <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.2 3.9A2 2 0 0 0 7.5 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />,
  code: <><path d="m8 8-4 4 4 4" /><path d="m16 8 4 4-4 4" /></>,
  terminal: <><path d="m4 17 6-5-6-5" /><path d="M12 19h8" /></>,
  book: <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" /></>,
  pencil: <><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></>,
  music: <><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></>,
  palette: <><circle cx="13.5" cy="6.5" r=".5" /><circle cx="17.5" cy="10.5" r=".5" /><circle cx="8.5" cy="7.5" r=".5" /><circle cx="6.5" cy="12.5" r=".5" /><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.7-.7 1.7-1.7 0-.4-.2-.8-.4-1.1-.3-.3-.4-.6-.4-1.1a1.7 1.7 0 0 1 1.7-1.7H17a5 5 0 0 0 5-5c0-4.6-4.5-8.4-10-8.4Z" /></>,
  flask: <><path d="M10 2v7.5L4.7 19a2 2 0 0 0 1.8 3h11a2 2 0 0 0 1.8-3L14 9.5V2" /><path d="M8.5 2h7" /><path d="M7 16h10" /></>,
  globe: <><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z" /></>,
  plane: <><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2Z" /></>,
  briefcase: <><rect x="2" y="7" width="20" height="14" rx="2" /><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" /></>,
  chart: <><path d="M3 3v16a2 2 0 0 0 2 2h16" /><path d="M7 16v-5" /><path d="M12 16V8" /><path d="M17 16v-3" /></>,
  heart: <path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2C10.5 3.5 9.3 3 7.5 3A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z" />,
  star: <path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1Z" />,
  wrench: <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />,
  paw: <><circle cx="11" cy="4" r="2" /><circle cx="18" cy="8" r="2" /><circle cx="4" cy="8" r="2" /><path d="M11 12a5 5 0 0 0-5 5c0 1.7 1.3 3 3 3 1 0 1.6-.5 2-1 .4.5 1 1 2 1 1.7 0 3-1.3 3-3a5 5 0 0 0-5-5Z" /></>,
  brain: <><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44A2.5 2.5 0 0 1 4 17.5v-11A2.5 2.5 0 0 1 6.5 4 2.5 2.5 0 0 1 9.5 2Z" /><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44A2.5 2.5 0 0 0 20 17.5v-11A2.5 2.5 0 0 0 17.5 4 2.5 2.5 0 0 0 14.5 2Z" /></>,
  leaf: <><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10Z" /><path d="M2 21c0-3 1.9-5.5 3.5-7" /></>,
};
function ProjectIcon({ icon, color, size = 16 }: { icon?: string; color?: string | null; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color ?? "currentColor"}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      {PROJECT_ICON_PATHS[icon ?? "folder"] ?? PROJECT_ICON_PATHS.folder}
    </svg>
  );
}

type BillingResult =
  | {
      ok: true;
      organization: { name: string };
      balanceCents: number | null;
      monthToDateSpendCents: number | null;
      spendSyncedAt: string | null;
      tokens: { input: number; cached: number; output: number } | null;
    }
  | { ok: false; error: string };

/** Cents → "$12.34". The platform reports fractional cents; round for display. */
function fmtMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

type UpdateInfo = { version: string; dmgUrl: string; sumsUrl: string | null };
type UpdatePhase = "downloading" | "verifying" | "installing" | "relaunching";

type WhoamiResult =
  | {
      ok: true;
      organization: { id: string; name: string };
      workload: { id: string; name: string };
      keyName: string;
      accessStatus: string;
      paretoRolloutPercent?: number | null;
    }
  | { ok: false; error: string; code?: string; status?: number };

/** What the browser sign-in shows while the platform waits for the person to
 *  confirm the code there. */
type DeviceStart =
  | { ok: true; userCode: string; verificationUri: string; verificationUriComplete: string; expiresIn: number }
  | { ok: false; error: string; code?: string };

// An approval request replayed when a backgrounded conversation reopens
// (same payload as the live chat:approval-request event, minus paneId).
/** A user-added MCP server, as stored in ~/.unbiased/mcp-servers.json and read
 *  by the supervisor at launch. Local (command) or remote (url), never both. */
type McpServerConfig = {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  bearerTokenEnvVar?: string;
  /** Set by the sign-in flow, never by the form. Declared so a later edit
   *  round-trips it instead of quietly dropping the registration. */
  oauthClientId?: string;
  startupTimeoutSec?: number;
  toolTimeoutSec?: number;
  enabledTools?: string[];
};
/** What the RUNNING engine reports — authoritative, and empty while the engine
 *  is down or a newly added server has not been picked up yet. */
type McpConnected = {
  name: string;
  authStatus?: string;
  tools?: Record<string, unknown>;
  serverInfo?: {
    name?: string;
    title?: string;
    version?: string;
    description?: string | null;
    /** MCP's own presentation metadata. Servers advertise these at
     *  initialize; the engine passes them through untouched, so they have
     *  been arriving here all along — just undeclared and unrendered. */
    icons?: { src?: string; mimeType?: string; sizes?: string }[] | null;
    websiteUrl?: string | null;
  } | null;
};
type McpStatusEvent = { name: string; status: string; error: string | null; failureReason: string | null };

/** One skill as the engine reports it. `scope` is the engine's own word:
 *  "repo" = found in the conversation's <cwd>/.codex/skills, "user" = a root we
 *  registered OR one another agent tool left in ~/.agents/skills, "system" =
 *  codex's own built-ins. Provenance comes from `path`, not from scope alone. */
/** The answer to "is this a skill, and what would I be installing?" — shared by
 *  the folder, zip and link paths so the UI has one shape to render. */
type SkillCheck = {
  ok: boolean;
  error?: string;
  warning?: string | null;
  path?: string;
  kind?: "folder" | "manifest";
  fromArchive?: boolean;
  name?: string;
  description?: string | null;
  bytes?: number;
  files?: number;
  sizeLabel?: string;
  /** Anything the agent might execute. Named before install, not after. */
  scripts?: string[];
};

type SkillEntry = {
  name: string;
  description?: string;
  shortDescription?: string | null;
  path: string;
  scope: string;
  enabled: boolean;
  dependencies?: { tools?: { type: string; value: string }[] } | null;
  interface?: { displayName?: string | null } | null;
};

type HeldApproval = {
  requestId: string;
  kind?: "command" | "fileChange" | "mcpTool";
  itemId: string | null;
  command: string;
  cwd: string | null;
  reason: string | null;
  grantRoot?: string | null;
  message?: string | null;
  // Present when the request came from a sub-agent's thread (multi-agent) —
  // the card renders in the parent's pane, tagged with the agent's name.
  agentName?: string;
};

// A spawned sub-agent (multi-agent v2): its own engine thread, grouped
// under the parent conversation. name = the model-chosen task name.
type SubAgent = {
  threadId: string;
  name: string;
  path: string;
  status: string;
  /** Which pane's conversation spawned it — set when rosters are merged, so a
   *  later push from one pane can't drop another pane's agents. */
  paneId?: PaneId;
};

// Scheduled tasks. The schedule shapes mirror the engine's own
// ScheduledTaskSchedule so records need no translation at either boundary;
// src/main/scheduler.ts holds the authoritative copy and the validation.
type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";

type ScheduleSpec =
  | { type: "hourly"; intervalHours: number; days?: Weekday[] | null }
  | { type: "daily"; time: string }
  | { type: "weekdays"; time: string }
  | { type: "weekly"; days: Weekday[]; time: string };

/** A stored task plus the fields main derives for display. */
type ScheduledTaskView = {
  key: string;
  name: string;
  prompt: string;
  schedule: ScheduleSpec;
  enabled: boolean;
  projectPath: string | null;
  createdAt: string;
  lastRunAt: string | null;
  lastStatus: "completed" | "failed" | "interrupted" | null;
  /** The agent's own verdict on whether the TASK got done. A completed turn
   *  whose verdict is "failed" is a failed run; a missing verdict is neither
   *  claimed as success nor as failure. */
  lastVerdict: "done" | "failed" | null;
  lastVerdictNote: string | null;
  lastError: string | null;
  lastThreadId: string | null;
  /** Set when the schedule elapsed while the app was closed. */
  missedAt: string | null;
  nextDueAt: string | null;
  running: boolean;
  /** The conversation a run is happening in, while it is happening. */
  runningThreadId: string | null;
};

declare global {
  interface Window {
    unbiased: {
      getEngineStatus: () => Promise<EngineStatus>;
      onEngineStatus: (cb: (status: EngineStatus) => void) => () => void;
      checkUpdate: () => Promise<UpdateInfo | { none: true }>;
      pendingUpdate: () => Promise<{ update: UpdateInfo | null; staged: { version: string } | null }>;
      downloadUpdate: () => Promise<{ ok: boolean; error?: string }>;
      applyUpdate: () => Promise<{ ok: boolean; error?: string }>;
      onUpdateStaged: (cb: (p: { version: string }) => void) => () => void;
      onUpdateAvailable: (cb: (p: UpdateInfo) => void) => () => void;
      onUpdateProgress: (cb: (p: { phase: UpdatePhase; percent: number }) => void) => () => void;
      onUpdateError: (cb: (p: { message: string }) => void) => () => void;
      authStatus: () => Promise<{ hasKey: boolean; source: "env" | "file" | null; browserSignIn: boolean }>;
      authValidate: (key?: string) => Promise<WhoamiResult>;
      authLogin: (key?: string) => Promise<WhoamiResult>;
      authLogout: (removeKey?: boolean) => Promise<{ ok: boolean; envKeyRemains: boolean }>;
      authDeviceStart: () => Promise<DeviceStart>;
      authDeviceWait: () => Promise<WhoamiResult>;
      authDeviceCancel: () => Promise<{ ok: boolean }>;
      sendMessage: (
        paneId: PaneId,
        text: string,
        attachments?: Attachment[],
      ) => Promise<{ turnId: string | null; threadId: string; created: boolean }>;
      chooseAttachments: () => Promise<{ attachments: Attachment[] }>;
      attachPaths: (paths: string[]) => Promise<{ attachments: Attachment[] }>;
      clipboardImage: () => Promise<{ attachment: Attachment | null }>;
      interrupt: (paneId: PaneId) => Promise<{ interrupted: boolean }>;
      compact: (paneId: PaneId) => Promise<{ ok: boolean; error?: string }>;
      onTurnStarted: (cb: (p: { paneId: PaneId; turnId: string | null }) => void) => () => void;
      onDelta: (cb: (p: { paneId: PaneId; delta: string }) => void) => () => void;
      onTurnCompleted: (
        cb: (p: { paneId: PaneId; status: string; error?: string | null; narrated?: boolean }) => void,
      ) => () => void;
      onThreadActivity: (cb: (p: { threadId: string; running: boolean }) => void) => () => void;
      setAccessMode: (mode: AccessMode) => Promise<{ mode: string }>;
      setWorkMode: (mode: string, dir?: string) => Promise<{ ok: boolean }>;
      setPlanMode: (on: boolean) => Promise<{ planMode: boolean }>;
      onPlan: (cb: (p: { paneId: PaneId; text: string }) => void) => () => void;
      listWorktrees: (project: string) => Promise<{ worktrees: { dir: string; branch: string }[] }>;
      removeWorktree: (dir: string) => Promise<{ ok: boolean; error?: string }>;
      saveTranscript: (threadId: string, entries: Entry[]) => Promise<{ ok: boolean }>;
      loadTranscript: (threadId: string) => Promise<{ entries: Entry[] | null }>;
      conversationInfo: () => Promise<{
        cwd: string | null;
        isWorktree: boolean;
        project: string | null;
        branch: string | null;
      }>;
      decideApproval: (
        requestId: string,
        decision: ApprovalDecision,
      ) => Promise<{ ok: boolean; expired?: boolean }>;
      liveApprovals: () => Promise<{ requestIds: string[] }>;
      mcpList: () => Promise<{ connected: McpConnected[]; configured: McpServerConfig[]; error: string | null; configError: string | null }>;
      mcpSave: (servers: McpServerConfig[]) => Promise<{ ok: boolean; error?: string }>;
      mcpApply: () => Promise<{ ok: boolean; busy?: boolean }>;
      onMcpStatus: (cb: (p: McpStatusEvent) => void) => () => void;
      skillsList: (cwd?: string | null) => Promise<{
        skills: SkillEntry[];
        cwd: string | null;
        roots: { bundled: string; global: string; project: string | null };
        error: string | null;
      }>;
      skillsSetEnabled: (path: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
      skillsReveal: (path: string, isDir?: boolean) => Promise<{ ok: boolean }>;
      skillsChoose: () => Promise<{ path: string | null }>;
      skillsValidate: (path: string) => Promise<SkillCheck>;
      skillsInstall: (p: { path: string; name: string; scope: "global" | "project"; cwd: string | null }) =>
        Promise<{ ok: boolean; error?: string }>;
      skillsRemove: (path: string, cwd: string | null) => Promise<{ ok: boolean; error?: string }>;
      pathForDroppedFile: (file: File) => string;
      skillsFetch: (url: string) => Promise<SkillCheck>;
      skillsLimits: () => Promise<{ maxBytes: number; maxFiles: number; maxDownload: number; label: string }>;
      scheduledList: () => Promise<{ tasks: ScheduledTaskView[]; engineReady: boolean }>;
      scheduledSave: (p: {
        key?: string | null;
        name: string;
        prompt: string;
        schedule: ScheduleSpec;
        projectPath?: string | null;
      }) => Promise<{ ok: boolean; error?: string; tasks?: ScheduledTaskView[] }>;
      scheduledSetEnabled: (key: string, enabled: boolean) => Promise<{ ok: boolean; tasks: ScheduledTaskView[] }>;
      scheduledDelete: (key: string) => Promise<{ ok: boolean; tasks: ScheduledTaskView[] }>;
      scheduledRunNow: (
        key: string,
      ) => Promise<{ ok: boolean; error?: string | null; status?: string; text?: string }>;
      scheduledStop: (key: string) => Promise<{ ok: boolean; error?: string }>;
      scheduledTune: (p: {
        prompt: string;
        note: string;
        images: string[];
      }) => Promise<{ ok: boolean; proposal?: string; error?: string }>;
      scheduledLastRun: (key: string) => Promise<{
        threadId: string | null;
        status?: string | null;
        error?: string | null;
        at?: string | null;
      }>;
      onScheduledUpdated: (cb: (p: { tasks: ScheduledTaskView[] }) => void) => () => void;
      onScheduledRunState: (cb: (p: { key: string; running: boolean }) => void) => () => void;
      onScheduledCreated: (
        cb: (p: { paneId: PaneId; key: string; name: string; cadence: string }) => void,
      ) => () => void;
      onScheduledOpenRun: (cb: (p: { threadId: string }) => void) => () => void;
      mcpLogin: (name: string) => Promise<{ ok: boolean; error?: string }>;
      connectorsList: () => Promise<{ connectors: ConnectorInfo[] }>;
      connectorsConnect: (
        name: string,
      ) => Promise<{ ok: boolean; error?: string; branded?: boolean; signIn?: boolean }>;
      connectorsRemove: (name: string) => Promise<{ ok: boolean; error?: string }>;
      onConnectorsChanged: (cb: () => void) => () => void;
      connectorsSetClientId: (
        name: string,
        clientId: string,
        clientSecret?: string,
      ) => Promise<{ ok: boolean; error?: string }>;
      connectorsSetEnabled: (name: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
      onMcpLoginDone: (cb: (p: { name: string; success: boolean; error: string | null }) => void) => () => void;
      onApprovalCanceled: (cb: (p: { paneId: PaneId; requestId: string }) => void) => () => void;
      onApprovalRequest: (
        cb: (p: {
          paneId: PaneId;
          requestId: string;
          kind?: "command" | "fileChange" | "mcpTool";
          itemId: string | null;
          command: string;
          cwd: string | null;
          reason: string | null;
          grantRoot?: string | null;
          message?: string | null;
        }) => void,
      ) => () => void;
      onCommand: (
        cb: (p: { paneId: PaneId; phase: "started" | "completed"; item: CommandItem }) => void,
      ) => () => void;
      onCompaction: (cb: (p: { paneId: PaneId }) => void) => () => void;
      onTokenUsage: (
        cb: (p: { paneId: PaneId; used: number; window: number | null; percent: number | null }) => void,
      ) => () => void;
      contextUsage: (
        threadId: string,
      ) => Promise<{ usage: { used: number; window: number | null; percent: number | null } | null }>;
      resourceStats: () => Promise<{ procs: { pid: number; kind: string; memMB: number; cpu: number }[] }>;
      storageStats: () => Promise<{
        threads: Record<
          string,
          {
            rolloutBytes: number;
            transcriptBytes: number;
            mtime: number;
            agent?: { nickname: string | null; task: string; parent: string | null };
          }
        >;
        worktrees: { dir: string; project: string; branch: string; kb: number }[];
        engineHomeKB: number;
      }>;
      readBilling: () => Promise<BillingResult>;
      listThreads: () => Promise<SidebarData>;
      openThread: (id: string) => Promise<{
        id: string;
        entries: Entry[];
        running: boolean;
        streamText: string;
        approvals: HeldApproval[];
        failure: string | null;
      }>;
      detachThread: (cwd?: string) => Promise<{ ok: boolean }>;
      deleteThread: (id: string) => Promise<{ ok: boolean }>;
      resetSideChat: (paneId?: string) => Promise<{ ok: boolean }>;
      subagentsList: (parent: string) => Promise<{ agents: SubAgent[] }>;
      subagentTranscript: (id: string) => Promise<{
        entries: Entry[];
        running: boolean;
        streamText: string;
        name: string | null;
        path: string | null;
        error?: string;
      }>;
      onSubAgents: (cb: (p: { paneId: PaneId; agents: SubAgent[] }) => void) => () => void;
      onSubAgentDelta: (cb: (p: { threadId: string; delta: string }) => void) => () => void;
      onSubAgentActivity: (cb: (p: { threadId: string }) => void) => () => void;
      onSubAgentRenames: (cb: (p: { paneId: PaneId; names: Record<string, string> }) => void) => () => void;
      onSubAgentEvent: (
        cb: (p: {
          paneId: PaneId;
          event: string;
          name: string;
          path: string;
          agentThreadId: string;
          prompt?: string | null;
        }) => void,
      ) => () => void;
      onMessageBoundary: (cb: (p: { paneId: PaneId }) => void) => () => void;
      chooseProject: () => Promise<{ path: string | null; name: string | null }>;
      createProject: (record: {
        name: string;
        folders: string[];
        primary: string;
        icon: string;
        color: string | null;
      }) => Promise<{ path: string | null; name: string | null; error?: string }>;
      pickProjectLocation: () => Promise<{ path: string | null }>;
      renameThread: (threadId: string, name: string) => Promise<{ ok: boolean; error?: string }>;
      assignThreadProject: (threadId: string, projectPath: string) => Promise<{ ok: boolean }>;
      archiveProjectChats: (path: string) => Promise<{ archived: number }>;
      removeProject: (path: string) => Promise<{ ok: boolean }>;
      updateProject: (
        path: string,
        record: { name: string; folders: string[]; primary: string; icon: string; color: string | null },
      ) => Promise<{ ok: boolean; error?: string }>;
      revealProject: (path: string) => Promise<{ ok: boolean }>;
      readFile: (path: string) => Promise<{ fullPath: string; relPath?: string; content?: string; error?: string }>;
      fileExists: (path: string) => Promise<{ exists: boolean }>;
      readImage: (path: string) => Promise<{ dataUrl?: string; error?: string }>;
      listDir: (dir?: string) => Promise<{ dir: string; entries: DirEntry[]; error?: string }>;
      searchRefs: (word: string) => Promise<{ results: RefHit[]; truncated?: boolean; error?: string }>;
      blameLine: (file: string, line: number) => Promise<BlameInfo>;
      gitBranch: (path: string) => Promise<{ branch: string | null }>;
      gitBranches: (
        path: string,
      ) => Promise<{ branches: string[]; current: string; dirty: DirtyFile[]; error?: string }>;
      gitCheckout: (path: string, branch: string, create?: boolean) => Promise<{ ok: boolean; error?: string }>;
      gitCommitAll: (path: string, message: string) => Promise<{ ok: boolean; error?: string }>;
      gitDiscard: (path: string) => Promise<{ ok: boolean; error?: string }>;
      reviewDiff: (path: string, mode: "branch" | "working") => Promise<ReviewData>;
      reviewCommitPush: (path: string) => Promise<{ ok: boolean; error?: string }>;
      reviewCreatePr: (path: string) => Promise<{ ok: boolean; error?: string }>;
      openExternal: (url: string) => Promise<{ ok: boolean }>;
      favicon: (host: string) => Promise<{ dataUrl: string | null }>;
      agentMirrorStart: (p: {
        width: number;
        height: number;
        dpr: number;
        threadId?: string | null;
      }) => Promise<{ ok: boolean; error?: string }>;
      agentMirrorStop: () => Promise<{ ok: boolean }>;
      agentMirrorResize: (p: { width: number; height: number; dpr: number }) => Promise<{ ok: boolean }>;
      agentMirrorInput: (ev: Record<string, unknown>) => Promise<{ ok: boolean }>;
      onAgentMirrorFrame: (cb: (p: { src: string; width: number; height: number }) => void) => () => void;
      onAgentMirrorState: (
        cb: (p: { connected: boolean; url?: string; title?: string; reason?: string }) => void,
      ) => () => void;
      onAgentMirrorActivity: (cb: (p: { tool: string }) => void) => () => void;
      changelogReleases: () => Promise<{ releases: ChangelogRelease[] }>;
      updatePrefs: () => Promise<{ autoDownload: boolean; version: string; lastCheckedAt: number | null }>;
      setUpdatePrefs: (p: { autoDownload: boolean }) => Promise<{ ok: boolean }>;
      openBrowser: (p: { id: number; url?: string }) => Promise<{ ok: boolean }>;
      setBrowserBounds: (b: { id: number; x: number; y: number; width: number; height: number }) => Promise<void>;
      setBrowserVisible: (p: { id: number; visible: boolean }) => Promise<void>;
      navigateBrowser: (p: { id: number; url?: string; action?: "back" | "forward" | "reload" }) => Promise<void>;
      closeBrowser: (id: number) => Promise<void>;
      onBrowserState: (cb: (p: BrowserState) => void) => () => void;
      onBrowserAnnotate: (
        cb: (p: { text: string; comment?: string; tag?: string; thumb?: string }) => void,
      ) => () => void;
      startBrowserAnnotate: (id: number) => Promise<{ ok: boolean }>;
      createTerminal: (cols: number, rows: number) => Promise<{ id: string; cwd: string; shell: string }>;
      writeTerminal: (id: string, data: string) => Promise<void>;
      resizeTerminal: (id: string, cols: number, rows: number) => Promise<void>;
      killTerminal: (id: string) => Promise<void>;
      onTermData: (cb: (p: { id: string; data: string }) => void) => () => void;
      onTermExit: (cb: (p: { id: string; exitCode: number }) => void) => () => void;
    };
  }
}

// All chrome colors resolve through CSS variables set from the active
// theme at the root — see themeVars(). Semantic status colors stay fixed.
const colors = {
  bg: "var(--bg)",
  panel: "var(--panel)",
  border: "var(--border)",
  fg: "var(--fg)",
  dim: "var(--dim)",
  accent: "var(--accent)",
  ok: "#5DCAA5",
  err: "#F09595",
  amber: "#FAC775",
};

// ── Buttons ─────────────────────────────────────────────────────────────
// One definition, because there were three. MCP and Skills each declared an
// identical pair locally, and the Scheduled panel then invented a third look
// (solid accent fill, 9px radius, no icon) — so the app's most prominent
// action wore a different face in every panel that had one.
//
// The house primary is a TINTED pill, not a solid fill: accent text on a 14%
// accent wash. On a near-black surface a solid accent block is the loudest
// thing on screen, and "Add a server" does not deserve to outrank the content.
//
// The tint was also written as a literal rgba of the default accent, which
// meant these buttons alone kept their blood-orange wash when the accent was
// themed. color-mix ties them to the live variable.
const btnPrimaryStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  background: "color-mix(in srgb, var(--accent) 14%, transparent)",
  border: "none",
  borderRadius: 999,
  color: colors.accent,
  fontSize: 14.5,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: "inherit",
  padding: "10px 20px",
};
const btnSecondaryStyle: React.CSSProperties = {
  background: "var(--chip)",
  border: "none",
  borderRadius: 999,
  color: colors.fg,
  fontSize: 14.5,
  cursor: "pointer",
  fontFamily: "inherit",
  padding: "10px 20px",
};
/** Row-level actions sit inside an inset group, so they step down a size —
 *  and step UP a shade, because the inset they rest on is --chip's twin. */
const btnSmallStyle: React.CSSProperties = {
  background: "var(--chip-raised)",
  border: "none",
  borderRadius: 999,
  color: colors.fg,
  fontSize: 13,
  cursor: "pointer",
  fontFamily: "inherit",
  padding: "6px 14px",
  flexShrink: 0,
};

export type ThemeConfig = {
  accent: string;
  surface: string;
  ink: string;
  contrast: number; // 0..100, 50 = baseline
  fonts: { ui: string; code: string };
};

// The default follows the user's Codex dark theme (codex-theme-v1 import).
const DEFAULT_THEME: ThemeConfig = {
  accent: "#FF563F",
  surface: "#111111",
  ink: "#fcfcfc",
  contrast: 50,
  fonts: { ui: "Geist, Inter", code: '"Geist Mono", ui-monospace, "SFMono-Regular"' },
};

function loadTheme(): ThemeConfig {
  try {
    const parsed = JSON.parse(localStorage.getItem("themeV1") ?? "");
    return { ...DEFAULT_THEME, ...parsed, fonts: { ...DEFAULT_THEME.fonts, ...(parsed.fonts ?? {}) } };
  } catch {
    return DEFAULT_THEME;
  }
}

function saveTheme(t: ThemeConfig): void {
  localStorage.setItem("themeV1", JSON.stringify(t));
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mixHex(a: string, b: string, t: number): string {
  const ra = hexToRgb(a) ?? [17, 17, 17];
  const rb = hexToRgb(b) ?? [252, 252, 252];
  const mixed = ra.map((v, i) => Math.round(v + (rb[i] - v) * t));
  return "#" + mixed.map((v) => v.toString(16).padStart(2, "0")).join("");
}

/** WCAG 2.1 relative luminance — the gamma-corrected kind the contrast
 *  formula is defined against, not a weighted average of the raw channels. */
function relLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex) ?? [0, 0, 0];
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two opaque colours, 1:1 … 21:1. */
function contrastRatio(a: string, b: string): number {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Which ink to put ON a filled swatch — measured, not guessed.
 *
 * This used to be a Rec.601 luma test against a 0.6 threshold, and it got the
 * brand accent wrong: #FF563F lands at luma 0.525, so it chose white, which is
 * 3.16:1 — under the 4.5:1 WCAG AA needs for body text. Dark ink on the same
 * fill is 5.98:1, nearly double. The design system flags the identical trap in
 * its own notes, calling brand-fill contrast "already borderline (~3.1:1)".
 *
 * A retuned threshold would only move the failure to a different hue, and the
 * accent is user-themeable — an imported theme can carry any colour at all. So
 * compare the two candidates properly and take the winner; that is right for
 * every accent rather than for the one we happened to test.
 */
function bestInkOn(fill: string): string {
  return contrastRatio("#111111", fill) >= contrastRatio("#ffffff", fill) ? "#111111" : "#ffffff";
}

/** Derive every chrome shade from surface + ink + contrast, Codex-style. */
function themeVars(t: ThemeConfig): Record<string, string> {
  const k = Math.max(t.contrast, 5) / 50;
  const m = (x: number) => mixHex(t.surface, t.ink, Math.min(x * k, 1));
  return {
    "--bg": t.surface,
    "--fg": t.ink,
    "--accent": t.accent,
    "--accent-fg": bestInkOn(t.accent),
    "--nav-bg": mixHex(t.surface, "#000000", 0.14),
    "--code-bg": mixHex(t.surface, "#000000", 0.3),
    "--code-fg": mixHex(t.ink, t.surface, 0.14),
    "--panel": m(0.05),
    "--panel-2": m(0.09),
    "--chip": m(0.09),
    // A control resting on an inset needs to sit ABOVE it. --chip and
    // --panel-2 are the same 0.09 step, so a chip button dropped into an inset
    // group rendered as bare text on an identically-shaded field — visible in
    // the MCP panel and the Skills list both. This is the step up that makes a
    // row action read as a control, and it scales with contrast like the rest
    // of the ladder rather than being a fixed colour.
    "--chip-raised": m(0.17),
    "--border": m(0.095),
    "--dim": mixHex(t.surface, t.ink, 0.52),
    // Between fg and dim: sidebar thread titles, Codex-style.
    "--fg-soft": mixHex(t.surface, t.ink, 0.78),
    // Assistant prose: a step softer than pure fg, like Codex replies.
    "--fg-msg": mixHex(t.surface, t.ink, 0.88),
    "--gutter": m(0.25),
    "--font-ui": `${t.fonts.ui}, -apple-system, system-ui, sans-serif`,
    "--font-code": `${t.fonts.code}, ui-monospace, Menlo, monospace`,
  };
}

/** Parse a Codex theme export: `codex-theme-v1:{...}` or the raw JSON. */
function parseThemeImport(raw: string): ThemeConfig | null {
  try {
    const json = raw.trim().replace(/^codex-theme-v1:/, "");
    const parsed = JSON.parse(json);
    const src = parsed.theme ?? parsed;
    const next: ThemeConfig = {
      accent: typeof src.accent === "string" ? src.accent : DEFAULT_THEME.accent,
      surface: typeof src.surface === "string" ? src.surface : DEFAULT_THEME.surface,
      ink: typeof src.ink === "string" ? src.ink : DEFAULT_THEME.ink,
      contrast: typeof src.contrast === "number" ? src.contrast : DEFAULT_THEME.contrast,
      fonts: {
        ui: typeof src.fonts?.ui === "string" ? src.fonts.ui : DEFAULT_THEME.fonts.ui,
        code: typeof src.fonts?.code === "string" ? src.fonts.code : DEFAULT_THEME.fonts.code,
      },
    };
    if (!hexToRgb(next.accent) || !hexToRgb(next.surface) || !hexToRgb(next.ink)) return null;
    return next;
  } catch {
    return null;
  }
}

const REMARK_PLUGINS = [remarkGfm];
// File previews render embedded HTML (chat markdown stays text-only).
// Scripts can't run regardless — the CSP has no unsafe-inline.
const REHYPE_PLUGINS = [rehypeRaw];

/** Deterministic glyph per sub-agent (Codex assigns each agent a colorful
 *  icon). Hashed off the thread id so every surface shows the same one. */
const AGENT_EMOJI = ["🌸", "🌿", "🍀", "🌺", "🪷", "🌻", "🍁", "🌵", "🌼", "🍄", "🌷", "🌴", "⭐️", "🔮", "💠", "🪸"];
function agentEmoji(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AGENT_EMOJI[h % AGENT_EMOJI.length];
}

/** Shimmering status text (gradient sweep, Codex-style) — the universal
 *  "something is in flight" treatment. */
function ShimmerText({ text, fontSize = 12.5 }: { text: string; fontSize?: number }) {
  return (
    <span
      style={{
        fontSize,
        background: `linear-gradient(90deg, var(--dim) 30%, var(--fg) 50%, var(--dim) 70%)`,
        backgroundSize: "200% 100%",
        WebkitBackgroundClip: "text",
        backgroundClip: "text",
        color: "transparent",
        animation: "unbiased-shimmer 2s linear infinite",
      }}
    >
      {text}
    </span>
  );
}

function WorkingShimmer() {
  return <ShimmerText text="is working" />;
}

/** Whole-unit variant for settled durations: "5s", "2m 20s". */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}

/** Drop a trailing empty assistant placeholder. */
function withoutTrailingPlaceholder(es: Entry[]): Entry[] {
  const last = es[es.length - 1];
  if (last?.kind === "assistant" && last.text === "" && !last.interrupted) return es.slice(0, -1);
  return es;
}

// Composer placeholders for a conversation that already has history — a
// fresh one is drawn every time a chat opens.
// Composer height bounds. The floor keeps the resting two-row shape; past the
// ceiling it scrolls, so pasting a long document can't swallow the transcript.
const COMPOSER_MIN_H = 44;
const COMPOSER_MAX_H = 320;

const CHAT_PLACEHOLDERS = [
  "Start typing, we'll keep up",
  "What are we doing today",
  "Say the thing",
  "Begin anywhere",
  "Out with it",
  "Ask something hard",
  "Where were we",
  "Put us to work",
  "Go on",
  "Try something",
];

type CommandEntry = Extract<Entry, { kind: "command" }>;
type DisplayBlock =
  | { kind: "entry"; entry: Entry; key: number }
  | { kind: "steps"; items: CommandEntry[]; key: number };

/** Consecutive command entries collapse into one steps group. */
function toDisplayBlocks(entries: Entry[]): DisplayBlock[] {
  const blocks: DisplayBlock[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.kind === "command") {
      const last = blocks[blocks.length - 1];
      if (last?.kind === "steps") {
        last.items.push(e);
      } else {
        blocks.push({ kind: "steps", items: [e], key: i });
      }
    } else {
      blocks.push({ kind: "entry", entry: e, key: i });
    }
  }
  return blocks;
}

export function App() {
  const [theme, setTheme] = useState<ThemeConfig>(loadTheme);
  // themeVars() rides as an inline style object on each root wrapper, so no
  // :root rule exists — which is fine for everything that inherits, and wrong
  // for exactly one thing. A ::highlight() pseudo is resolved at document
  // level and cannot see a variable declared on a div, so the annotation tints
  // were stuck on a hard-coded accent. Publishing this one variable to
  // documentElement lets index.html's tints follow the user's accent.
  useEffect(() => {
    document.documentElement.style.setProperty("--accent", theme.accent);
  }, [theme.accent]);
  useEffect(() => {
    // The body is outside the themed wrapper, so it keeps index.html's static
    // dark unless told the live surface colour. Only visible if some layout
    // escapes the root — at which point dark beats white.
    document.body.style.background = theme.surface;
  }, [theme.surface]);
  const [showSettings, setShowSettings] = useState(false);
  const [showChangelog, setShowChangelog] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [connectorsPanelOpen, setConnectorsPanelOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [scheduledOpen, setScheduledOpen] = useState(false);
  /** The thread of a scheduled run that is going right now, if any. */
  const [runningScheduledThread, setRunningScheduledThread] = useState<string | null>(null);
  const [connectorsOpen, setConnectorsOpen] = useState(false);
  /** True while a full-page destination covers the chat. Sidebar rows key off
   *  this rather than testing each flag: with one flag per view, adding a view
   *  meant remembering to exclude it in three separate `active` expressions,
   *  and forgetting left two rows lit at once. */
  const pageOpen = scheduledOpen || connectorsOpen;
  /** Set when arriving from a "View task" link, so the row the agent just
   *  created is identifiable among the others rather than left to be found. */
  const [scheduledFocus, setScheduledFocus] = useState<string | null>(null);
  // Badge on the nav row: how many tasks came due while the app was closed.
  // Kept up here rather than inside the panel so it shows without opening it.
  const [missedCount, setMissedCount] = useState(0);
  useEffect(() => {
    const count = (tasks: ScheduledTaskView[]) => setMissedCount(tasks.filter((t) => t.missedAt).length);
    void window.unbiased.scheduledList().then((r) => count(r.tasks ?? []));
    // Main marks missed tasks during catch-up, which happens when the engine
    // connects — after this component first mounts — so a one-shot read here
    // would always report zero on a cold launch.
    return window.unbiased.onScheduledUpdated((p) => {
      const tasks = p.tasks ?? [];
      count(tasks);
      // The Scheduled page is not a conversation, so it has no thread of its
      // own to point the mirror at — which left the pane blank while a run was
      // visibly browsing, and made "Open run" look like it STARTED the
      // browser when it only re-pointed the view.
      setRunningScheduledThread(tasks.find((t) => t.runningThreadId)?.runningThreadId ?? null);
    });
  }, []);
  // Unread until the user has opened the log at its current top version.
  // The releases repo wins when we have it; the bundled copy covers offline
  // and first run. Both are generated from CHANGELOG.md, so neither can drift.
  const [releases, setReleases] = useState<ChangelogRelease[]>(BUNDLED_CHANGELOG);
  useEffect(() => {
    void window.unbiased.changelogReleases().then((r) => {
      if (r.releases.length > 0) setReleases(r.releases);
    });
  }, []);
  const [changelogUnread, setChangelogUnread] = useState(
    () => localStorage.getItem("changelogSeen") !== BUNDLED_CHANGELOG[0]?.version,
  );
  useEffect(() => {
    const top = releases[0]?.version;
    if (top) setChangelogUnread(localStorage.getItem("changelogSeen") !== top);
  }, [releases]);
  const [status, setStatus] = useState<EngineStatus>({ state: "starting" });
  // Sign-in gate: "checking" until we know, then either the login screen or
  // the app. A remembered session (prior successful login) with a stored key
  // signs in automatically; otherwise the login screen prompts.
  const [authed, setAuthed] = useState<"checking" | "in" | "out">("checking");
  // A newer release exists on the public releases repo. Surfaced as a
  // sidebar banner; clicking it downloads, swaps the bundle, and relaunches.
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updateProgress, setUpdateProgress] = useState<{ phase: UpdatePhase; percent: number } | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  // Downloaded, verified, and waiting beside the installed app.
  const [updateStaged, setUpdateStaged] = useState(false);

  useEffect(() => {
    void window.unbiased.pendingUpdate().then((p) => {
      if (p.update) setUpdate(p.update);
      if (p.staged) setUpdateStaged(true);
    });
    const offs = [
      window.unbiased.onUpdateAvailable((u) => setUpdate(u)),
      window.unbiased.onUpdateStaged((p) => {
        // Downloaded and verified — now it's the user's call when to restart.
        setUpdateProgress(null);
        setUpdateStaged(true);
        // The banner renders only when `update` is set, and a silent download
        // deliberately never sent update:available first — so staged alone
        // left the banner invisible. Main now announces as well, but this
        // stands on its own so the banner can never depend on event order.
        setUpdate((u) => u ?? { version: p.version, dmgUrl: "", sumsUrl: null });
      }),
      window.unbiased.onUpdateProgress((p) => {
        setUpdateProgress(p);
        setUpdateError(null);
      }),
      window.unbiased.onUpdateError((e) => {
        setUpdateProgress(null);
        setUpdateStaged(false);
        setUpdateError(e.message);
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const st = await window.unbiased.authStatus();
      const remembered = localStorage.getItem("unbiased.authed") === "1";
      if (st.hasKey && (remembered || st.source === "env")) {
        // Validate + start the engine with the stored key.
        const who = await window.unbiased.authLogin();
        if (!alive) return;
        if (who.ok) {
          localStorage.setItem("unbiased.authed", "1");
          setAuthed("in");
          return;
        }
      }
      if (alive) setAuthed("out");
    })();
    return () => {
      alive = false;
    };
  }, []);

  function onSignedIn() {
    localStorage.setItem("unbiased.authed", "1");
    setAuthed("in");
  }

  async function signOut() {
    const removeKey = localStorage.getItem("signoutKeepsKey") === "false";
    await window.unbiased.authLogout(removeKey);
    localStorage.removeItem("unbiased.authed");
    setShowSettings(false);
    setAuthed("out");
  }

  function applyTheme(next: ThemeConfig) {
    setTheme(next);
    saveTheme(next);
  }
  const [sidebar, setSidebar] = useState<SidebarData>({ projects: [], recents: [] });
  const [pendingThreads, setPendingThreads] = useState<PendingThread[]>([]);
  // Threads with a turn running right now — including backgrounded ones.
  const [runningThreads, setRunningThreads] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    return window.unbiased.onThreadActivity((p) => {
      setRunningThreads((cur) => {
        const next = new Set(cur);
        if (p.running) next.add(p.threadId);
        else next.delete(p.threadId);
        return next;
      });
      // A finished background turn may retitle/reorder its thread. Once that
      // list is in, the stand-in row hands over to the real one — or drops,
      // if the turn ended without the engine ever having anything to list.
      if (!p.running) {
        void refreshThreads().then(() => {
          setPendingThreads((ps) => ps.filter((x) => x.id !== p.threadId));
        });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [activeProject, setActiveProject] = useState<{ name: string; path: string } | null>(null);
  const [hoveredThreadId, setHoveredThreadId] = useState<string | null>(null);
  const [hoveredProject, setHoveredProject] = useState<string | null>(null);
  // Which project row's ⋯ menu is open (fixed-positioned at the button's
  // screen rect — the nav's overflow would clip an absolute menu at
  // narrow sidebar widths), and the pending confirm dialog.
  const [projMenu, setProjMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    kind: "archive" | "remove";
    path: string;
    name: string;
    count: number;
  } | null>(null);

  // Create-project modal (the + beside the Projects section header).
  // Create/edit-project modal (Codex-style): name, icon+color picker,
  // source folders with a primary, remove. Create and edit share the one
  // surface; create just starts blank and lands on project:create.
  const [editProj, setEditProj] = useState<{
    mode: "create" | "edit";
    path: string; // edit: the record's primary at open time — the update key
    name: string;
    folders: string[];
    primary: string;
    icon: string;
    color: string | null;
    pickerOpen: boolean;
    error: string | null;
  } | null>(null);
  // Per-thread ⋯ menu (fixed-positioned like the project menu) and its dialogs.
  const [threadMenu, setThreadMenu] = useState<{ id: string; title: string; inProject: boolean; x: number; y: number } | null>(null);
  const [renameDialog, setRenameDialog] = useState<{ id: string; name: string; error: string | null } | null>(null);
  const [moveDialog, setMoveDialog] = useState<{ id: string; title: string } | null>(null);

  useEffect(() => {
    if (!threadMenu) return;
    function onDown(e: MouseEvent) {
      if (!(e.target as HTMLElement).closest("[data-threadmenu]")) setThreadMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setThreadMenu(null);
    }
    function onScroll() {
      setThreadMenu(null);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [threadMenu]);

  useEffect(() => {
    if (!renameDialog && !moveDialog && !editProj) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setRenameDialog(null);
        setMoveDialog(null);
        setEditProj((cur) => (cur?.pickerOpen ? { ...cur, pickerOpen: false } : null));
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [renameDialog, moveDialog, editProj]);

  async function doSaveProject() {
    if (!editProj) return;
    if (editProj.mode === "create") {
      if (!editProj.name.trim()) return;
      snapshotSideView(); // same as every other context switch
      const r = await window.unbiased.createProject({
        name: editProj.name.trim(),
        folders: editProj.folders,
        primary: editProj.primary,
        icon: editProj.icon,
        color: editProj.color,
      });
      if (!r.path || !r.name) {
        setEditProj((e) => (e ? { ...e, error: r.error ?? "Couldn't create the project" } : e));
        return;
      }
      setEditProj(null);
      setActiveProject({ name: r.name, path: r.path });
      setActiveThreadId(null);
      setMainStarted(false);
      setMainReset((r2) => ({ entries: [], nonce: r2.nonce + 1 }));
      resetSideView(true);
      void refreshThreads();
      return;
    }
    const r = await window.unbiased.updateProject(editProj.path, {
      name: editProj.name,
      folders: editProj.folders,
      primary: editProj.primary,
      icon: editProj.icon,
      color: editProj.color,
    });
    if (!r.ok) {
      setEditProj((e) => (e ? { ...e, error: r.error ?? "Save failed" } : e));
      return;
    }
    if (activeProject?.path === editProj.path) {
      setActiveProject({ name: editProj.name.trim() || activeProject.name, path: editProj.primary });
    }
    setEditProj(null);
    void refreshThreads();
  }

  async function doRenameThread() {
    if (!renameDialog || !renameDialog.name.trim()) return;
    const r = await window.unbiased.renameThread(renameDialog.id, renameDialog.name.trim());
    if (!r.ok) {
      setRenameDialog((d) => (d ? { ...d, error: r.error ?? "Rename failed" } : d));
      return;
    }
    setRenameDialog(null);
    void refreshThreads();
  }

  async function doMoveThread(projectPath: string) {
    if (!moveDialog) return;
    await window.unbiased.assignThreadProject(moveDialog.id, projectPath);
    setMoveDialog(null);
    void refreshThreads();
  }

  useEffect(() => {
    if (!projMenu) return;
    function onDown(e: MouseEvent) {
      if (!(e.target as HTMLElement).closest("[data-projmenu]")) setProjMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setProjMenu(null);
    }
    function onScroll() {
      setProjMenu(null); // fixed menu would drift from its scrolled row
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [projMenu]);

  async function runConfirmedAction() {
    if (!confirmDialog) return;
    const { kind, path } = confirmDialog;
    if (kind === "archive") {
      await window.unbiased.archiveProjectChats(path);
      // The active conversation may have just been archived.
      const wasActive = sidebar.projects.some(
        (p) => p.path === path && p.threads.some((t) => t.id === activeThreadId),
      );
      if (wasActive) {
        await window.unbiased.detachThread();
        setActiveThreadId(null);
        setMainStarted(false);
        setMainReset((r) => ({ entries: [], nonce: r.nonce + 1 }));
        resetSideView(true);
      }
    } else {
      await window.unbiased.removeProject(path);
      if (activeProject?.path === path) setActiveProject(null);
    }
    setConfirmDialog(null);
    void refreshThreads();
  }
  // Sidebar sections fold independently; both states persist.
  const [projectsCollapsed, setProjectsCollapsed] = useState(
    () => localStorage.getItem("navProjectsCollapsed") === "true",
  );
  const [recentsCollapsed, setRecentsCollapsed] = useState(
    () => localStorage.getItem("navRecentsCollapsed") === "true",
  );

  function toggleProjectsSection() {
    setProjectsCollapsed((c) => {
      localStorage.setItem("navProjectsCollapsed", String(!c));
      return !c;
    });
  }

  function toggleRecentsSection() {
    setRecentsCollapsed((c) => {
      localStorage.setItem("navRecentsCollapsed", String(!c));
      return !c;
    });
  }
  const [mainBusy, setMainBusy] = useState(false);
  // Whether the main conversation has any content — a side chat forks the
  // main thread, so offering one before anything exists makes no sense.
  const [mainStarted, setMainStarted] = useState(false);
  // Start-page suggestion cards seed the main composer through this.
  const [mainSeed, setMainSeed] = useState<{ text: string; nonce: number } | null>(null);
  const seedNonceRef = useRef(1);
  // Current git branch of the active project, for the context strip.
  const [projectBranch, setProjectBranch] = useState<string | null>(null);
  // Work-in mode for NEW project chats + what the active conversation is
  // actually in (its worktree cwd when isolated, else null → project dir).
  // "local" | "worktree" | a specific existing worktree.
  type WorkSel = { mode: "local" | "worktree" } | { mode: "existing"; dir: string; branch: string };
  const [workSel, setWorkSelState] = useState<WorkSel>({ mode: "local" });
  const [existingWts, setExistingWts] = useState<{ dir: string; branch: string }[]>([]);
  const [convCwd, setConvCwd] = useState<string | null>(null);
  const [workMenuOpen, setWorkMenuOpen] = useState(false);

  // The persisted choice is keyed by project — a single global here once
  // carried "New worktree" into a freshly opened project and silently
  // created a worktree on its first chat.
  function workModeStore(): Record<string, "local" | "worktree"> {
    try {
      const parsed = JSON.parse(localStorage.getItem("workModeByProject") ?? "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function changeWorkMode(sel: WorkSel) {
    // Only the generic modes persist; a specific worktree is per-session.
    if (sel.mode !== "existing" && activeProjectPath) {
      const store = workModeStore();
      store[activeProjectPath] = sel.mode;
      localStorage.setItem("workModeByProject", JSON.stringify(store));
    }
    setWorkSelState(sel);
    void window.unbiased.setWorkMode(sel.mode, sel.mode === "existing" ? sel.dir : undefined);
    setWorkMenuOpen(false);
  }

  async function openWorkMenu() {
    if (activeProjectPath) {
      const r = await window.unbiased.listWorktrees(activeProjectPath);
      setExistingWts(r.worktrees);
    } else {
      setExistingWts([]);
    }
    setWorkMenuOpen(true);
  }

  useEffect(() => {
    if (!workMenuOpen) return;
    function onDown(e: MouseEvent) {
      if (!(e.target as HTMLElement).closest("[data-workmenu]")) setWorkMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setWorkMenuOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [workMenuOpen]);
  // The branch switcher: dropdown data, the commit/discard-to-switch
  // modal, and the create-branch modal.
  const [branchMenu, setBranchMenu] = useState<{
    branches: string[];
    current: string;
    dirty: DirtyFile[];
  } | null>(null);
  const [branchSearch, setBranchSearch] = useState("");
  const [branchSwitch, setBranchSwitch] = useState<{ target: string; files: DirtyFile[] } | null>(null);
  const [branchCreate, setBranchCreate] = useState(false);
  const [branchName, setBranchName] = useState("");
  const [branchError, setBranchError] = useState<string | null>(null);
  const [branchBusy, setBranchBusy] = useState(false);

  useEffect(() => {
    if (!branchMenu) return;
    function onDown(e: MouseEvent) {
      if (!(e.target as HTMLElement).closest("[data-branchmenu]")) setBranchMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setBranchMenu(null);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [branchMenu]);

  useEffect(() => {
    if (!branchSwitch && !branchCreate) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setBranchSwitch(null);
        setBranchCreate(false);
        setBranchError(null);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [branchSwitch, branchCreate]);

  async function openBranchMenu() {
    if (!gitPath) return;
    const r = await window.unbiased.gitBranches(gitPath);
    if (r.error) return;
    setBranchSearch("");
    setBranchError(null);
    setBranchMenu({ branches: r.branches, current: r.current, dirty: r.dirty });
  }

  async function doCheckout(branch: string, create = false): Promise<void> {
    if (!gitPath) return;
    setBranchBusy(true);
    const r = await window.unbiased.gitCheckout(gitPath, branch, create);
    setBranchBusy(false);
    if (!r.ok) {
      setBranchError(r.error ?? "Checkout failed");
      return;
    }
    setProjectBranch(branch);
    setBranchMenu(null);
    setBranchSwitch(null);
    setBranchCreate(false);
    setBranchName("");
    setBranchError(null);
  }

  function pickBranch(branch: string) {
    if (!branchMenu) return;
    if (branch === branchMenu.current) {
      setBranchMenu(null);
      return;
    }
    if (branchMenu.dirty.length > 0) {
      setBranchSwitch({ target: branch, files: branchMenu.dirty });
      setBranchMenu(null);
    } else {
      void doCheckout(branch);
    }
  }

  async function commitAndSwitch() {
    if (!branchSwitch || !gitPath) return;
    setBranchBusy(true);
    const c = await window.unbiased.gitCommitAll(
      gitPath,
      `WIP before switching to ${branchSwitch.target}`,
    );
    setBranchBusy(false);
    if (!c.ok) {
      setBranchError(c.error ?? "Commit failed");
      return;
    }
    void doCheckout(branchSwitch.target);
  }

  async function discardAndSwitch() {
    if (!branchSwitch || !gitPath) return;
    setBranchBusy(true);
    const d = await window.unbiased.gitDiscard(gitPath);
    setBranchBusy(false);
    if (!d.ok) {
      setBranchError(d.error ?? "Discard failed");
      return;
    }
    void doCheckout(branchSwitch.target);
  }

  function branchNameError(name: string): string | null {
    if (!name.trim()) return null;
    if (name.endsWith("/")) return 'Branch name cannot end with "/".';
    if (/[\s~^:?*[\\]|\.\.|@\{/.test(name) || name.startsWith("-") || name.endsWith(".lock")) {
      return "Invalid branch name.";
    }
    return null;
  }
  // `resume` carries what a reopened conversation was doing while
  // backgrounded: a still-running turn (busy state) and any approval
  // requests the agent is blocked on.
  const [mainReset, setMainReset] = useState<{
    entries: Entry[];
    nonce: number;
    resume?: { running: boolean; approvals: HeldApproval[] } | null;
    runningTurnStart?: number | null;
    runningTurnStartedAt?: number | null;
  }>({ entries: [], nonce: 0 });
  // sideOpen = the whole right panel is visible; sideChatEnabled = the chat
  // tab exists in it. Kept separate so opening a file/image preview doesn't
  // drag the side chat along with it. Neither restores across launches —
  // the app always starts with the panel closed.
  const [sideOpen, setSideOpen] = useState(false);
  // Side-chat tabs: each entry is an engine pane id ("side:<n>"), each tab
  // its own ephemeral fork of the main conversation. Context chips are per
  // tab. sideNonce remounts them all when the main conversation changes.
  const [sideChats, setSideChats] = useState<string[]>([]);
  const [sideContexts, setSideContexts] = useState<Record<string, string | null>>({});
  const [sideNonce, setSideNonce] = useState(0);
  // Text handed to the MAIN composer from outside it — the embedded
  // browser's "Add … to chat" context-menu items land here and are
  // consumed into annotation chips by the same contextChip mechanism
  // the side chat uses.
  const [mainContext, setMainContext] = useState<{
    text: string;
    comment?: string;
    tag?: string;
    thumb?: string;
  } | null>(null);

  useEffect(() => window.unbiased.onBrowserAnnotate((p) => setMainContext(p)), []);

  // Access mode is app-global: persisted here, enforced in the main
  // process (thread policies + per-turn overrides).
  const [accessMode, setAccessModeState] = useState<AccessMode>(() => {
    const stored = localStorage.getItem("accessMode");
    return stored === "auto" || stored === "full" ? stored : "ask";
  });

  useEffect(() => {
    void window.unbiased.setAccessMode(accessMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Turning Full Access ON demands an explicit confirmation (capability
  // disclosure modal) — every other transition applies immediately.
  const [fullAccessPrompt, setFullAccessPrompt] = useState(false);

  useEffect(() => {
    if (!fullAccessPrompt) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setFullAccessPrompt(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [fullAccessPrompt]);

  function applyAccessMode(mode: AccessMode) {
    localStorage.setItem("accessMode", mode);
    setAccessModeState(mode);
    void window.unbiased.setAccessMode(mode);
  }

  // Plan mode: research-and-propose, hard read-only. Session-scoped.
  const [planMode, setPlanModeState] = useState(false);

  function togglePlanMode() {
    setPlanModeState((on) => {
      void window.unbiased.setPlanMode(!on);
      return !on;
    });
  }

  function changeAccessMode(mode: AccessMode) {
    if (mode === "full" && accessMode !== "full") {
      setFullAccessPrompt(true);
      return;
    }
    applyAccessMode(mode);
  }

  function setSideOpenPersisted(open: boolean) {
    setSideOpen(open);
  }

  const [navOpen, setNavOpen] = useState(() => localStorage.getItem("navOpen") !== "false");
  // Nav width is user-draggable within [180, 400]px, persisted.
  const NAV_MIN = 180;
  const NAV_MAX = 400;
  const [navWidth, setNavWidth] = useState(() => {
    const stored = Number(localStorage.getItem("navWidth"));
    return stored >= NAV_MIN && stored <= NAV_MAX ? stored : 248;
  });
  // The main/side split is a FRACTION of the content area (not pixels), so
  // collapsing the nav or resizing the window scales both panes in ratio.
  const [sideFrac, setSideFrac] = useState(() => {
    const stored = Number(localStorage.getItem("sideFrac"));
    return stored >= 0.25 && stored <= 0.7 ? stored : 0.45;
  });
  const draggingRef = useRef(false);
  const navDraggingRef = useRef(false);
  const navOpenRef = useRef(navOpen);
  navOpenRef.current = navOpen;
  const navWidthRef = useRef(navWidth);
  navWidthRef.current = navWidth;

  function toggleNav() {
    setNavOpen((o) => {
      localStorage.setItem("navOpen", String(!o));
      return !o;
    });
  }

  // Divider drag: the fraction follows the cursor within the content area
  // (everything right of the nav), clamped so neither pane collapses into
  // uselessness. Persisted across launches.
  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (navDraggingRef.current) {
        setNavWidth(Math.min(Math.max(e.clientX, NAV_MIN), NAV_MAX));
        return;
      }
      if (!draggingRef.current) return;
      const contentLeft = navOpenRef.current ? navWidthRef.current : 0;
      const contentWidth = Math.max(window.innerWidth - contentLeft, 1);
      const frac = (window.innerWidth - e.clientX) / contentWidth;
      setSideFrac(Math.min(Math.max(frac, 0.25), 0.7));
    }
    function onUp() {
      if (navDraggingRef.current) {
        navDraggingRef.current = false;
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        setNavWidth((w) => {
          localStorage.setItem("navWidth", String(w));
          return w;
        });
        return;
      }
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      setSideFrac((f) => {
        localStorage.setItem("sideFrac", String(f));
        return f;
      });
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  async function refreshThreads() {
    const data = await window.unbiased.listThreads();
    setSidebar(data);
    if (data.running) setRunningThreads(new Set(data.running));
  }

  useEffect(() => {
    window.unbiased.getEngineStatus().then((s) => {
      setStatus(s);
      if (s.state === "connected") void refreshThreads();
    });
    return window.unbiased.onEngineStatus((s: EngineStatus) => {
      setStatus(s);
      if (s.state === "connected") void refreshThreads();
    });
  }, []);

  // The side chat is attached to the main conversation (it forks from it),
  // so every main-context switch discards the side pane's transcript too —
  // and any open file, which resolved against the previous conversation.
  // The side panel's composition belongs to the conversation it was built
  // for — leaving and returning should find the same tabs. Snapshots are
  // keyed by thread id; terminals are excluded (their PTYs die on unmount,
  // and a silently respawned shell is worse than a closed tab).
  const sidePanelSnapshots = useRef(
    new Map<
      string,
      {
        openAgents: { threadId: string; name: string }[];
        openFiles: { id: number; info: OpenFileInfo }[];
        filesTabs: number[];
        treeFiles: Record<number, OpenFileInfo | null>;
        reviewOpen: boolean;
        // The Agent browser pane. It used to be the one side tab that was not
        // remembered per conversation, so switching away closed it: a chat
        // whose only pane was the browser failed the hasTabs check below, fell
        // through to resetSideView, and had panelMode moved off it. Now that
        // each conversation drives its own tab, the pane belongs to the
        // conversation too.
        agentMirrorOpen: boolean;
        panelMode: string;
        sideOpen: boolean;
      }
    >(),
  );

  const MAX_SIDE_SNAPSHOTS = 12;
  function snapshotSideView(): void {
    if (!activeThreadId) return;
    // Each snapshot can hold several file contents, and conversations deleted
    // from Settings never come back through here — so cap the store and drop
    // the least recently visited.
    sidePanelSnapshots.current.delete(activeThreadId);
    while (sidePanelSnapshots.current.size >= MAX_SIDE_SNAPSHOTS) {
      const oldest = sidePanelSnapshots.current.keys().next().value;
      if (oldest === undefined) break;
      sidePanelSnapshots.current.delete(oldest);
    }
    sidePanelSnapshots.current.set(activeThreadId, {
      openAgents,
      openFiles,
      filesTabs,
      treeFiles,
      reviewOpen,
      agentMirrorOpen,
      panelMode,
      sideOpen,
    });
  }

  /** Restore a conversation's saved side panel; false = nothing to restore. */
  function restoreSideView(id: string): boolean {
    const snap = sidePanelSnapshots.current.get(id);
    if (!snap) return false;
    const hasTabs =
      snap.openAgents.length > 0 ||
      snap.openFiles.length > 0 ||
      snap.filesTabs.length > 0 ||
      snap.reviewOpen ||
      snap.agentMirrorOpen;
    if (!hasTabs) return false;
    setSideContexts({});
    setSideNonce((n) => n + 1);
    setSubAgentsList([]); // openThread refetches the live roster
    setTerminalTabs([]);
    setOpenAgents(snap.openAgents);
    setOpenFiles(snap.openFiles);
    setFilesTabs(snap.filesTabs);
    setTreeFiles(snap.treeFiles);
    setReviewOpen(snap.reviewOpen);
    setAgentMirrorOpen(snap.agentMirrorOpen);
    // A stale active key (e.g. a dropped terminal) falls back to the most
    // recent surviving tab via the strip's own effect.
    setPanelMode(snap.panelMode);
    setSideOpenPersisted(snap.sideOpen);
    return true;
  }

  /** `fresh` = a clean-slate action (new chat, new/opened project, deleting
   *  the active conversation): the whole side panel resets, browser tabs and
   *  side chats included. They used to survive every reset ("the page you're
   *  reading survives"), but a NEW chat opening with the previous chat's
   *  browser page reads as a leak, not a feature. Conversation SWITCHES stay
   *  non-fresh on purpose: a closed browser view cannot be restored later
   *  (snapshots don't capture page state), so switching must not cost the
   *  user their open page. */
  function resetSideView(fresh = false) {
    setSideContexts({});
    setSideNonce((n) => n + 1);
    setOpenFiles([]);
    setOpenAgents([]); // the agents belonged to the previous conversation
    setSubAgentsList([]);
    setFilesTabs([]); // the trees browsed the previous conversation's cwd
    setTreeFiles({});
    setTerminalTabs([]); // the shells ran in the previous conversation's cwd
    setReviewOpen(false); // the diff reviewed the previous conversation's cwd
    if (fresh) {
      for (const id of browserTabsRef.current) void window.unbiased.closeBrowser(id);
      setBrowserTabs([]);
      setAgentMirrorOpen(false);
      setBrowserTitles({});
      // Matching closeSideChat: the engine drops each ephemeral pane, so the
      // fork of the previous conversation doesn't linger under the cap.
      for (const id of sideChatsRef.current) void window.unbiased.resetSideChat(id);
      setSideChats([]);
      setPanelMode("launcher");
      setSideOpenPersisted(false);
      return;
    }
    // The browser isn't cwd-bound — the page you're reading survives.
    const browsers = browserTabsRef.current;
    const chats = sideChatsRef.current;
    setPanelMode(
      browsers.length > 0
        ? `browser:${browsers[browsers.length - 1]}`
        : chats.length > 0
          ? chats[chats.length - 1]
          : "launcher",
    );
    if (chats.length === 0 && browsers.length === 0) setSideOpenPersisted(false);
  }

  // Switching away from a running conversation is fine — its turn keeps
  // going in the engine and the sidebar shows it as active. Only genuinely
  // destructive actions still wait.
  async function newChat(project?: { name: string; path: string }) {
    setScheduledOpen(false);
    setConnectorsOpen(false);
    snapshotSideView();
    await window.unbiased.detachThread(project?.path);
    setActiveProject(project ?? null);
    setActiveThreadId(null);
    setMainStarted(false);
    setMainReset((r) => ({ entries: [], nonce: r.nonce + 1 }));
    resetSideView(true);
  }

  async function openProjectDialog() {
    const { path, name } = await window.unbiased.chooseProject();
    if (!path || !name) return; // cancelled
    snapshotSideView();
    setActiveProject({ name, path });
    setActiveThreadId(null);
    setMainStarted(false);
    setMainReset((r) => ({ entries: [], nonce: r.nonce + 1 }));
    resetSideView(true);
    void refreshThreads(); // the project shows in the sidebar immediately
  }

  const openSeqRef = useRef(0);
  // Clicking a run's completion notification jumps straight to that run.
  // Main has already focused the window; this is the half that decides what
  // the user is looking at when it comes forward.
  useEffect(
    () =>
      window.unbiased.onScheduledOpenRun(({ threadId }) => {
        setScheduledOpen(false);
        setConnectorsOpen(false);
        void openThread(threadId);
      }),
    [],
  );

  async function openThread(id: string) {
    // Leaving a full-page view is the same gesture as switching chats —
    // clicking a destination in the nav. Both entry points clear them so the
    // view never outlives the row that is lit.
    setScheduledOpen(false);
    setConnectorsOpen(false);
    if (id === activeThreadId) return;
    snapshotSideView();
    // Two quick clicks race their awaits — only the latest open may commit.
    const seq = ++openSeqRef.current;
    const stale = () => openSeqRef.current !== seq;
    const res = await window.unbiased.openThread(id);
    if (stale()) return;
    const history = res.entries;
    // The engine's history omits renderer-only content (failed-turn
    // errors, annotation cards). Prefer the cached transcript when it
    // holds at least as much — counting a "Worked for" fold as its
    // CONTENTS, since folding makes the cache shorter than raw history
    // without losing anything.
    const cached = await window.unbiased.loadTranscript(id);
    if (stale()) return;
    // Repair stale fold structure in the cache without discarding it. A pane
    // opened mid-turn used to fold only what streamed after the open, so its
    // saved transcript strands that turn's earlier narration between the user
    // message and the work group. Those assistants can only be narration —
    // a final answer always lands AFTER its turn's work group, and a
    // narrate-only turn creates no group at all — so any unbroken run of
    // assistant entries wedged between a user message and a work group moves
    // inside the group. Content is untouched; only the grouping changes, and
    // the next save persists the repaired shape.
    if (cached.entries) {
      const fixed: Entry[] = [];
      let pendingSinceUser: Entry[] | null = null;
      for (const e of cached.entries) {
        if (e.kind === "user") {
          if (pendingSinceUser) fixed.push(...pendingSinceUser);
          pendingSinceUser = [];
          fixed.push(e);
        } else if (e.kind === "assistant" && pendingSinceUser) {
          pendingSinceUser.push(e);
        } else if (e.kind === "work" && pendingSinceUser && pendingSinceUser.length > 0) {
          fixed.push({ ...e, entries: [...pendingSinceUser, ...e.entries] });
          pendingSinceUser = null;
        } else {
          if (pendingSinceUser) fixed.push(...pendingSinceUser);
          pendingSinceUser = null;
          fixed.push(e);
        }
      }
      if (pendingSinceUser) fixed.push(...pendingSinceUser);
      cached.entries = fixed;
    }
    // Both sides counted the same way — a fold as its CONTENTS — or the
    // comparison is rigged. History now arrives pre-folded (replay groups a
    // turn's narration under "Worked" the way live completion does), so its
    // raw length shrank; measured against that, every stale flat cache
    // suddenly looked "richer" and won, pinning the exact stranded layout the
    // fold was built to fix.
    const richness = (list: Entry[] | null | undefined) =>
      (list ?? []).reduce((n, e) => n + (e.kind === "work" ? Math.max(e.entries.length, 1) : 1), 0);
    const cachedRichness = richness(cached.entries);
    const historyRichness = richness(history as Entry[]);
    // Strictly greater: at equal information, prefer the replay — it carries
    // the corrected fold structure, and the cache may predate it. The cache
    // still wins whenever it genuinely holds more (failure rows, annotation
    // cards — renderer-only content history cannot reconstruct).
    let entries = cached.entries && cachedRichness > historyRichness ? cached.entries : history;
    if (res.running && res.streamText) {
      // The reply is still streaming. Main accumulated the full partial
      // text; a shorter prefix of it may already sit in the cached
      // transcript (saved before switching away) — swap it out.
      const last = entries[entries.length - 1];
      if (last?.kind === "assistant" && res.streamText.startsWith(last.text)) {
        entries = entries.slice(0, -1);
      }
      entries = [...entries, { kind: "assistant", text: res.streamText }];
    }
    if (res.failure) {
      // The turn died while nobody was watching.
      entries = [...entries, { kind: "assistant", text: `⚠ Turn failed: ${res.failure}` }];
    }
    setActiveProject(null);
    setActiveThreadId(id);
    setMainStarted(entries.length > 0);
    setMainReset((r) => ({
      entries,
      nonce: r.nonce + 1,
      resume: res.running ? { running: true, approvals: res.approvals } : null,
    }));
    if (!restoreSideView(id)) resetSideView();
    // The engine may still be running spawns for this thread — pick up the
    // roster the live pushes accumulated while it was backgrounded.
    fileExistsCache.clear(); // chip probes resolve against the new thread's cwd
    void window.unbiased.subagentsList(id).then((r) => {
      if (!stale()) setSubAgentsList(r.agents);
    });
  }

  async function deleteThread(id: string) {
    sidePanelSnapshots.current.delete(id);
    await window.unbiased.deleteThread(id);
    if (id === activeThreadId) {
      setActiveThreadId(null);
      setMainStarted(false);
      setMainReset((r) => ({ entries: [], nonce: r.nonce + 1 }));
      resetSideView(true);
    }
    void refreshThreads();
  }

  // File-viewer tabs — one per opened file, capped.
  const [openFiles, setOpenFiles] = useState<{ id: number; info: OpenFileInfo }[]>([]);
  // Sub-agents of the ACTIVE main conversation (multi-agent v2). The main
  // process pushes roster changes; a (re)opened thread fetches its own.
  const [subAgentsList, setSubAgentsList] = useState<SubAgent[]>([]);
  // The sub-agent whose conversation the side panel is showing.
  // Each opened sub-agent gets its OWN tab (Codex-style), capped.
  const [openAgents, setOpenAgents] = useState<{ threadId: string; name: string }[]>([]);
  const MAX_TABS_PER_KIND = 5;
  const tabIdRef = useRef(1);

  useEffect(() => {
    return window.unbiased.onSubAgents((p) => {
      // Rosters arrive per pane: main's conversation, and any side chat that
      // spawned its own agents. Agent tabs are panel-global, so merge by
      // thread id — filtering to "main" made side-chat sub-agents invisible
      // and their lifecycle rows dead links.
      setSubAgentsList((prev) => {
        const incoming = new Set(p.agents.map((a) => a.threadId));
        const fromOtherPanes = prev.filter((a) => !incoming.has(a.threadId) && a.paneId !== p.paneId);
        return [...fromOtherPanes, ...p.agents.map((a) => ({ ...a, paneId: p.paneId }))];
      });
    });
  }, []);

  function openAgentTab(agent: { threadId: string; name: string }) {
    setOpenAgents((as) => {
      if (as.some((a) => a.threadId === agent.threadId)) return as;
      const next = [...as, { threadId: agent.threadId, name: agent.name }];
      // At the cap the oldest tab yields — the strip stays bounded.
      return next.length > MAX_TABS_PER_KIND ? next.slice(next.length - MAX_TABS_PER_KIND) : next;
    });
    setPanelMode(`agent:${agent.threadId}`);
    setSideOpenPersisted(true);
  }

  // "launcher" = the panel is open with nothing selected yet — it shows
  // big rows asking which surface to open (Codex's empty side panel).
  // Static keys ("chat", "review", "browser", "launcher") name singleton
  // surfaces; dynamic keys ("agent:<threadId>", "terminal:<id>",
  // "files:<id>", "file:<id>") name multi-instance tabs.
  const [panelMode, setPanelMode] = useState<string>("launcher");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [filesTabs, setFilesTabs] = useState<number[]>([]);
  const [treeFiles, setTreeFiles] = useState<Record<number, OpenFileInfo | null>>({});
  const [terminalTabs, setTerminalTabs] = useState<number[]>([]);
  // Singleton: one Chrome, one mirror — like the terminal, a LIVE tab.
  const [agentMirrorOpen, setAgentMirrorOpen] = useState(false);
  // The activity subscription below is mounted once, so it cannot close over
  // activeThreadId — it would compare against the value at mount forever.
  const activeThreadIdRef = useRef<string | null>(null);
  activeThreadIdRef.current = activeThreadId;
  useEffect(
    () =>
      window.unbiased.onAgentMirrorActivity((p) => {
        // Fires on every approved browser tool (main gates the attached-
        // external case), so the pane shows up whenever the agent starts
        // browsing — not only on the one launch per session.
        //
        // Scoped to the conversation on screen. A background chat browsing
        // must not open a pane here: with one tab per conversation that pane
        // would be showing work the user did not ask to watch, in a chat that
        // is not doing it. Its own pane is restored when they switch to it.
        const from = (p as { threadId?: string | null } | null)?.threadId ?? null;
        if (from && activeThreadIdRef.current && from !== activeThreadIdRef.current) return;
        setAgentMirrorOpen((already) => {
          // Don't yank focus away from a tab the user is reading if the pane
          // is already there; just make sure it exists.
          if (!already) {
            setPanelMode("agentmirror");
            setSideOpenPersisted(true);
          }
          return true;
        });
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [browserTabs, setBrowserTabs] = useState<number[]>([]);
  // resetSideView runs after openThread's awaits, so its closure values are
  // stale by then: the user may have closed the last browser tab while a big
  // thread loaded, which left panelMode pointing at a dead tab and the panel
  // wrongly open. These refs give it the arrays as they are at call time.
  const browserTabsRef = useRef(browserTabs);
  browserTabsRef.current = browserTabs;
  const sideChatsRef = useRef(sideChats);
  sideChatsRef.current = sideChats;
  // Live page titles per browser tab (for the strip labels).
  const [browserTitles, setBrowserTitles] = useState<Record<number, string>>({});
  useEffect(
    () =>
      window.unbiased.onBrowserState((st) => {
        setBrowserTitles((m) => (m[st.id] === st.title ? m : { ...m, [st.id]: st.title }));
      }),
    [],
  );

  // ── Tab order + close fallback ──────────────────────────────────────
  // The strip renders tabs in the order they were OPENED (new ones append
  // at the back), and closing the active tab falls back to the remaining
  // most-recent tab — one rule, instead of six hand-rolled chains that
  // each forgot a tab (closing Files with only Browser left used to kill
  // the whole panel).
  const tabKeys: string[] = [
    ...sideChats,
    ...openFiles.map((f) => `file:${f.id}`),
    ...filesTabs.map((id) => `files:${id}`),
    ...(reviewOpen ? ["review"] : []),
    ...browserTabs.map((id) => `browser:${id}`),
    ...terminalTabs.map((id) => `terminal:${id}`),
    ...(agentMirrorOpen ? ["agentmirror"] : []),
    ...openAgents.map((a) => `agent:${a.threadId}`),
  ];
  // Seq numbers survive re-renders; assigning during render is idempotent.
  const tabSeqRef = useRef<Map<string, number>>(new Map());
  const tabSeqCounter = useRef(0);
  for (const t of tabKeys) {
    if (!tabSeqRef.current.has(t)) tabSeqRef.current.set(t, ++tabSeqCounter.current);
  }
  for (const t of [...tabSeqRef.current.keys()]) {
    if (!tabKeys.includes(t)) tabSeqRef.current.delete(t);
  }
  const tabOrder = [...tabKeys].sort((a, b) => tabSeqRef.current.get(a)! - tabSeqRef.current.get(b)!);

  // When the active tab disappears, activate the most recent survivor;
  // only an empty strip closes the panel.
  //
  // Keyed on the tab list ITSELF, not on the collections behind it. The old
  // dependency array named all eight sources by hand, so every new tab kind
  // had to remember to enlist — and the ninth (the agent browser) did not,
  // which left the panel open and empty after closing the last tab. This
  // derived key cannot fall out of date.
  const tabKeysKey = tabKeys.join("\u0000");
  useEffect(() => {
    if (!sideOpen || panelMode === "launcher") return;
    if (tabKeys.includes(panelMode)) return;
    if (tabOrder.length > 0) setPanelMode(tabOrder[tabOrder.length - 1]);
    else setSideOpenPersisted(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sideOpen, panelMode, tabKeysKey]);

  /** Close any tab by its key — one dispatcher instead of per-kind closers. */
  function closeTab(key: string): void {
    if (key.startsWith("side:")) closeSideChat(key);
    else if (key === "agentmirror") setAgentMirrorOpen(false);
    else if (key === "review") setReviewOpen(false);
    else if (key.startsWith("browser:")) closeBrowserTab(Number(key.slice(8)));
    else if (key.startsWith("agent:")) setOpenAgents((as) => as.filter((a) => `agent:${a.threadId}` !== key));
    else if (key.startsWith("file:")) setOpenFiles((fs) => fs.filter((f) => `file:${f.id}` !== key));
    else if (key.startsWith("terminal:")) setTerminalTabs((ts) => ts.filter((id) => `terminal:${id}` !== key));
    else if (key.startsWith("files:")) {
      const id = Number(key.slice(6));
      setFilesTabs((ts) => ts.filter((x) => x !== id));
      setTreeFiles((m) => {
        const rest = { ...m };
        delete rest[id];
        return rest;
      });
    }
  }
  // The Files view's tree column can collapse, leaving the viewer full
  // width — Codex's folders toggle. Persisted.
  const [treeVisible, setTreeVisible] = useState(() => localStorage.getItem("filesTreeVisible") !== "false");

  function toggleTreeVisible() {
    setTreeVisible((v) => {
      localStorage.setItem("filesTreeVisible", String(!v));
      return !v;
    });
  }

  // Rendered preview for files that have one (markdown, SVG). Raw code is
  // the default; the header button flips per file and resets on switch.
  const [previewOn, setPreviewOn] = useState(false);
  // The side panel header's + menu (Review / Terminal / Files / Side chat).
  const [sidePlusOpen, setSidePlusOpen] = useState(false);
  const sidePlusRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!sidePlusOpen) return;
    function onDown(e: MouseEvent) {
      if (!sidePlusRef.current?.contains(e.target as Node)) setSidePlusOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setSidePlusOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [sidePlusOpen]);

  // Environment popover (header): Codex-style summary of the active
  // conversation's checkout — changes, worktree, branch, ship actions.
  // The composer strip only shows before a chat starts; this replaces it.
  const [envOpen, setEnvOpen] = useState(false);
  const envRef = useRef<HTMLSpanElement>(null);
  const [envDiff, setEnvDiff] = useState<{ plus: number; minus: number } | null>(null);
  const [envBranches, setEnvBranches] = useState<{
    branches: string[];
    current: string;
    dirty: DirtyFile[];
  } | null>(null);
  const [envSection, setEnvSection] = useState<"workin" | "branch" | null>(null);
  const [envBranchSearch, setEnvBranchSearch] = useState("");
  const [envMsg, setEnvMsg] = useState<string | null>(null);
  const [envBusy, setEnvBusy] = useState(false);

  useEffect(() => {
    if (!envOpen) return;
    function onDown(e: MouseEvent) {
      if (!envRef.current?.contains(e.target as Node)) setEnvOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setEnvOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [envOpen]);

  async function openEnvMenu() {
    setEnvSection(null);
    setEnvMsg(null);
    setEnvBranchSearch("");
    setEnvDiff(null);
    setEnvBranches(null);
    setEnvOpen(true);
    // All fetches fill in as they land; the popover opens immediately.
    if (activeProjectPath) {
      void window.unbiased.listWorktrees(activeProjectPath).then((r) => setExistingWts(r.worktrees));
    }
    if (gitPath) {
      void window.unbiased.reviewDiff(gitPath, "branch").then((d) => {
        setEnvDiff({ plus: d.plus ?? 0, minus: d.minus ?? 0 });
      });
      void window.unbiased.gitBranches(gitPath).then((r) => {
        if (!r.error) setEnvBranches({ branches: r.branches, current: r.current, dirty: r.dirty });
      });
    }
  }

  function envPickBranch(b: string) {
    if (!envBranches || b === envBranches.current) return;
    if (envBranches.dirty.length > 0) {
      // Same guard as the strip's switcher: dirty checkout → the
      // commit-or-discard modal decides before any switch happens.
      setBranchSwitch({ target: b, files: envBranches.dirty });
      setEnvOpen(false);
      return;
    }
    void doCheckout(b).then(() => setEnvOpen(false));
  }

  async function envCommitPush() {
    if (!gitPath || envBusy) return;
    setEnvBusy(true);
    setEnvMsg("Committing and pushing…");
    const r = await window.unbiased.reviewCommitPush(gitPath);
    setEnvBusy(false);
    setEnvMsg(r.ok ? "Committed and pushed." : (r.error ?? "Failed"));
    if (r.ok) void window.unbiased.reviewDiff(gitPath, "branch").then((d) => setEnvDiff({ plus: d.plus ?? 0, minus: d.minus ?? 0 }));
  }

  async function envCreatePr() {
    if (!gitPath || envBusy) return;
    setEnvBusy(true);
    setEnvMsg("Opening pull request…");
    const r = await window.unbiased.reviewCreatePr(gitPath);
    setEnvBusy(false);
    setEnvMsg(r.ok ? null : (r.error ?? "Failed to create PR"));
    if (r.ok) setEnvOpen(false);
  }

  // The browser is a native layer floating over the panel — it must hide
  // whenever its spot isn't showing: other tab active, panel closed, the
  // + menu dropping over it, or the Settings view replacing the whole UI.
  useEffect(() => {
    const clear =
      !sidePlusOpen &&
      !envOpen &&
      !showSettings &&
      !showChangelog &&
      !confirmDialog &&
      !fullAccessPrompt &&
      !branchSwitch &&
      !branchCreate &&
      !renameDialog &&
      !moveDialog &&
      !editProj;
    for (const id of browserTabs) {
      void window.unbiased.setBrowserVisible({
        id,
        visible: sideOpen && panelMode === `browser:${id}` && clear,
      });
    }
  }, [browserTabs, sideOpen, panelMode, sidePlusOpen, envOpen, showSettings, showChangelog, confirmDialog, fullAccessPrompt, branchSwitch, branchCreate, renameDialog, moveDialog, editProj]);

  function openSideChatTab() {
    setSidePlusOpen(false);
    if (sideChats.length >= MAX_TABS_PER_KIND) {
      setPanelMode(sideChats[sideChats.length - 1]);
      setSideOpenPersisted(true);
      return;
    }
    const id = `side:${tabIdRef.current++}`;
    setSideChats((cs) => [...cs, id]);
    setPanelMode(id);
    setSideOpenPersisted(true);
  }

  function openBrowserTab() {
    setSidePlusOpen(false);
    if (browserTabs.length >= MAX_TABS_PER_KIND) {
      setPanelMode(`browser:${browserTabs[browserTabs.length - 1]}`);
      setSideOpenPersisted(true);
      return;
    }
    const id = tabIdRef.current++;
    setBrowserTabs((ts) => [...ts, id]);
    setPanelMode(`browser:${id}`);
    setSideOpenPersisted(true);
  }

  // Any http(s) link anywhere in the app lands in the embedded browser:
  // the active browser tab if one is focused, else the most recent one,
  // else a fresh tab.
  function openInBrowser(url: string) {
    let id: number;
    if (panelMode.startsWith("browser:") && browserTabs.includes(Number(panelMode.slice(8)))) {
      id = Number(panelMode.slice(8));
    } else if (browserTabs.length > 0) {
      id = browserTabs[browserTabs.length - 1];
    } else {
      id = tabIdRef.current++;
      setBrowserTabs((ts) => [...ts, id]);
    }
    setPanelMode(`browser:${id}`);
    setSideOpenPersisted(true);
    void window.unbiased.openBrowser({ id, url });
  }

  function closeBrowserTab(id: number) {
    setBrowserTabs((ts) => ts.filter((x) => x !== id));
    setBrowserTitles((m) => {
      const rest = { ...m };
      delete rest[id];
      return rest;
    });
    void window.unbiased.closeBrowser(id);
    // Fallback to a surviving tab happens in the tab-order effect.
  }

  function openFilesTab() {
    setSidePlusOpen(false);
    // At the cap, tabs holding LIVE state refuse (a terminal's PTY, a
    // browser's page, a side chat's conversation would all be destroyed);
    // tabs that are just views evict the oldest, like an editor. A file tree
    // is a view, so it evicts.
    const id = tabIdRef.current++;
    setFilesTabs((ts) => {
      const next = [...ts, id];
      return next.length > MAX_TABS_PER_KIND ? next.slice(next.length - MAX_TABS_PER_KIND) : next;
    });
    setPanelMode(`files:${id}`);
    setSideOpenPersisted(true);
  }

  // The header's panel toggle: open to whatever the panel last showed, or
  // the launcher when there's nothing yet.
  function toggleSidePanel() {
    if (sideOpen) {
      setSideOpenPersisted(false);
      return;
    }
    setSideOpenPersisted(true);
    setPanelMode(tabOrder.length > 0 ? tabOrder[tabOrder.length - 1] : "launcher");
  }

  function openReviewTab() {
    setSidePlusOpen(false);
    setReviewOpen(true);
    setPanelMode("review");
    setSideOpenPersisted(true);
  }

  function closeReviewTab() {
    setReviewOpen(false);
  }

  // Closing a terminal tab KILLS its shell (unmount disposes the PTY) —
  // unlike the side chat, a dead terminal has no transcript worth keeping.
  function openAgentMirrorTab() {
    setSidePlusOpen(false);
    setAgentMirrorOpen(true);
    setPanelMode("agentmirror");
    setSideOpenPersisted(true);
  }
  // StepsGroup renders far below and needs to reopen the pane from a
  // transcript label; a ref keeps the callback stable without threading a prop
  // through every layer between here and there.
  openAgentMirrorRef.current = openAgentMirrorTab;
  closeAgentMirrorRef.current = () => setAgentMirrorOpen(false);
  function openTerminalTab() {
    setSidePlusOpen(false);
    if (terminalTabs.length >= MAX_TABS_PER_KIND) {
      setPanelMode(`terminal:${terminalTabs[terminalTabs.length - 1]}`);
      setSideOpenPersisted(true);
      return;
    }
    const id = tabIdRef.current++;
    setTerminalTabs((ts) => [...ts, id]);
    setPanelMode(`terminal:${id}`);
    setSideOpenPersisted(true);
  }

  // Selection → side chat: lands on the focused side-chat tab, else the
  // most recent one, else a fresh tab.
  function askInSideChat(text: string) {
    let id: string;
    if (panelMode.startsWith("side:") && sideChats.includes(panelMode)) {
      id = panelMode;
    } else if (sideChats.length > 0) {
      id = sideChats[sideChats.length - 1];
    } else {
      id = `side:${tabIdRef.current++}`;
      setSideChats((cs) => [...cs, id]);
    }
    setSideContexts((m) => ({ ...m, [id]: text }));
    setPanelMode(id);
    setSideOpenPersisted(true);
  }

  /** Open (or focus) a file-viewer tab. Same file focuses its existing
   *  tab with fresh content; at the cap the oldest tab yields. */
  function addFileTab(info: OpenFileInfo): void {
    const existing = openFiles.find((f) => f.info.fullPath === info.fullPath);
    const id = existing?.id ?? tabIdRef.current++;
    setOpenFiles((fs) => {
      // Decide here, not from the render closure: two quick opens of the same
      // path would both miss `existing` and mint duplicate tabs.
      const hit = fs.find((f) => f.info.fullPath === info.fullPath);
      if (hit) return fs.map((f) => (f.id === hit.id ? { ...f, info } : f));
      const next = [...fs, { id, info }];
      return next.length > MAX_TABS_PER_KIND ? next.slice(next.length - MAX_TABS_PER_KIND) : next;
    });
    setPanelMode(`file:${id}`);
    setSideOpenPersisted(true);
  }

  async function openImagePreview(a: { name: string; path: string }) {
    const result = await window.unbiased.readImage(a.path);
    addFileTab({
      name: a.name,
      relPath: a.name,
      fullPath: a.path,
      imageSrc: result.dataUrl,
      error: result.error,
    });
  }

  /** Text files read through file:read; images route to the picture viewer. */
  async function loadFileInfo(pathText: string, line?: number): Promise<OpenFileInfo> {
    const name = pathText.split("/").filter(Boolean).pop() ?? pathText;
    if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(name)) {
      const r = await window.unbiased.readImage(pathText);
      return { name, relPath: name, fullPath: pathText, imageSrc: r.dataUrl, error: r.error };
    }
    const result = await window.unbiased.readFile(pathText);
    return {
      name,
      relPath: result.relPath ?? pathText,
      fullPath: result.fullPath,
      content: result.content,
      line,
      error: result.error,
    };
  }

  async function openFileInPanel(pathText: string, line?: number) {
    addFileTab(await loadFileInfo(pathText, line));
  }

  // A Files tab's own selection — shown beside its tree, per tab.
  async function openFileInTree(tabId: number, pathText: string, line?: number) {
    const info = await loadFileInfo(pathText, line);
    setTreeFiles((m) => ({ ...m, [tabId]: info }));
  }

  // Closing a side-chat tab discards its conversation — the engine drops
  // the ephemeral pane (matching every other tab kind, and freeing the
  // slot under the cap).
  function closeSideChat(id: string) {
    setSideChats((cs) => cs.filter((x) => x !== id));
    setSideContexts((m) => {
      const rest = { ...m };
      delete rest[id];
      return rest;
    });
    void window.unbiased.resetSideChat(id);
  }

  const connected = status.state === "connected";
  // The engine's list plus any thread it does not know about yet, so a chat
  // is never missing from the nav between pressing Enter and the engine
  // deciding it exists. A stand-in disappears the moment the real row lands.
  const sidebarView = useMemo(() => mergePendingThreads(sidebar, pendingThreads), [sidebar, pendingThreads]);

  // Files (workspace tree) only makes sense inside a project — a plain
  // Recents chat lives in the home directory.
  const activeSidebarProject = sidebar.projects.find((p) =>
    p.threads.some((t) => t.id === activeThreadId),
  );
  const activeProjectName = activeProject?.name ?? activeSidebarProject?.name ?? null;
  const activeProjectPath = activeProject?.path ?? activeSidebarProject?.path ?? null;
  /** Exactly one row in the sidebar is ever lit. A project carries the
   *  highlight only until its chat has a thread (the thread row takes over
   *  from there) — and neither may claim it while Scheduled, which is a
   *  destination of its own, is what you are actually looking at. */
  const litProject = (path: string) =>
    !pageOpen && activeProject?.path === path && !activeThreadId;
  const inProject = activeProjectName !== null;
  // Git operations target the conversation's actual checkout — the
  // worktree when isolated, else the project directory. (Referenced by
  // the branch-switcher handlers above; they run post-render.)
  const gitPath = convCwd ?? activeProjectPath;

  // Entering a project loads ITS Work-in choice (default Local) and pushes
  // it to main so the next thread/start uses it. This also drops any
  // selected existing worktree — it belonged to the previous project.
  useEffect(() => {
    const stored = activeProjectPath ? workModeStore()[activeProjectPath] : undefined;
    const sel: WorkSel = stored === "worktree" ? { mode: "worktree" } : { mode: "local" };
    setWorkSelState(sel);
    void window.unbiased.setWorkMode(sel.mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectPath]);

  useEffect(() => {
    if (!activeProjectPath) {
      setProjectBranch(null);
      setConvCwd(null);
      return;
    }
    let alive = true;
    void (async () => {
      // A started conversation may live in a worktree — branch and git
      // operations must target ITS checkout, not the project's.
      let cwd = activeProjectPath;
      if (mainStarted) {
        const info = await window.unbiased.conversationInfo();
        if (info.cwd && info.isWorktree) cwd = info.cwd;
        if (alive) setConvCwd(info.isWorktree ? info.cwd : null);
      } else if (alive) {
        setConvCwd(null);
      }
      const r = await window.unbiased.gitBranch(cwd);
      if (alive) setProjectBranch(r.branch);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectPath, mainStarted, activeThreadId]);

  // Whatever file the panel is currently showing, and whether it has a
  // rendered form worth offering.
  const visibleFile = panelMode.startsWith("file:")
    ? (openFiles.find((f) => `file:${f.id}` === panelMode)?.info ?? null)
    : panelMode.startsWith("files:")
      ? (treeFiles[Number(panelMode.slice(6))] ?? null)
      : null;
  const previewable =
    !!visibleFile &&
    !visibleFile.error &&
    visibleFile.content !== undefined &&
    /\.(md|markdown|svg)$/i.test(visibleFile.name);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setPreviewOn(false), [visibleFile?.fullPath]);
  const mainTitle = (() => {
    if (activeThreadId) {
      const all = [...sidebarView.projects.flatMap((p) => p.threads), ...sidebarView.recents];
      return all.find((t) => t.id === activeThreadId)?.title ?? "Conversation";
    }
    return activeProject ? `New chat · ${activeProject.name}` : "New chat";
  })();

  // Sign-in gate takes over the whole window until authenticated.
  if (authed !== "in") {
    return (
      <div
        style={{
          ...themeVars(theme),
          height: "100vh",
          display: "flex",
          background: colors.bg,
          color: colors.fg,
          fontFamily: "var(--font-ui)",
        }}
      >
        {authed === "checking" ? <AuthSplash /> : <LoginView onSignedIn={onSignedIn} />}
      </div>
    );
  }

  if (showSettings) {
    return (
      <div
        style={{
          ...themeVars(theme),
          height: "100vh",
          display: "flex",
          background: colors.bg,
          color: colors.fg,
          fontFamily: "var(--font-ui)",
        }}
      >
        <SettingsView
          releases={releases}
          theme={theme}
          onChange={applyTheme}
          onBack={() => setShowSettings(false)}
          onSignOut={signOut}
        />
      </div>
    );
  }

  return (
    <div
      style={{
        ...themeVars(theme),
        height: "100vh",
        display: "flex",
        background: colors.bg,
        color: colors.fg,
        fontFamily: "var(--font-ui)",
      }}
    >
      {navOpen && (
      <nav
        style={{
          width: navWidth,
          flexShrink: 0,
          borderRight: `1px solid ${colors.border}`,
          display: "flex",
          flexDirection: "column",
          background: colors.panel,
        }}
      >
        <div style={{ padding: "14px 14px 6px" }}>
          <div style={{ display: "flex", marginBottom: 14, padding: "2px 0" }}>
            <Wordmark height={15} />
          </div>
          <SidebarAction onClick={() => void newChat()} disabled={false} icon={<NewChatIcon />}>
            New chat
          </SidebarAction>
          <SidebarAction onClick={() => void openProjectDialog()} disabled={false} icon={<FolderPlusIcon />}>
            Open project…
          </SidebarAction>
          <SidebarAction
            onClick={() => {
              setScheduledOpen(false);
              setConnectorsOpen(true);
            }}
            disabled={false}
            active={connectorsOpen}
            icon={<PlugIcon />}
          >
            Connectors
          </SidebarAction>
          <SidebarAction
            onClick={() => {
              setConnectorsOpen(false);
              setScheduledOpen(true);
            }}
            disabled={false}
            active={scheduledOpen}
            icon={<ClockIcon />}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
              Scheduled
              {missedCount > 0 && (
                <span
                  title={`${missedCount} scheduled ${missedCount === 1 ? "task" : "tasks"} came due while Unbiased was closed`}
                  style={{
                    background: colors.amber,
                    color: "#1b1b1b",
                    borderRadius: 999,
                    fontSize: 11,
                    fontWeight: 600,
                    padding: "1px 6px",
                    lineHeight: 1.5,
                  }}
                >
                  {missedCount}
                </span>
              )}
            </span>
          </SidebarAction>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "0 8px 12px" }}>
          {sidebarView.projects.length === 0 && sidebarView.recents.length === 0 && (
            <div style={{ color: colors.dim, fontSize: 12, padding: "8px 8px" }}>No conversations yet</div>
          )}

          <div style={{ display: "flex", alignItems: "stretch" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <SectionLabel collapsed={projectsCollapsed} onToggle={toggleProjectsSection}>
                Projects
              </SectionLabel>
            </div>
            <button
              onClick={() =>
                setEditProj({
                  mode: "create",
                  path: "",
                  name: "",
                  folders: [],
                  primary: "",
                  icon: "folder",
                  color: null,
                  pickerOpen: false,
                  error: null,
                })
              }
              title="Create project"
              aria-label="Create project"
              style={{
                background: "transparent",
                border: "none",
                color: colors.dim,
                cursor: "pointer",
                // Mirror SectionLabel's padding box (14px top, 6px bottom)
                // so the glyph sits on the label's text line.
                padding: "14px 8px 6px",
                display: "flex",
                alignItems: "center",
                flexShrink: 0,
              }}
            >
              <PlusIcon />
            </button>
          </div>
          {!projectsCollapsed &&
          sidebarView.projects.map((p) => (
            <div key={p.path} style={{ marginBottom: 12 }}>
              {/* A label, not a button — chats in a project start from the
                  pencil that appears on hover. */}
              <div
                onMouseEnter={() => setHoveredProject(p.path)}
                onMouseLeave={() => setHoveredProject(null)}
                title={p.path}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  // The project carries the highlight only until its chat has a
                  // thread; from then on the thread row owns it. openThread keeps
                  // the same invariant from the other direction by clearing
                  // activeProject, so exactly one row is ever lit. activeProject
                  // itself must stay set — the Files view, work mode and the
                  // chat's working directory all read it.
                  // Same selected language as ThreadRow — accent rail plus a
                  // tint — so "this project is active" and "this chat is
                  // active" are visibly the same kind of state, which they are.
                  // `lit` rather than a bare comparison: Scheduled is a
                  // destination too, so while it is open no chat or project may
                  // claim the highlight. Without this the sidebar showed two
                  // selected rows at once — the view you are in, and the chat
                  // you were in before it.
                  background: litProject(p.path) ? "var(--chip)" : "transparent",
                  boxShadow: litProject(p.path) ? "inset 2px 0 0 0 var(--accent)" : "none",
                  borderRadius: 8,
                  padding: "8px 8px 6px",
                  // A project heads the chats nested under it, so it keeps its
                  // original 14.5 and takes the weight; the chats stay at 14.
                  fontSize: 14.5,
                  fontWeight: 500,
                  letterSpacing: "var(--track-body)",
                  color: "var(--fg-soft)",
                  boxSizing: "border-box",
                }}
              >
                <ProjectIcon icon={p.icon} color={p.color} />
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {p.name}
                </span>
                {(hoveredProject === p.path || projMenu?.path === p.path) && (
                  <span data-projmenu style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                    <button
                      onClick={(e) => {
                        const r = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
                        setProjMenu((cur) =>
                          cur?.path === p.path ? null : { path: p.path, x: r.right, y: r.bottom + 6 },
                        );
                      }}
                      title="Project options"
                      aria-label="Project options"
                      aria-expanded={projMenu?.path === p.path}
                      style={{
                        background: "transparent",
                        border: "none",
                        color: colors.dim,
                        cursor: "pointer",
                        padding: 0,
                        display: "flex",
                      }}
                    >
                      <EllipsisIcon />
                    </button>
                    <button
                      onClick={() => void newChat({ name: p.name, path: p.path })}
                      title={`New chat in ${p.name}`}
                      aria-label={`New chat in ${p.name}`}
                      style={{
                        background: "transparent",
                        border: "none",
                        color: colors.dim,
                        cursor: "pointer",
                        padding: 0,
                        display: "flex",
                      }}
                    >
                      <NewChatIcon />
                    </button>
                    {projMenu?.path === p.path && (
                      <div
                        style={{
                          position: "fixed",
                          top: projMenu.y,
                          left: Math.max(8, Math.min(projMenu.x - 210, window.innerWidth - 226)),
                          width: 210,
                          background: colors.panel,
                          border: `1px solid ${colors.border}`,
                          borderRadius: 12,
                          padding: 6,
                          zIndex: 60,
                          boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
                        }}
                      >
                        <MenuItem
                          icon={<PencilIcon />}
                          label="Edit project…"
                          onClick={() => {
                            setProjMenu(null);
                            setEditProj({
                              mode: "edit",
                              path: p.path,
                              name: p.name,
                              folders: p.folders ?? [p.path],
                              primary: p.path,
                              icon: p.icon ?? "folder",
                              color: p.color ?? null,
                              pickerOpen: false,
                              error: null,
                            });
                          }}
                        />
                        <MenuItem
                          icon={<FolderOutlineIcon size={15} />}
                          label="Reveal in Finder"
                          onClick={() => {
                            setProjMenu(null);
                            void window.unbiased.revealProject(p.path);
                          }}
                        />
                        <MenuItem
                          icon={<ArchiveIcon />}
                          label="Archive chats"
                          disabled={p.threads.length === 0}
                          desc={p.threads.length === 0 ? "No chats" : undefined}
                          onClick={() => {
                            setProjMenu(null);
                            setConfirmDialog({
                              kind: "archive",
                              path: p.path,
                              name: p.name,
                              count: p.threads.length,
                            });
                          }}
                        />
                        <MenuItem
                          icon={<CloseIcon />}
                          label="Remove"
                          onClick={() => {
                            setProjMenu(null);
                            setConfirmDialog({ kind: "remove", path: p.path, name: p.name, count: 0 });
                          }}
                        />
                      </div>
                    )}
                  </span>
                )}
              </div>
              {p.threads.map((t) => (
                <ThreadRow
                  key={t.id}
                  thread={t}
                  active={!pageOpen && t.id === activeThreadId}
                  hovered={hoveredThreadId === t.id}
                  running={runningThreads.has(t.id)}
                  indent
                  onHover={setHoveredThreadId}
                  onOpen={openThread}
                  menuOpen={threadMenu?.id === t.id}
                  onMenu={(x, y) => setThreadMenu((cur) => (cur?.id === t.id ? null : { id: t.id, title: t.title, inProject: true, x, y }))}
                />
              ))}
            </div>
          ))}

          {sidebarView.recents.length > 0 && (
            <SectionLabel collapsed={recentsCollapsed} onToggle={toggleRecentsSection}>
              Recents
            </SectionLabel>
          )}
          {!recentsCollapsed &&
          sidebarView.recents.map((t) => (
            <ThreadRow
              key={t.id}
              thread={t}
              active={!pageOpen && t.id === activeThreadId}
              hovered={hoveredThreadId === t.id}
              running={runningThreads.has(t.id)}
              onHover={setHoveredThreadId}
              onOpen={openThread}
              menuOpen={threadMenu?.id === t.id}
              onMenu={(x, y) => setThreadMenu((cur) => (cur?.id === t.id ? null : { id: t.id, title: t.title, inProject: false, x, y }))}
            />
          ))}
        </div>
        {update && (
          <UpdateBanner
            version={update.version}
            progress={updateProgress}
            error={updateError}
            staged={updateStaged}
            onAct={() =>
              void (updateStaged ? window.unbiased.applyUpdate() : window.unbiased.downloadUpdate())
            }
          />
        )}
        <div style={{ padding: "4px 14px 2px", flexShrink: 0, display: "flex", alignItems: "center", gap: 2 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <SidebarAction onClick={() => setShowSettings(true)} disabled={false} icon={<GearIcon />}>
              Settings
            </SidebarAction>
          </div>
          <button
            onClick={() => {
              localStorage.setItem("changelogSeen", releases[0]?.version ?? "");
              setChangelogUnread(false);
              setShowChangelog(true);
            }}
            title="What's new"
            style={{
              position: "relative",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 30,
              height: 30,
              flexShrink: 0,
              background: "transparent",
              border: "none",
              borderRadius: 8,
              color: "var(--fg-soft)",
              cursor: "pointer",
            }}
          >
            <BellIcon />
            {changelogUnread && (
              <span
                style={{
                  position: "absolute",
                  top: 5,
                  right: 5,
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: colors.accent,
                  border: `1.5px solid ${colors.bg}`,
                }}
              />
            )}
          </button>
        </div>
        <ChatFooter status={status} busy={mainBusy} />
      </nav>
      )}
      {navOpen && (
        <div
          onMouseDown={() => {
            navDraggingRef.current = true;
            document.body.style.userSelect = "none";
            document.body.style.cursor = "col-resize";
          }}
          title="Drag to resize"
          // Invisible grab strip straddling the nav's border; the nav's own
          // borderRight draws the line, so this adds no visual weight.
          style={{
            width: 5,
            flexShrink: 0,
            cursor: "col-resize",
            background: "transparent",
            marginLeft: -5,
            zIndex: 5,
          }}
        />
      )}

      <div
        style={{
          flex: sideOpen ? `${1 - sideFrac} 1 0%` : "1 1 0%",
          minWidth: 320,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Scheduled tasks lives in the content area, not over it and not
            instead of the whole window: the nav stays put and you leave the
            way you leave a chat — by clicking somewhere else in it. */}
        {connectorsOpen ? (
          <ConnectorsView navOpen={navOpen} onToggleNav={toggleNav} />
        ) : scheduledOpen ? (
          <ScheduledView
            defaultProject={activeProjectPath ?? null}
            projects={sidebar.projects}
            navOpen={navOpen}
            onToggleNav={toggleNav}
            focusKey={scheduledFocus}
            onFocusHandled={() => setScheduledFocus(null)}
            onOpenThread={(id) => {
              setScheduledOpen(false);
              setConnectorsOpen(false);
              void openThread(id);
            }}
          />
        ) : (
          <>
        <header
          style={{
            padding: "10px 16px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexShrink: 0,
            // Deliberately NOT translucent. This bar is a flex sibling of the
            // transcript, not a layer above it, so nothing ever passes behind
            // it — a backdrop-filter here blurs the parent background and
            // costs a compositing pass to render something identical to an
            // opaque fill. Translucency is applied where surfaces genuinely
            // overlap content instead (the modal scrims).
            //
            // Separation comes from HeaderEdge, which needs this element to be
            // a positioned stacking context so its overflow is not painted
            // over by the transcript that follows it.
            position: "relative",
            zIndex: 2,
          }}
        >
          <HeaderEdge />
          <IconButton title={navOpen ? "Hide sidebar" : "Show sidebar"} onClick={toggleNav}>
            <PanelIcon />
          </IconButton>
          <span
            style={{
              fontSize: 14,
              fontWeight: 500,
              color: colors.fg,
              letterSpacing: "var(--track-body)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {mainTitle}
          </span>
          <span style={{ flex: 1 }} />
          {mainStarted && (
            <span ref={envRef} style={{ position: "relative", display: "flex" }}>
              <IconButton title="Environment" onClick={() => (envOpen ? setEnvOpen(false) : void openEnvMenu())}>
                <EnvIcon />
              </IconButton>
              {envOpen && (
                <div
                  style={{
                    position: "absolute",
                    top: "calc(100% + 8px)",
                    right: 0,
                    width: 300,
                    background: colors.panel,
                    border: `1px solid ${colors.border}`,
                    borderRadius: 14,
                    padding: 8,
                    zIndex: 60,
                    boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
                  }}
                >
                  {inProject && (
                    <>
                    <div style={{ color: colors.dim, fontSize: 12.5, padding: "4px 10px 8px" }}>Environment</div>
                    <EnvRow
                      icon={<ChangesIcon />}
                      label="Changes"
                      right={
                        envDiff ? (
                          <span style={{ fontVariantNumeric: "tabular-nums" }}>
                            <span style={{ color: colors.ok }}>+{envDiff.plus}</span>{" "}
                            <span style={{ color: colors.err }}>-{envDiff.minus}</span>
                          </span>
                        ) : (
                          <span style={{ color: colors.dim }}>…</span>
                        )
                      }
                      onClick={() => {
                        openReviewTab();
                        setEnvOpen(false);
                      }}
                    />
                    <EnvRow
                      icon={convCwd ? <SteerIcon /> : <LaptopIcon />}
                      label={convCwd ? "Worktree" : "Local"}
                      right={<Chevron open={envSection === "workin"} />}
                      onClick={() => setEnvSection((s) => (s === "workin" ? null : "workin"))}
                    />
                    {envSection === "workin" && (
                      <div style={{ padding: "0 0 4px 12px" }}>
                        {(
                          [
                            { sel: { mode: "local" } as const, key: "local", label: "Local", icon: <LaptopIcon /> },
                            { sel: { mode: "worktree" } as const, key: "worktree", label: "New worktree", icon: <SteerIcon /> },
                            ...existingWts.map((wt) => ({
                              sel: { mode: "existing", dir: wt.dir, branch: wt.branch } as const,
                              key: wt.dir,
                              label: wt.branch,
                              icon: <BranchIcon />,
                            })),
                          ]
                        ).map((opt) => (
                          <button
                            key={opt.key}
                            onClick={() => changeWorkMode(opt.sel)}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 10,
                              width: "100%",
                              background: "transparent",
                              border: "none",
                              borderRadius: 8,
                              padding: "7px 10px",
                              fontSize: 13,
                              color: colors.fg,
                              cursor: "pointer",
                              textAlign: "left",
                              fontFamily: "inherit",
                            }}
                          >
                            <span style={{ color: colors.dim, display: "flex", flexShrink: 0 }}>{opt.icon}</span>
                            <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                              {opt.label}
                            </span>
                            {opt.sel.mode === "existing" && opt.sel.dir === convCwd && (
                              <span
                                style={{
                                  color: colors.dim,
                                  fontSize: 11,
                                  border: `1px solid ${colors.border}`,
                                  borderRadius: 5,
                                  padding: "1px 6px",
                                  flexShrink: 0,
                                }}
                              >
                                current
                              </span>
                            )}
                            {(workSel.mode === opt.sel.mode &&
                              (opt.sel.mode !== "existing" ||
                                (workSel.mode === "existing" && workSel.dir === opt.sel.dir))) && <CheckIcon />}
                          </button>
                        ))}
                        <div style={{ color: colors.dim, fontSize: 11.5, padding: "4px 10px 2px", lineHeight: 1.4 }}>
                          Applies to new chats in {activeProjectName ?? "this project"} — this conversation keeps its
                          checkout.
                        </div>
                      </div>
                    )}
                    <EnvRow
                      icon={<BranchIcon />}
                      label={envBranches?.current ?? projectBranch ?? "…"}
                      right={<Chevron open={envSection === "branch"} />}
                      onClick={() => setEnvSection((s) => (s === "branch" ? null : "branch"))}
                    />
                    {envSection === "branch" && envBranches && (
                      <div style={{ padding: "0 0 4px 12px" }}>
                        <input
                          value={envBranchSearch}
                          onChange={(e) => setEnvBranchSearch(e.target.value)}
                          placeholder="Find a branch…"
                          spellCheck={false}
                          style={{
                            width: "100%",
                            boxSizing: "border-box",
                            background: "var(--panel-2)",
                            color: colors.fg,
                            border: `1px solid ${colors.border}`,
                            borderRadius: 8,
                            padding: "6px 10px",
                            fontSize: 12.5,
                            outline: "none",
                            margin: "2px 0 4px",
                            fontFamily: "inherit",
                          }}
                        />
                        <div style={{ maxHeight: 180, overflowY: "auto" }}>
                          {envBranches.branches
                            .filter((b) => b.toLowerCase().includes(envBranchSearch.toLowerCase()))
                            .slice(0, 30)
                            .map((b) => (
                              <button
                                key={b}
                                onClick={() => envPickBranch(b)}
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 10,
                                  width: "100%",
                                  background: "transparent",
                                  border: "none",
                                  borderRadius: 8,
                                  padding: "6px 10px",
                                  fontSize: 13,
                                  color: colors.fg,
                                  cursor: "pointer",
                                  textAlign: "left",
                                  fontFamily: "var(--font-code)",
                                }}
                              >
                                <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                  {b}
                                </span>
                                {b === envBranches.current && <CheckIcon />}
                              </button>
                            ))}
                        </div>
                        <button
                          onClick={() => {
                            setBranchCreate(true);
                            setEnvOpen(false);
                          }}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            width: "100%",
                            background: "transparent",
                            border: "none",
                            borderRadius: 8,
                            padding: "6px 10px",
                            fontSize: 13,
                            color: colors.fg,
                            cursor: "pointer",
                            textAlign: "left",
                            fontFamily: "inherit",
                          }}
                        >
                          <span style={{ color: colors.dim, display: "flex" }}>
                            <PlusIcon />
                          </span>
                          Create new branch…
                        </button>
                      </div>
                    )}
                    <div style={{ borderTop: `1px solid ${colors.border}`, margin: "6px 4px" }} />
                    <EnvRow icon={<CommitIcon />} label="Commit or push" onClick={() => void envCommitPush()} />
                    <EnvRow icon={<PrIcon />} label="Create pull request" onClick={() => void envCreatePr()} />
                    {envMsg && (
                      <div style={{ color: colors.dim, fontSize: 12, padding: "6px 10px 2px" }}>{envMsg}</div>
                    )}
                    </>
                  )}
                  {subAgentsList.length > 0 && (
                    <>
                      {inProject && <div style={{ borderTop: `1px solid ${colors.border}`, margin: "6px 4px" }} />}
                      <div style={{ color: colors.dim, fontSize: 12.5, padding: "4px 10px 8px" }}>Subagents</div>
                      {subAgentsList.map((a) => (
                        <button
                          key={a.threadId}
                          onClick={() => {
                            setEnvOpen(false);
                            openAgentTab(a);
                          }}
                          title={a.path}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 11,
                            width: "100%",
                            background: "transparent",
                            border: "none",
                            borderRadius: 8,
                            padding: "9px 10px",
                            cursor: "pointer",
                            textAlign: "left",
                            fontFamily: "inherit",
                          }}
                        >
                          <span style={{ fontSize: 16, flexShrink: 0, lineHeight: 1 }}>{agentEmoji(a.threadId)}</span>
                          <span
                            style={{
                              flex: 1,
                              minWidth: 0,
                              fontSize: 14.5,
                              fontWeight: 600,
                              letterSpacing: -0.15,
                              color: colors.fg,
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {a.name}
                          </span>
                          {a.status === "running" ? (
                            <ShimmerText text="is working" fontSize={13} />
                          ) : (
                            <span style={{ color: a.status === "failed" ? colors.err : colors.dim, fontSize: 13 }}>
                              {a.status === "failed" ? "failed" : "done"}
                            </span>
                          )}
                        </button>
                      ))}
                    </>
                  )}
                  {!inProject && subAgentsList.length === 0 && (
                    <div style={{ color: colors.dim, fontSize: 12.5, padding: "4px 10px 8px", lineHeight: 1.4 }}>
                      Sub-agents spawned in this chat will appear here.
                    </div>
                  )}
                </div>
              )}
            </span>
          )}
          <IconButton title={sideOpen ? "Close side panel" : "Open side panel"} onClick={toggleSidePanel}>
            <SideChatIcon />
          </IconButton>
        </header>
        <ChatPane
          paneId="main"
          connected={connected}
          reset={mainReset}
          threadId={activeThreadId}
          persistTranscript
          planMode={planMode}
          onTogglePlanMode={togglePlanMode}
          contextChip={mainContext}
          onContextClear={() => setMainContext(null)}
          emptyState={
            !connected ? (
              <div style={{ textAlign: "center" }}>
                <h1 style={{ margin: 0, display: "flex", justifyContent: "center" }}>
                  <Wordmark height={36} />
                </h1>
                <p style={{ color: colors.dim, marginTop: 8 }}>Waiting for the engine…</p>
              </div>
            ) : (
              <StartPage
                projectName={activeProjectName}
                onPick={(text) => setMainSeed({ text, nonce: seedNonceRef.current++ })}
              />
            )
          }
          draftSeed={mainSeed}
          composerHeader={
            // Only before the chat exists — once active, the header's
            // Environment popover carries this information instead.
            activeProjectPath && !mainStarted ? (
              <div
                style={{
                  maxWidth: 768,
                  margin: "0 auto 8px",
                  display: "flex",
                  alignItems: "center",
                  gap: 18,
                  padding: "8px 14px",
                  background: colors.panel,
                  borderRadius: 12,
                  fontSize: 13,
                  color: colors.dim,
                  // No overflow:hidden here — the branch dropdown escapes
                  // this box upward; children truncate themselves.
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 7, color: colors.fg, minWidth: 0 }}>
                  <span style={{ color: colors.accent, display: "flex" }}>
                    <FolderOutlineIcon size={14} />
                  </span>
                  <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {activeProjectName}
                  </span>
                </span>
                <span data-workmenu style={{ position: "relative", display: "flex", flexShrink: 0 }}>
                  <button
                    onClick={() => (workMenuOpen ? setWorkMenuOpen(false) : void openWorkMenu())}
                    title="Where new chats in this project work"
                    aria-expanded={workMenuOpen}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      background: workMenuOpen ? "var(--chip)" : "transparent",
                      border: "none",
                      borderRadius: 8,
                      padding: "3px 8px",
                      margin: "-3px -8px",
                      color: colors.dim,
                      fontSize: 13,
                      cursor: "pointer",
                      fontFamily: "inherit",
                    }}
                  >
                    {mainStarted ? (
                      convCwd !== null ? (
                        <>
                          <SteerIcon />
                          Worktree
                        </>
                      ) : (
                        <>
                          <LaptopIcon />
                          Local
                        </>
                      )
                    ) : workSel.mode === "local" ? (
                      <>
                        <LaptopIcon />
                        Local
                      </>
                    ) : (
                      <>
                        <SteerIcon />
                        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 160 }}>
                          {workSel.mode === "existing" ? workSel.branch : "New worktree"}
                        </span>
                      </>
                    )}
                  </button>
                  {workMenuOpen && (
                    <div
                      style={{
                        position: "absolute",
                        bottom: "calc(100% + 10px)",
                        left: -8,
                        width: 250,
                        background: colors.panel,
                        border: `1px solid ${colors.border}`,
                        borderRadius: 14,
                        padding: 8,
                        zIndex: 30,
                        boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
                      }}
                    >
                      <div style={{ color: colors.dim, fontSize: 12.5, padding: "4px 10px 8px" }}>Work in</div>
                      {(
                        [
                          { sel: { mode: "local" } as const, key: "local", label: "Local", icon: <LaptopIcon /> },
                          { sel: { mode: "worktree" } as const, key: "worktree", label: "New worktree", icon: <SteerIcon /> },
                          ...existingWts.map((wt) => ({
                            sel: { mode: "existing", dir: wt.dir, branch: wt.branch } as const,
                            key: wt.dir,
                            label: wt.branch,
                            icon: <BranchIcon />,
                          })),
                        ]
                      ).map((opt, i) => (
                        <div key={opt.key}>
                          {i === 2 && (
                            <div
                              style={{
                                color: colors.dim,
                                fontSize: 12.5,
                                padding: "8px 10px 4px",
                                borderTop: `1px solid ${colors.border}`,
                                marginTop: 6,
                              }}
                            >
                              Existing worktrees
                            </div>
                          )}
                          <button
                            onClick={() => changeWorkMode(opt.sel)}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 10,
                              width: "100%",
                              background: "transparent",
                              border: "none",
                              borderRadius: 8,
                              padding: "8px 10px",
                              fontSize: 13.5,
                              color: colors.fg,
                              cursor: "pointer",
                              textAlign: "left",
                              fontFamily: "inherit",
                            }}
                          >
                            <span style={{ color: colors.dim, display: "flex", flexShrink: 0 }}>{opt.icon}</span>
                            <span
                              style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                            >
                              {opt.label}
                            </span>
                            {/* The ✓ is the NEXT-chat choice; tag where THIS
                                conversation actually runs so the two never
                                get read as one. */}
                            {opt.sel.mode === "existing" && opt.sel.dir === convCwd && (
                              <span
                                style={{
                                  color: colors.dim,
                                  fontSize: 11,
                                  border: `1px solid ${colors.border}`,
                                  borderRadius: 5,
                                  padding: "1px 6px",
                                  flexShrink: 0,
                                }}
                              >
                                current
                              </span>
                            )}
                            {(workSel.mode === opt.sel.mode &&
                              (opt.sel.mode !== "existing" ||
                                (workSel.mode === "existing" && workSel.dir === opt.sel.dir))) && <CheckIcon />}
                          </button>
                        </div>
                      ))}
                      {/* The choice binds to THIS project — picking it here while
                          meaning "my next chat elsewhere" is how a worktree once
                          landed in the wrong repo, so always name the scope. */}
                      <div style={{ color: colors.dim, fontSize: 12, padding: "6px 10px 2px", lineHeight: 1.4 }}>
                        Applies to new chats in {activeProjectName ?? "this project"}
                        {mainStarted ? " — this conversation keeps its checkout." : "."}
                      </div>
                    </div>
                  )}
                </span>
                {projectBranch && (
                  <span data-branchmenu style={{ position: "relative", display: "flex", minWidth: 0 }}>
                    <button
                      onClick={() => (branchMenu ? setBranchMenu(null) : void openBranchMenu())}
                      title="Switch branch"
                      aria-expanded={!!branchMenu}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                        minWidth: 0,
                        background: branchMenu ? "var(--chip)" : "transparent",
                        border: "none",
                        borderRadius: 8,
                        padding: "3px 8px",
                        margin: "-3px -8px",
                        color: colors.dim,
                        fontSize: 13,
                        cursor: "pointer",
                        fontFamily: "inherit",
                      }}
                    >
                      <BranchIcon />
                      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {projectBranch}
                      </span>
                    </button>
                    {branchMenu && (
                      <div
                        style={{
                          position: "absolute",
                          bottom: "calc(100% + 10px)",
                          left: -8,
                          width: 320,
                          maxHeight: 380,
                          display: "flex",
                          flexDirection: "column",
                          background: colors.panel,
                          border: `1px solid ${colors.border}`,
                          borderRadius: 14,
                          padding: 8,
                          zIndex: 30,
                          boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
                        }}
                      >
                        <input
                          autoFocus
                          value={branchSearch}
                          onChange={(e) => setBranchSearch(e.target.value)}
                          placeholder={`Search ${activeProjectName ?? ""} branches`}
                          spellCheck={false}
                          style={{
                            background: "var(--panel-2)",
                            border: `1px solid ${colors.border}`,
                            borderRadius: 8,
                            padding: "7px 10px",
                            color: colors.fg,
                            fontSize: 13,
                            outline: "none",
                            fontFamily: "inherit",
                          }}
                        />
                        <div style={{ color: colors.dim, fontSize: 12.5, padding: "10px 10px 4px" }}>Branches</div>
                        <div style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
                          {branchMenu.branches
                            .filter((b) => b.toLowerCase().includes(branchSearch.toLowerCase()))
                            .map((b) => (
                              <button
                                key={b}
                                onClick={() => pickBranch(b)}
                                disabled={branchBusy}
                                style={{
                                  display: "flex",
                                  alignItems: "flex-start",
                                  gap: 10,
                                  width: "100%",
                                  background: "transparent",
                                  border: "none",
                                  borderRadius: 8,
                                  padding: "8px 10px",
                                  fontSize: 13.5,
                                  color: colors.fg,
                                  cursor: "pointer",
                                  textAlign: "left",
                                  fontFamily: "inherit",
                                }}
                              >
                                <span style={{ color: colors.dim, display: "flex", marginTop: 2, flexShrink: 0 }}>
                                  <BranchIcon />
                                </span>
                                <span style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                    {b}
                                  </div>
                                  {b === branchMenu.current && branchMenu.dirty.length > 0 && (
                                    <div style={{ color: colors.dim, fontSize: 12.5, marginTop: 2 }}>
                                      Uncommitted: {branchMenu.dirty.length} file
                                      {branchMenu.dirty.length === 1 ? "" : "s"}
                                    </div>
                                  )}
                                </span>
                                {b === branchMenu.current && (
                                  <span style={{ color: colors.fg, display: "flex", marginTop: 2 }}>
                                    <CheckIcon />
                                  </span>
                                )}
                              </button>
                            ))}
                        </div>
                        {branchError && (
                          <div style={{ color: colors.err, fontSize: 12.5, padding: "6px 10px" }}>{branchError}</div>
                        )}
                        <div style={{ borderTop: `1px solid ${colors.border}`, marginTop: 6, paddingTop: 6 }}>
                          <button
                            onClick={() => {
                              setBranchMenu(null);
                              setBranchName("");
                              setBranchError(null);
                              setBranchCreate(true);
                            }}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 10,
                              width: "100%",
                              background: "transparent",
                              border: "none",
                              borderRadius: 8,
                              padding: "8px 10px",
                              fontSize: 13.5,
                              color: colors.fg,
                              cursor: "pointer",
                              textAlign: "left",
                              fontFamily: "inherit",
                            }}
                          >
                            <PlusIcon />
                            Create and checkout new branch…
                          </button>
                        </div>
                      </div>
                    )}
                  </span>
                )}
              </div>
            ) : undefined
          }
          onOpenAgent={openAgentTab}
          onOpenScheduled={(key) => {
            setScheduledFocus(key);
            setScheduledOpen(true);
          }}
          onOpenMcp={() => setMcpOpen(true)}
          onOpenConnectors={() => setConnectorsPanelOpen(true)}
          onOpenSkills={() => setSkillsOpen(true)}
          onBusyChange={(b) => {
            setMainBusy(b);
            if (b) setMainStarted(true);
          }}
          onTurnLanded={refreshThreads}
          onThreadCreated={(id, created, firstMessage) => {
            setActiveThreadId(id);
            // The engine will not list this thread until it has content, so
            // the nav row has to come from here — otherwise starting a chat
            // and walking away looks like the chat was thrown out.
            if (!created) return;
            setPendingThreads((ps) =>
              ps.some((p) => p.id === id)
                ? ps
                : [
                    ...ps,
                    {
                      id,
                      title: provisionalTitle(firstMessage),
                      projectPath: activeProject?.path ?? null,
                    },
                  ],
            );
          }}
          onAskSideChat={askInSideChat}
          onOpenFile={(p) => void openFileInPanel(p)}
          onPreviewImage={(a) => void openImagePreview(a)}
          onOpenLink={openInBrowser}
          accessMode={accessMode}
          onAccessModeChange={changeAccessMode}
        />
          </>
        )}
      </div>

      {sideOpen && (
        <div
          onMouseDown={() => {
            draggingRef.current = true;
            document.body.style.userSelect = "none";
            document.body.style.cursor = "col-resize";
          }}
          title="Drag to resize"
          style={{
            width: 5,
            flexShrink: 0,
            cursor: "col-resize",
            background: "transparent",
            borderLeft: `1px solid ${colors.border}`,
          }}
        />
      )}
      {/* Always mounted so the side conversation survives hide/show; only
          its visibility toggles. */}
        <div
          style={{
            flex: sideOpen ? `${sideFrac} 1 0%` : "0 0 0%",
            minWidth: sideOpen ? 300 : 0,
            display: sideOpen ? "flex" : "none",
            flexDirection: "column",
            background: "var(--nav-bg)",
          }}
        >
          <header
            style={{
              padding: "8px 12px",
              display: "flex",
              alignItems: "center",
              gap: 6,
              flexShrink: 0,
            }}
          >
            {tabOrder.map((t) => {
              const agent = t.startsWith("agent:")
                ? openAgents.find((a) => `agent:${a.threadId}` === t)
                : undefined;
              const fileTab = t.startsWith("file:")
                ? openFiles.find((f) => `file:${f.id}` === t)
                : undefined;
              const termIdx = t.startsWith("terminal:") ? terminalTabs.indexOf(Number(t.slice(9))) : -1;
              const cfg: { icon: React.ReactNode; label: string; close: () => void; aria: string; title?: string } =
                t.startsWith("side:")
                  ? {
                      icon: <ChatPlusIcon />,
                      label: sideChats.length > 1 ? `Side chat ${sideChats.indexOf(t) + 1}` : "Side chat",
                      close: () => closeTab(t),
                      aria: "Close side chat",
                    }
                  : fileTab
                    ? {
                        icon: null,
                        label: fileTab.info.name,
                        close: () => closeTab(t),
                        aria: "Close file",
                        title: fileTab.info.fullPath,
                      }
                    : t.startsWith("files:")
                      ? { icon: <FolderOutlineIcon size={13} />, label: "Files", close: () => closeTab(t), aria: "Close files" }
                      : t === "review"
                        ? { icon: <ReviewIcon />, label: "Review", close: closeReviewTab, aria: "Close review" }
                        : t.startsWith("browser:")
                          ? {
                              icon: <GlobeIcon size={13} />,
                              label: browserTitles[Number(t.slice(8))] || "Browser",
                              close: () => closeTab(t),
                              aria: "Close browser",
                            }
                          : agent
                            ? {
                                icon: <span style={{ fontSize: 13 }}>{agentEmoji(agent.threadId)}</span>,
                                // Nicknames land after the spawn — prefer the roster's live name.
                                label: subAgentsList.find((x) => x.threadId === agent.threadId)?.name ?? agent.name,
                                close: () => closeTab(t),
                                aria: "Close sub-agent",
                              }
                            : t === "agentmirror"
                              ? {
                                  icon: <GlobeIcon size={13} />,
                                  label: "Agent browser",
                                  close: () => closeTab(t),
                                  aria: "Close agent browser",
                                }
                              : {
                                  icon: <TerminalIcon size={13} />,
                                  label:
                                    terminalTabs.length > 1
                                      ? `Terminal ${termIdx + 1}`
                                      : (activeProjectName ?? "Terminal"),
                                  close: () => closeTab(t),
                                  aria: "Close terminal",
                                };
              return (
                <button
                  key={t}
                  onClick={() => setPanelMode(t)}
                  title={cfg.title}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    background: panelMode === t ? colors.panel : "transparent",
                    color: panelMode === t ? colors.fg : colors.dim,
                    border: "none",
                    borderRadius: 8,
                    padding: "6px 12px",
                    fontSize: 13,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    minWidth: 0,
                    ...(t.startsWith("file:") ? { maxWidth: 220 } : {}),
                  }}
                >
                  {cfg.icon}
                  <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{cfg.label}</span>
                  <span
                    role="button"
                    aria-label={cfg.aria}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      cfg.close();
                    }}
                    style={{ display: "flex", color: colors.dim, marginLeft: 2 }}
                  >
                    <CloseIcon />
                  </span>
                </button>
              );
            })}
            <span ref={sidePlusRef} style={{ position: "relative", display: "flex" }}>
              <IconButton title="Open side panel tab" onClick={() => setSidePlusOpen((o) => !o)}>
                <PlusIcon />
              </IconButton>
              {sidePlusOpen && (
                <div
                  style={{
                    position: "absolute",
                    top: 32,
                    left: 0,
                    width: 224,
                    background: colors.panel,
                    border: `1px solid ${colors.border}`,
                    borderRadius: 12,
                    padding: 6,
                    zIndex: 30,
                    boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
                  }}
                >
                  {inProject && <MenuItem icon={<ReviewIcon />} label="Review" onClick={openReviewTab} />}
                  <MenuItem icon={<TerminalIcon />} label="Terminal" onClick={openTerminalTab} />
                  <MenuItem icon={<GlobeIcon />} label="Browser" onClick={openBrowserTab} />
                  {inProject && (
                    <MenuItem icon={<FolderOutlineIcon size={15} />} label="Files" onClick={openFilesTab} />
                  )}
                  {mainStarted && (
                    <MenuItem icon={<ChatPlusIcon />} label="Side chat" onClick={openSideChatTab} />
                  )}
                  {subAgentsList.length > 0 && (
                    <>
                      <div style={{ color: colors.dim, fontSize: 12.5, padding: "8px 10px 4px", borderTop: `1px solid ${colors.border}`, marginTop: 6 }}>
                        Sub-agents
                      </div>
                      {subAgentsList.map((a) => (
                        <MenuItem
                          key={a.threadId}
                          icon={<span style={{ fontSize: 14 }}>{agentEmoji(a.threadId)}</span>}
                          label={a.name}
                          desc={a.status === "running" ? "working…" : a.status}
                          onClick={() => {
                            setSidePlusOpen(false);
                            openAgentTab(a);
                          }}
                        />
                      ))}
                    </>
                  )}
                </div>
              )}
            </span>
            <span style={{ flex: 1 }} />
            {previewable && (
              <button
                onClick={() => setPreviewOn((o) => !o)}
                style={{
                  background: "transparent",
                  border: `1px solid ${colors.border}`,
                  color: colors.dim,
                  borderRadius: 8,
                  padding: "4px 10px",
                  fontSize: 12,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                }}
              >
                {previewOn ? "View raw" : "View preview"}
              </button>
            )}
            {panelMode.startsWith("files:") && (
              <IconButton title={treeVisible ? "Hide file tree" : "Show file tree"} onClick={toggleTreeVisible}>
                <FoldersIcon />
              </IconButton>
            )}
          </header>
          {panelMode === "launcher" && (
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                padding: "0 28px",
                gap: 10,
              }}
            >
              {mainStarted && <LauncherRow icon={<ChatPlusIcon />} label="Side chat" onClick={openSideChatTab} />}
              {inProject && (
                <LauncherRow icon={<FolderOutlineIcon size={15} />} label="Files" onClick={openFilesTab} />
              )}
              <LauncherRow icon={<TerminalIcon />} label="Terminal" onClick={openTerminalTab} />
              <LauncherRow icon={<GlobeIcon />} label="Browser" onClick={openBrowserTab} />
              {inProject && <LauncherRow icon={<ReviewIcon />} label="Review" onClick={openReviewTab} />}
            </div>
          )}
          {openFiles.map(
            (f) =>
              panelMode === `file:${f.id}` && (
                <FileViewer
                  key={f.id}
                  file={f.info}
                  onOpenFile={(p, l) => void openFileInPanel(p, l)}
                  onOpenLink={openInBrowser}
                  preview={previewOn}
                />
              ),
          )}
          {reviewOpen && panelMode === "review" && <ReviewPane gitPath={gitPath} />}
          {openAgents.map(
            (a) =>
              panelMode === `agent:${a.threadId}` && (
                <SubAgentPane
                  key={a.threadId}
                  threadId={a.threadId}
                  name={subAgentsList.find((x) => x.threadId === a.threadId)?.name ?? a.name}
                  status={subAgentsList.find((x) => x.threadId === a.threadId)?.status ?? "idle"}
                />
              ),
          )}
          {filesTabs.map((tabId) => {
            if (panelMode !== `files:${tabId}`) return null;
            const treeFile = treeFiles[tabId] ?? null;
            return (
            <div key={tabId} style={{ flex: 1, minHeight: 0, display: "flex" }}>
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: "flex",
                  flexDirection: "column",
                  borderRight: treeVisible ? `1px solid ${colors.border}` : "none",
                }}
              >
                {treeFile ? (
                  <FileViewer
                    file={treeFile}
                    onOpenFile={(p, l) => void openFileInTree(tabId, p, l)}
                    onOpenLink={openInBrowser}
                    preview={previewOn}
                  />
                ) : (
                  <div style={{ flex: 1, display: "grid", placeItems: "center" }}>
                    <div style={{ textAlign: "center", color: colors.dim }}>
                      <div style={{ display: "flex", justifyContent: "center", marginBottom: 10 }}>
                        <FolderOutlineIcon size={30} />
                      </div>
                      <p style={{ fontSize: 15, fontWeight: 500, margin: 0, color: colors.fg }}>Open file</p>
                      <p style={{ fontSize: 12.5, marginTop: 6 }}>Select a file from the workspace tree</p>
                    </div>
                  </div>
                )}
              </div>
              {treeVisible && (
                <div
                  style={{
                    width: "34%",
                    minWidth: 160,
                    maxWidth: 250,
                    flexShrink: 0,
                    display: "flex",
                    flexDirection: "column",
                  }}
                >
                  <FileTreePane onOpenFile={(p) => void openFileInTree(tabId, p)} />
                </div>
              )}
            </div>
            );
          })}
          {terminalTabs.map((id) => (
            <div
              key={id}
              style={{
                flex: 1,
                minHeight: 0,
                display: panelMode === `terminal:${id}` ? "flex" : "none",
                flexDirection: "column",
              }}
            >
              <TerminalPane />
            </div>
          ))}
          {agentMirrorOpen && (
            <div
              style={{
                flex: 1,
                minHeight: 0,
                display: panelMode === "agentmirror" ? "flex" : "none",
                flexDirection: "column",
              }}
            >
              {/* The conversation this pane belongs to. Each chat now drives
                  its own browser tab, so the mirror has to be told which one
                  to watch — otherwise it picks by URL and can show a different
                  chat browsing. */}
              <AgentMirrorPane
                active={panelMode === "agentmirror"}
                threadId={scheduledOpen ? (runningScheduledThread ?? activeThreadId) : activeThreadId}
              />
            </div>
          )}
          {browserTabs.map((id) => (
            <div
              key={id}
              style={{
                flex: 1,
                minHeight: 0,
                display: panelMode === `browser:${id}` ? "flex" : "none",
                flexDirection: "column",
              }}
            >
              <BrowserPane browserId={id} />
            </div>
          ))}
          {sideChats.map((id) => (
          <div
            key={id}
            style={{
              flex: 1,
              minHeight: 0,
              display: panelMode === id ? "flex" : "none",
              flexDirection: "column",
            }}
          >
          <ChatPane
            key={sideNonce}
            paneId={id}
            connected={connected}
            reset={{ entries: [], nonce: 0 }}
            contextChip={sideContexts[id] ?? null}
            onContextClear={() => setSideContexts((m) => ({ ...m, [id]: null }))}
            onPreviewImage={(a) => void openImagePreview(a)}
            onOpenLink={openInBrowser}
            accessMode={accessMode}
            onAccessModeChange={changeAccessMode}
            planMode={planMode}
            onTogglePlanMode={togglePlanMode}
            onOpenMcp={() => setMcpOpen(true)}
            onOpenConnectors={() => setConnectorsPanelOpen(true)}
            onOpenSkills={() => setSkillsOpen(true)}
            emptyState={
              <div style={{ textAlign: "center", padding: "0 24px" }}>
                {/* The mark sits in a soft well rather than floating — the
                    same move the connector cards make with their logos. A
                    bare 34px glyph in the middle of an empty pane read as
                    leftover chrome, not as a deliberate empty state. */}
                <div
                  style={{
                    width: 56,
                    height: 56,
                    margin: "0 auto 14px",
                    borderRadius: "50%",
                    background: "var(--panel-2)",
                    display: "grid",
                    placeItems: "center",
                    color: "var(--fg-soft)",
                  }}
                >
                  <ChatPlusIcon size={24} strokeWidth={1.5} />
                </div>
                <p
                  style={{
                    fontSize: 15.5,
                    fontWeight: 600,
                    letterSpacing: "var(--track-body)",
                    color: colors.fg,
                    margin: 0,
                  }}
                >
                  Side chat
                </p>
                {/* Capped measure: uncapped, this sentence ran the full pane
                    width as one ~100-character line — the one readability
                    cost the app's own --measure token exists to prevent. Two
                    sentences, two lines: what it IS, then how long it lives,
                    with the lifetime quieter because it is the caveat, not
                    the point. */}
                <p
                  style={{
                    color: colors.dim,
                    margin: "8px auto 0",
                    fontSize: 13.5,
                    lineHeight: 1.55,
                    letterSpacing: "var(--track-body)",
                    maxWidth: "38ch",
                  }}
                >
                  Shares this conversation’s context.
                </p>
                <p
                  style={{
                    color: colors.dim,
                    opacity: 0.75,
                    margin: "4px auto 0",
                    fontSize: 12.5,
                    lineHeight: 1.55,
                    letterSpacing: "var(--track-meta)",
                    maxWidth: "38ch",
                  }}
                >
                  Temporary — it resets when you switch conversations and
                  disappears when you close the app.
                </p>
              </div>
            }
          />
          </div>
          ))}
        </div>
      {branchSwitch && (
        <div
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setBranchSwitch(null);
              setBranchError(null);
            }
          }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)", backdropFilter: "var(--scrim-blur)", WebkitBackdropFilter: "var(--scrim-blur)",
            display: "grid",
            placeItems: "center",
            zIndex: 100,
          }}
        >
          <div
            style={{
              width: 520,
              maxWidth: "calc(100vw - 48px)",
              background: colors.panel,
              border: `1px solid ${colors.border}`,
              borderRadius: 16,
              padding: "22px 24px 20px",
              boxShadow: "0 16px 48px rgba(0,0,0,0.55)",
              position: "relative",
            }}
          >
            <button
              onClick={() => {
                setBranchSwitch(null);
                setBranchError(null);
              }}
              aria-label="Close"
              style={{
                position: "absolute",
                top: 16,
                right: 16,
                background: "transparent",
                border: "none",
                color: colors.dim,
                cursor: "pointer",
                padding: 4,
                display: "flex",
              }}
            >
              <CloseIcon />
            </button>
            <div style={{ fontSize: 18, fontWeight: 600, color: colors.fg }}>
              Commit changes to switch branch
            </div>
            <div style={{ color: colors.dim, fontSize: 14, lineHeight: 1.55, marginTop: 10 }}>
              Your changes to the following files would be overwritten by checkout:
            </div>
            <div
              style={{
                maxHeight: 170,
                overflowY: "auto",
                margin: "12px 0",
                fontFamily: "var(--font-code)",
                fontSize: 12.5,
              }}
            >
              {branchSwitch.files.map((f) => (
                <div key={f.file} style={{ display: "flex", gap: 10, padding: "3px 0", color: colors.fg }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {f.file}
                  </span>
                  <span style={{ color: colors.ok, flexShrink: 0 }}>+{f.plus}</span>
                  <span style={{ color: colors.err, flexShrink: 0 }}>-{f.minus}</span>
                </div>
              ))}
            </div>
            <div style={{ color: colors.dim, fontSize: 13.5 }}>
              Commit or discard your changes to continue.
            </div>
            {branchError && (
              <div style={{ color: colors.err, fontSize: 13, marginTop: 8 }}>{branchError}</div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 20 }}>
              <button
                onClick={() => {
                  setBranchSwitch(null);
                  setBranchError(null);
                }}
                style={{
                  background: "var(--chip)",
                  border: "none",
                  borderRadius: 999,
                  color: colors.fg,
                  fontSize: 14,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  padding: "9px 18px",
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => void discardAndSwitch()}
                disabled={branchBusy}
                style={{
                  background: "rgba(240, 149, 149, 0.14)",
                  border: "none",
                  borderRadius: 999,
                  color: colors.err,
                  fontSize: 14,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  padding: "9px 18px",
                }}
              >
                Discard changes
              </button>
              <button
                onClick={() => void commitAndSwitch()}
                disabled={branchBusy}
                style={{
                  background: colors.fg,
                  border: "none",
                  borderRadius: 999,
                  color: "var(--bg)",
                  fontSize: 14,
                  fontWeight: 500,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  padding: "9px 18px",
                }}
              >
                Commit and switch branch…
              </button>
            </div>
          </div>
        </div>
      )}
      {branchCreate && (
        <div
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setBranchCreate(false);
              setBranchError(null);
            }
          }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)", backdropFilter: "var(--scrim-blur)", WebkitBackdropFilter: "var(--scrim-blur)",
            display: "grid",
            placeItems: "center",
            zIndex: 100,
          }}
        >
          <div
            style={{
              width: 480,
              maxWidth: "calc(100vw - 48px)",
              background: colors.panel,
              border: `1px solid ${colors.border}`,
              borderRadius: 16,
              padding: "22px 24px 20px",
              boxShadow: "0 16px 48px rgba(0,0,0,0.55)",
              position: "relative",
            }}
          >
            <button
              onClick={() => {
                setBranchCreate(false);
                setBranchError(null);
              }}
              aria-label="Close"
              style={{
                position: "absolute",
                top: 16,
                right: 16,
                background: "transparent",
                border: "none",
                color: colors.dim,
                cursor: "pointer",
                padding: 4,
                display: "flex",
              }}
            >
              <CloseIcon />
            </button>
            <div style={{ fontSize: 18, fontWeight: 600, color: colors.fg }}>Create and checkout branch</div>
            <div style={{ color: colors.dim, fontSize: 13.5, margin: "16px 0 8px" }}>Branch name</div>
            <input
              autoFocus
              value={branchName}
              onChange={(e) => {
                setBranchName(e.target.value);
                setBranchError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && branchName.trim() && !branchNameError(branchName)) {
                  void doCheckout(branchName.trim(), true);
                }
              }}
              spellCheck={false}
              style={{
                width: "100%",
                boxSizing: "border-box",
                background: "var(--panel-2)",
                border: `1px solid ${colors.border}`,
                borderRadius: 10,
                padding: "10px 12px",
                color: colors.fg,
                fontSize: 14,
                outline: "none",
                fontFamily: "var(--font-code)",
              }}
            />
            {(branchNameError(branchName) || branchError) && (
              <div style={{ color: colors.err, fontSize: 13, marginTop: 8 }}>
                {branchNameError(branchName) ?? branchError}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 20 }}>
              <button
                onClick={() => {
                  setBranchCreate(false);
                  setBranchError(null);
                }}
                style={{
                  background: "var(--chip)",
                  border: "none",
                  borderRadius: 999,
                  color: colors.fg,
                  fontSize: 14,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  padding: "9px 18px",
                }}
              >
                Close
              </button>
              <button
                onClick={() => void doCheckout(branchName.trim(), true)}
                disabled={branchBusy || !branchName.trim() || !!branchNameError(branchName)}
                style={{
                  background:
                    branchName.trim() && !branchNameError(branchName) ? colors.fg : "var(--panel-2)",
                  border: "none",
                  borderRadius: 999,
                  color: branchName.trim() && !branchNameError(branchName) ? "var(--bg)" : colors.dim,
                  fontSize: 14,
                  fontWeight: 500,
                  cursor: branchName.trim() && !branchNameError(branchName) ? "pointer" : "default",
                  fontFamily: "inherit",
                  padding: "9px 18px",
                }}
              >
                Create and checkout
              </button>
            </div>
          </div>
        </div>
      )}
      {fullAccessPrompt && (
        <div
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setFullAccessPrompt(false);
          }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)", backdropFilter: "var(--scrim-blur)", WebkitBackdropFilter: "var(--scrim-blur)",
            display: "grid",
            placeItems: "center",
            zIndex: 100,
          }}
        >
          <div
            style={{
              width: 560,
              maxWidth: "calc(100vw - 48px)",
              background: colors.panel,
              border: `1px solid ${colors.border}`,
              borderRadius: 18,
              padding: "24px 26px 22px",
              boxShadow: "0 16px 48px rgba(0,0,0,0.55)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 19, fontWeight: 600, color: colors.fg, letterSpacing: "var(--track-title)" }}>
              <span style={{ color: colors.amber, display: "flex" }}>
                <ShieldAlertIcon />
              </span>
              Turn on Full Access?
            </div>
            <div style={{ color: colors.dim, fontSize: 14, lineHeight: 1.55, marginTop: 12 }}>
              Pareto will be able to run commands, use the internet, and create and edit files
              anywhere on this computer without your permission. This includes but is not limited to:
            </div>
            <div
              style={{
                background: "var(--panel-2)",
                borderRadius: 14,
                padding: "4px 16px",
                marginTop: 16,
              }}
            >
              {[
                {
                  icon: <FolderOutlineIcon size={17} />,
                  title: "Files and folders",
                  desc: "Read, create, modify, or delete files anywhere on this computer",
                },
                {
                  icon: <TerminalIcon size={17} />,
                  title: "Terminal commands",
                  desc: "Run commands, install software, and change system settings",
                },
                {
                  icon: <GlobeIcon size={17} />,
                  title: "Internet access",
                  desc: "Access websites and send data",
                },
              ].map((row, i) => (
                <div
                  key={row.title}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 14,
                    padding: "13px 0",
                    borderTop: i > 0 ? `1px solid ${colors.border}` : "none",
                  }}
                >
                  <span style={{ color: colors.fg, display: "flex", marginTop: 2, flexShrink: 0 }}>{row.icon}</span>
                  <span style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14.5, fontWeight: 600, color: colors.fg }}>{row.title}</div>
                    <div style={{ fontSize: 13.5, color: colors.dim, marginTop: 2, lineHeight: 1.45 }}>{row.desc}</div>
                  </span>
                </div>
              ))}
            </div>
            <div style={{ color: colors.dim, fontSize: 13.5, lineHeight: 1.5, marginTop: 16 }}>
              This comes with risks like loss or exposure of sensitive data and prompt injection.
              You can turn this off at any time.
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 20 }}>
              <button
                onClick={() => setFullAccessPrompt(false)}
                style={{
                  background: "var(--chip)",
                  border: "none",
                  borderRadius: 999,
                  color: colors.fg,
                  fontSize: 14.5,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  padding: "10px 20px",
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setFullAccessPrompt(false);
                  applyAccessMode("full");
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  background: "rgba(240, 149, 149, 0.14)",
                  border: "none",
                  borderRadius: 999,
                  color: colors.err,
                  fontSize: 14.5,
                  fontWeight: 500,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  padding: "10px 20px",
                }}
              >
                <ShieldAlertIcon />
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
      {threadMenu && (
        <div
          data-threadmenu
          style={{
            position: "fixed",
            top: threadMenu.y,
            left: Math.max(8, Math.min(threadMenu.x - 210, window.innerWidth - 226)),
            width: 210,
            background: colors.panel,
            border: `1px solid ${colors.border}`,
            borderRadius: 12,
            padding: 6,
            zIndex: 60,
            boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
          }}
        >
          <MenuItem
            icon={<PencilIcon />}
            label="Rename…"
            onClick={() => {
              setRenameDialog({ id: threadMenu.id, name: threadMenu.title, error: null });
              setThreadMenu(null);
            }}
          />
          {!threadMenu.inProject && (
            <MenuItem
              icon={<FolderOutlineIcon size={15} />}
              label="Move to project…"
              disabled={sidebar.projects.length === 0}
              desc={sidebar.projects.length === 0 ? "No projects yet" : undefined}
              onClick={() => {
                setMoveDialog({ id: threadMenu.id, title: threadMenu.title });
                setThreadMenu(null);
              }}
            />
          )}
          <MenuItem
            icon={<TrashIcon />}
            label="Delete"
            onClick={() => {
              const id = threadMenu.id;
              setThreadMenu(null);
              void deleteThread(id);
            }}
          />
        </div>
      )}
      {editProj && (
        <div
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setEditProj(null);
          }}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", backdropFilter: "var(--scrim-blur)", WebkitBackdropFilter: "var(--scrim-blur)", display: "grid", placeItems: "center", zIndex: 100 }}
        >
          <div
            style={{
              width: 560,
              maxWidth: "calc(100vw - 48px)",
              background: colors.panel,
              border: `1px solid ${colors.border}`,
              borderRadius: 16,
              padding: "22px 24px 20px",
              boxShadow: "0 16px 48px rgba(0,0,0,0.55)",
              position: "relative",
            }}
          >
            <button
              onClick={() => setEditProj(null)}
              aria-label="Close"
              style={{ position: "absolute", top: 16, right: 16, background: "transparent", border: "none", color: colors.dim, cursor: "pointer", padding: 4, display: "flex" }}
            >
              <CloseIcon />
            </button>
            <div style={{ fontSize: 18, fontWeight: 600, color: colors.fg }}>
              {editProj.mode === "create" ? "Create project" : "Edit project"}
            </div>
            {/* Name row: icon button (opens the identity picker) + name input */}
            <div
              style={{
                display: "flex",
                alignItems: "stretch",
                marginTop: 16,
                border: `1px solid ${colors.border}`,
                borderRadius: 12,
                background: "var(--panel-2)",
                overflow: "visible",
                position: "relative",
              }}
            >
              <button
                onClick={() => setEditProj({ ...editProj, pickerOpen: !editProj.pickerOpen })}
                title="Change icon and color"
                aria-expanded={editProj.pickerOpen}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 52,
                  background: "var(--chip)",
                  border: "none",
                  borderRight: `1px solid ${colors.border}`,
                  borderRadius: "12px 0 0 12px",
                  cursor: "pointer",
                  color: colors.fg,
                }}
              >
                <ProjectIcon icon={editProj.icon} color={editProj.color} size={18} />
              </button>
              <input
                autoFocus={editProj.mode === "create"}
                value={editProj.name}
                onChange={(e) => setEditProj({ ...editProj, name: e.target.value, error: null })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && editProj.name.trim()) void doSaveProject();
                }}
                placeholder="Project name"
                spellCheck={false}
                style={{
                  flex: 1,
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  color: colors.fg,
                  fontSize: 15,
                  padding: "12px 14px",
                  fontFamily: "inherit",
                }}
              />
              {editProj.pickerOpen && (
                <div
                  style={{
                    position: "absolute",
                    top: "calc(100% + 8px)",
                    left: 0,
                    width: 300,
                    background: colors.panel,
                    border: `1px solid ${colors.border}`,
                    borderRadius: 14,
                    padding: 14,
                    zIndex: 40,
                    boxShadow: "0 12px 32px rgba(0,0,0,0.55)",
                  }}
                >
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10, paddingBottom: 12, borderBottom: `1px solid ${colors.border}` }}>
                    {PROJECT_COLORS.map((c, i) => {
                      const value = i === 0 ? null : c; // first swatch = default
                      const selected = editProj.color === value;
                      return (
                        <button
                          key={c}
                          onClick={() => setEditProj({ ...editProj, color: value })}
                          aria-label={`Color ${i + 1}`}
                          style={{
                            width: 26,
                            height: 26,
                            borderRadius: "50%",
                            background: c,
                            border: selected ? `2px solid ${colors.fg}` : "2px solid transparent",
                            outline: selected ? `2px solid ${colors.bg}` : "none",
                            outlineOffset: -4,
                            cursor: "pointer",
                            padding: 0,
                          }}
                        />
                      );
                    })}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 6, paddingTop: 12 }}>
                    {Object.keys(PROJECT_ICON_PATHS).map((key) => (
                      <button
                        key={key}
                        onClick={() => setEditProj({ ...editProj, icon: key })}
                        aria-label={key}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          padding: 7,
                          background: editProj.icon === key ? "var(--chip)" : "transparent",
                          border: "none",
                          borderRadius: 8,
                          color: colors.fg,
                          cursor: "pointer",
                        }}
                      >
                        <ProjectIcon icon={key} color={editProj.color} size={17} />
                      </button>
                    ))}
                  </div>
                  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                    <button
                      onClick={() => setEditProj({ ...editProj, pickerOpen: false })}
                      style={{ background: "var(--chip)", border: "none", borderRadius: 10, color: colors.fg, fontSize: 13, cursor: "pointer", fontFamily: "inherit", padding: "7px 16px" }}
                    >
                      Done
                    </button>
                  </div>
                </div>
              )}
            </div>
            <div style={{ color: colors.fg, fontSize: 14.5, fontWeight: 500, margin: "18px 0 8px" }}>Source folders</div>
            <div style={{ border: `1px solid ${colors.border}`, borderRadius: 12 }}>
              {editProj.folders.map((f, i) => (
                <div
                  key={f}
                  title={f}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "11px 14px",
                    borderTop: i > 0 ? `1px solid ${colors.border}` : "none",
                  }}
                >
                  <FolderOutlineIcon size={15} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: colors.fg, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {f.split("/").filter(Boolean).pop()}
                  </span>
                  {f === editProj.primary ? (
                    <span style={{ color: colors.dim, fontSize: 12, border: `1px solid ${colors.border}`, borderRadius: 999, padding: "2px 10px", flexShrink: 0 }}>
                      Primary
                    </span>
                  ) : (
                    <button
                      onClick={() => setEditProj({ ...editProj, primary: f })}
                      style={{ background: "transparent", border: "none", color: colors.dim, fontSize: 12, cursor: "pointer", fontFamily: "inherit", padding: "2px 6px", flexShrink: 0 }}
                    >
                      Make primary
                    </button>
                  )}
                  <button
                    onClick={() => {
                      // An existing project keeps at least one folder; a new
                      // one may go back to empty (fresh folder on create).
                      const locked = editProj.mode === "edit" && editProj.folders.length === 1;
                      if (locked) return;
                      const folders = editProj.folders.filter((x) => x !== f);
                      setEditProj({
                        ...editProj,
                        folders,
                        primary: editProj.primary === f ? (folders[0] ?? "") : editProj.primary,
                      });
                    }}
                    aria-label={`Remove ${f}`}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: editProj.mode === "edit" && editProj.folders.length === 1 ? "var(--gutter)" : colors.dim,
                      cursor: editProj.mode === "edit" && editProj.folders.length === 1 ? "default" : "pointer",
                      padding: 2,
                      display: "flex",
                      flexShrink: 0,
                    }}
                  >
                    <CloseIcon />
                  </button>
                </div>
              ))}
              {editProj.mode === "create" && editProj.folders.length === 0 && (
                <div style={{ padding: "11px 14px", fontSize: 12.5, color: colors.dim }}>
                  No folders yet — a new folder named after the project is created in your home directory.
                </div>
              )}
              <button
                onClick={() =>
                  void window.unbiased.pickProjectLocation().then((r) => {
                    if (r.path && !editProj.folders.includes(r.path)) {
                      setEditProj((e) =>
                        e
                          ? { ...e, folders: [...e.folders, r.path!], primary: e.primary || r.path! }
                          : e,
                      );
                    }
                  })
                }
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  background: "transparent",
                  border: "none",
                  borderTop: `1px solid ${colors.border}`,
                  padding: "11px 14px",
                  fontSize: 13.5,
                  color: colors.fg,
                  cursor: "pointer",
                  textAlign: "left",
                  fontFamily: "inherit",
                }}
              >
                <FolderPlusIcon />
                Add folder
              </button>
            </div>
            {editProj.error && <div style={{ color: colors.err, fontSize: 13, marginTop: 10 }}>{editProj.error}</div>}
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 20 }}>
              {editProj.mode === "edit" && (
                <button
                  onClick={() => {
                    const path = editProj.path;
                    const name = editProj.name;
                    setEditProj(null);
                    setConfirmDialog({ kind: "remove", path, name, count: 0 });
                  }}
                  style={{ background: "rgba(240, 149, 149, 0.14)", border: "none", borderRadius: 10, color: colors.err, fontSize: 13.5, cursor: "pointer", fontFamily: "inherit", padding: "9px 16px" }}
                >
                  Remove local project
                </button>
              )}
              <span style={{ flex: 1 }} />
              <button
                onClick={() => setEditProj(null)}
                style={{ background: "transparent", border: "none", color: colors.dim, fontSize: 14, cursor: "pointer", fontFamily: "inherit", padding: "9px 14px" }}
              >
                Cancel
              </button>
              <button
                onClick={() => void doSaveProject()}
                disabled={!editProj.name.trim()}
                style={{
                  background: editProj.name.trim() ? colors.fg : "var(--panel-2)",
                  border: "none",
                  borderRadius: 999,
                  color: editProj.name.trim() ? "var(--bg)" : colors.dim,
                  fontSize: 14,
                  fontWeight: 500,
                  cursor: editProj.name.trim() ? "pointer" : "default",
                  fontFamily: "inherit",
                  padding: "9px 20px",
                }}
              >
                {editProj.mode === "create" ? "Create project" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
      {mcpOpen && <McpPanel onClose={() => setMcpOpen(false)} />}
      {connectorsPanelOpen && (
        <ConnectorsPanel
          onClose={() => setConnectorsPanelOpen(false)}
          onOpenFull={() => {
            setScheduledOpen(false);
            setConnectorsOpen(true);
          }}
        />
      )}
      {skillsOpen && (
        <SkillsPanel cwd={activeProjectPath ?? null} onClose={() => setSkillsOpen(false)} />
      )}
      {showChangelog && (
        <ChangelogModal releases={releases} onClose={() => setShowChangelog(false)} />
      )}
      {renameDialog && (
        <div
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setRenameDialog(null);
          }}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", backdropFilter: "var(--scrim-blur)", WebkitBackdropFilter: "var(--scrim-blur)", display: "grid", placeItems: "center", zIndex: 100 }}
        >
          <div
            style={{
              width: 440,
              maxWidth: "calc(100vw - 48px)",
              background: colors.panel,
              border: `1px solid ${colors.border}`,
              borderRadius: 16,
              padding: "22px 24px 20px",
              boxShadow: "0 16px 48px rgba(0,0,0,0.55)",
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 600, color: colors.fg }}>Rename conversation</div>
            <input
              autoFocus
              value={renameDialog.name}
              onChange={(e) => setRenameDialog({ ...renameDialog, name: e.target.value, error: null })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && renameDialog.name.trim()) void doRenameThread();
              }}
              spellCheck={false}
              style={{
                width: "100%",
                boxSizing: "border-box",
                background: "var(--panel-2)",
                border: `1px solid ${colors.border}`,
                borderRadius: 10,
                padding: "10px 12px",
                color: colors.fg,
                fontSize: 14,
                outline: "none",
                fontFamily: "inherit",
                marginTop: 16,
              }}
            />
            {renameDialog.error && <div style={{ color: colors.err, fontSize: 13, marginTop: 8 }}>{renameDialog.error}</div>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 20 }}>
              <button
                onClick={() => setRenameDialog(null)}
                style={{ background: "var(--chip)", border: "none", borderRadius: 999, color: colors.fg, fontSize: 14, cursor: "pointer", fontFamily: "inherit", padding: "9px 18px" }}
              >
                Cancel
              </button>
              <button
                onClick={() => void doRenameThread()}
                disabled={!renameDialog.name.trim()}
                style={{
                  background: renameDialog.name.trim() ? colors.fg : "var(--panel-2)",
                  border: "none",
                  borderRadius: 999,
                  color: renameDialog.name.trim() ? "var(--bg)" : colors.dim,
                  fontSize: 14,
                  fontWeight: 500,
                  cursor: renameDialog.name.trim() ? "pointer" : "default",
                  fontFamily: "inherit",
                  padding: "9px 18px",
                }}
              >
                Rename
              </button>
            </div>
          </div>
        </div>
      )}
      {moveDialog && (
        <div
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setMoveDialog(null);
          }}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", backdropFilter: "var(--scrim-blur)", WebkitBackdropFilter: "var(--scrim-blur)", display: "grid", placeItems: "center", zIndex: 100 }}
        >
          <div
            style={{
              width: 440,
              maxWidth: "calc(100vw - 48px)",
              background: colors.panel,
              border: `1px solid ${colors.border}`,
              borderRadius: 16,
              padding: "22px 24px 20px",
              boxShadow: "0 16px 48px rgba(0,0,0,0.55)",
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 600, color: colors.fg }}>Move to project</div>
            <div style={{ color: colors.dim, fontSize: 13.5, marginTop: 8, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {moveDialog.title}
            </div>
            <div style={{ maxHeight: 260, overflowY: "auto", marginTop: 12 }}>
              {sidebar.projects.map((pr) => (
                <button
                  key={pr.path}
                  onClick={() => void doMoveThread(pr.path)}
                  title={pr.path}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    width: "100%",
                    background: "transparent",
                    border: "none",
                    borderRadius: 10,
                    padding: "9px 10px",
                    fontSize: 14,
                    color: colors.fg,
                    cursor: "pointer",
                    textAlign: "left",
                    fontFamily: "inherit",
                  }}
                >
                  <FolderIcon />
                  <span style={{ minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{pr.name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {confirmDialog && (
        <div
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setConfirmDialog(null);
          }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)", backdropFilter: "var(--scrim-blur)", WebkitBackdropFilter: "var(--scrim-blur)",
            display: "grid",
            placeItems: "center",
            zIndex: 100,
          }}
        >
          <div
            style={{
              width: 480,
              maxWidth: "calc(100vw - 48px)",
              background: colors.panel,
              border: `1px solid ${colors.border}`,
              borderRadius: 16,
              padding: "22px 24px 20px",
              boxShadow: "0 16px 48px rgba(0,0,0,0.55)",
              position: "relative",
            }}
          >
            <button
              onClick={() => setConfirmDialog(null)}
              aria-label="Close"
              style={{
                position: "absolute",
                top: 16,
                right: 16,
                background: "transparent",
                border: "none",
                color: colors.dim,
                cursor: "pointer",
                padding: 4,
                display: "flex",
              }}
            >
              <CloseIcon />
            </button>
            <div style={{ fontSize: 18, fontWeight: 600, color: colors.fg }}>
              {confirmDialog.kind === "archive"
                ? `Archive ${confirmDialog.count} chat${confirmDialog.count === 1 ? "" : "s"}?`
                : `Remove ${confirmDialog.name}?`}
            </div>
            <div style={{ color: colors.dim, fontSize: 14, lineHeight: 1.55, marginTop: 10 }}>
              {confirmDialog.kind === "archive"
                ? `This will archive the chats in ${confirmDialog.name}. You can find them later in your archived chats.`
                : "This removes the project from the app. Files on your computer and existing chats won't be deleted."}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 22 }}>
              <button
                onClick={() => setConfirmDialog(null)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: colors.dim,
                  fontSize: 14.5,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  padding: "9px 14px",
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => void runConfirmedAction()}
                style={{
                  background: "rgba(240, 149, 149, 0.14)",
                  border: "none",
                  borderRadius: 10,
                  color: colors.err,
                  fontSize: 14.5,
                  fontWeight: 500,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  padding: "9px 18px",
                }}
              >
                {confirmDialog.kind === "archive" ? "Archive all" : "Remove project"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const EXT_TO_PRISM: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  py: "python",
  go: "go",
  rs: "rust",
  toml: "toml",
  yml: "yaml",
  yaml: "yaml",
  css: "css",
  html: "markup",
  md: "markdown",
  sql: "sql",
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Lazy directory tree. Reused by the Files pane and the breadcrumb
 *  dropdown; `initialExpanded` pre-opens a path (the crumb's directory). */
function DirTree({
  root,
  filter = "",
  initialExpanded,
  onOpenFile,
}: {
  root: string;
  filter?: string;
  initialExpanded?: string[];
  onOpenFile: (path: string) => void;
}) {
  const [children, setChildren] = useState<Map<string, DirEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    void (async () => {
      const map = new Map<string, DirEntry[]>();
      map.set(root, (await window.unbiased.listDir(root)).entries);
      for (const p of initialExpanded ?? []) {
        map.set(p, (await window.unbiased.listDir(p)).entries);
      }
      if (alive) {
        setChildren(map);
        setExpanded(new Set(initialExpanded ?? []));
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  async function toggleDir(path: string) {
    const opening = !expanded.has(path);
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    if (opening && !children.has(path)) {
      const res = await window.unbiased.listDir(path);
      setChildren((m) => new Map(m).set(path, res.entries));
    }
  }

  // Vertical padding lives on the label, not the row, so the indent guides
  // (alignSelf: stretch) meet between rows and read as continuous lines.
  const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    background: "transparent",
    border: "none",
    borderRadius: 6,
    padding: "0 10px",
    fontSize: 13,
    color: colors.fg,
    cursor: "pointer",
    textAlign: "left",
    fontFamily: "inherit",
  };
  const nameStyle: React.CSSProperties = {
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    padding: "5px 0",
  };
  // One 8px-wide unit per ancestor level (plus the 8px flex gap = 16px per
  // depth step), each drawing the Codex-style guide line on its left edge.
  const guides = (depth: number) =>
    Array.from({ length: depth }, (_, i) => (
      <span
        key={`g${i}`}
        style={{
          width: 8,
          alignSelf: "stretch",
          flexShrink: 0,
          borderLeft: `1px solid ${colors.border}`,
        }}
      />
    ));

  const f = filter.trim().toLowerCase();

  function rows(dirPath: string, depth: number): React.ReactNode[] {
    const out: React.ReactNode[] = [];
    for (const e of children.get(dirPath) ?? []) {
      const full = `${dirPath}/${e.name}`;
      if (e.dir) {
        const open = expanded.has(full);
        out.push(
          <button key={full} onClick={() => void toggleDir(full)} style={rowStyle} data-nopress>
            {guides(depth)}
            <span
              style={{
                color: colors.dim,
                fontSize: 12,
                display: "inline-block",
                width: 10,
                flexShrink: 0,
                transform: open ? "rotate(90deg)" : "none",
                transition: "transform 120ms var(--ease-out)",
              }}
            >
              ›
            </span>
            <span style={nameStyle}>{e.name}</span>
          </button>,
        );
        if (open) out.push(...rows(full, depth + 1));
      } else if (!f || e.name.toLowerCase().includes(f)) {
        const ext = e.name.includes(".") ? (e.name.split(".").pop() ?? "") : "";
        out.push(
          <button key={full} onClick={() => onOpenFile(full)} style={rowStyle} data-nopress>
            {guides(depth)}
            <span
              style={{
                fontSize: 8.5,
                fontWeight: 600,
                background: "var(--chip)",
                color: colors.dim,
                borderRadius: 4,
                padding: "2px 3px",
                minWidth: 16,
                textAlign: "center",
                flexShrink: 0,
                fontFamily: "var(--font-code)",
                textTransform: "uppercase",
              }}
            >
              {ext.slice(0, 4) || "·"}
            </span>
            <span style={nameStyle}>{e.name}</span>
          </button>,
        );
      }
    }
    return out;
  }

  return <>{rows(root, 0)}</>;
}

/** Codex-style workspace tree pane: name filter above a DirTree rooted at
 *  the active conversation's cwd. */
function FileTreePane({ onOpenFile }: { onOpenFile: (path: string) => void }) {
  const [root, setRoot] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    void window.unbiased.listDir().then((res) => setRoot(res.dir));
  }, []);

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "10px 12px", borderBottom: `1px solid ${colors.border}`, flexShrink: 0 }}>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter files…"
          spellCheck={false}
          style={{
            width: "100%",
            boxSizing: "border-box",
            background: "var(--panel-2)",
            border: `1px solid ${colors.border}`,
            borderRadius: 8,
            padding: "6px 10px",
            color: colors.fg,
            fontSize: 12.5,
            outline: "none",
            fontFamily: "inherit",
          }}
        />
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "6px 6px 12px" }}>
        {root === null ? (
          <div style={{ color: colors.dim, fontSize: 12.5, padding: "8px 10px" }}>Loading…</div>
        ) : (
          <DirTree root={root} filter={filter} onOpenFile={onOpenFile} />
        )}
      </div>
    </div>
  );
}

const TAG_LABELS: Record<string, string> = {
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  code: "code",
  pre: "code",
  p: "paragraph",
  a: "link",
  img: "image",
  li: "list item",
  blockquote: "quote",
  td: "table cell",
  th: "table cell",
};

/** A sent message's annotations, Codex-style: page thumbnails (browser
 *  annotations) plus a pill that expands into kind + excerpt + comment. */
function SentAnnotations({ items }: { items: SentAnnotation[] }) {
  const [open, setOpen] = useState(false);
  const thumbs = items.filter((a) => a.thumb);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8, position: "relative" }}>
      {thumbs.length > 0 && (
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
          {thumbs.map((a, i) => (
            <img
              key={i}
              src={a.thumb}
              alt={a.comment || "annotated page"}
              title={a.comment || a.text.split("\n")[0]}
              style={{
                width: 132,
                height: 132,
                objectFit: "cover",
                objectPosition: "top left",
                borderRadius: 12,
                border: `1px solid ${colors.border}`,
                background: "var(--code-bg)",
              }}
            />
          ))}
        </div>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "var(--chip)",
          border: `1px solid ${colors.border}`,
          borderRadius: 999,
          padding: "8px 14px",
          fontSize: 13.5,
          color: colors.fg,
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        <AnnotationIcon />
        {items.length} annotation{items.length === 1 ? "" : "s"}
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            bottom: "calc(100% + 8px)",
            right: 0,
            width: 340,
            maxHeight: 320,
            overflowY: "auto",
            background: colors.panel,
            border: `1px solid ${colors.border}`,
            borderRadius: 14,
            boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
            zIndex: 15,
          }}
        >
          {items.map((a, i) => (
            <div key={i} style={{ padding: "10px 14px", borderTop: i > 0 ? `1px solid ${colors.border}` : "none" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <span
                  style={{
                    fontSize: 11,
                    color: colors.dim,
                    background: "var(--chip)",
                    border: `1px solid ${colors.border}`,
                    borderRadius: 6,
                    padding: "1px 7px",
                    flexShrink: 0,
                  }}
                >
                  {TAG_LABELS[a.tag ?? ""] ?? a.tag ?? "selection"}
                </span>
                <span
                  style={{
                    color: colors.dim,
                    fontSize: 13,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {a.text.split("\n")[0]}
                </span>
              </div>
              {a.comment && <div style={{ color: colors.fg, fontSize: 14, marginTop: 6 }}>{a.comment}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// The review tree: nested dirs (single-child chains compressed) + files.
type ReviewTreeNode = { name: string; children: ReviewTreeNode[]; file?: ReviewFile };

function buildReviewTree(files: ReviewFile[]): ReviewTreeNode[] {
  const root: ReviewTreeNode = { name: "", children: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let child = node.children.find((c) => c.name === parts[i] && !c.file);
      if (!child) {
        child = { name: parts[i], children: [] };
        node.children.push(child);
      }
      node = child;
    }
    node.children.push({ name: parts[parts.length - 1], children: [], file: f });
  }
  // Compress single-child directory chains: a/b/c → "a/b/c".
  function compress(n: ReviewTreeNode): ReviewTreeNode {
    while (!n.file && n.children.length === 1 && !n.children[0].file) {
      n = { name: `${n.name}/${n.children[0].name}`, children: n.children[0].children };
    }
    return { ...n, children: n.children.map(compress) };
  }
  return root.children.map(compress);
}

/** Codex-style Review pane: mode selector, +/- totals, commit/push/PR
 *  actions, a unified diff with unmodified-gap separators, and a
 *  changed-files tree that scrolls to each file's section. */
function ReviewPane({ gitPath }: { gitPath: string | null }) {
  const [mode, setMode] = useState<"branch" | "working">("branch");
  const [modeMenu, setModeMenu] = useState(false);
  const [pushMenu, setPushMenu] = useState(false);
  const [data, setData] = useState<ReviewData | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  // Files whose diff is folded away — reviewed ones collapse so the next
  // file's header lands at the top.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const fileRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  function toggleCollapsed(path: string) {
    setCollapsed((prev) => {
      const s = new Set(prev);
      if (s.has(path)) s.delete(path);
      else s.add(path);
      return s;
    });
  }
  const menusRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!gitPath) return;
    let alive = true;
    setLoading(true);
    void window.unbiased.reviewDiff(gitPath, mode).then((d) => {
      if (!alive) return;
      setData(d);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [gitPath, mode]);

  useEffect(() => {
    if (!modeMenu && !pushMenu) return;
    function onDown(e: MouseEvent) {
      if (!menusRef.current?.contains(e.target as Node)) {
        setModeMenu(false);
        setPushMenu(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setModeMenu(false);
        setPushMenu(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [modeMenu, pushMenu]);

  async function commitPush() {
    if (!gitPath) return;
    setBusy(true);
    setActionMsg(null);
    const r = await window.unbiased.reviewCommitPush(gitPath);
    setBusy(false);
    setActionMsg(r.ok ? "Committed and pushed." : (r.error ?? "Failed"));
    if (r.ok) {
      const d = await window.unbiased.reviewDiff(gitPath, mode);
      setData(d);
    }
  }

  async function createPr() {
    if (!gitPath) return;
    setBusy(true);
    setActionMsg(null);
    const r = await window.unbiased.reviewCreatePr(gitPath);
    setBusy(false);
    if (!r.ok) setActionMsg(r.error ?? "Failed to create PR");
  }

  const grammarFor = (path: string) => {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    const lang = EXT_TO_PRISM[ext];
    return lang ? { grammar: Prism.languages[lang], lang } : null;
  };

  const renderTree = (nodes: ReviewTreeNode[], depth: number): React.ReactNode =>
    nodes.map((n) =>
      n.file ? (
        <button
          key={n.file.path}
          onClick={() => {
            // Jumping to a file implies reviewing it — unfold if collapsed.
            setCollapsed((prev) => {
              if (!prev.has(n.file!.path)) return prev;
              const s = new Set(prev);
              s.delete(n.file!.path);
              return s;
            });
            fileRefs.current.get(n.file!.path)?.scrollIntoView({ block: "start" });
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            background: "transparent",
            border: "none",
            borderRadius: 6,
            padding: `5px 10px 5px ${10 + depth * 14}px`,
            fontSize: 13,
            color: colors.fg,
            cursor: "pointer",
            textAlign: "left",
            fontFamily: "inherit",
          }}
        >
          <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {n.name}
          </span>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 2,
              border: "1.5px solid #FF8A50",
              flexShrink: 0,
            }}
          />
        </button>
      ) : (
        <div key={`${depth}-${n.name}`}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: `5px 10px 5px ${10 + depth * 14}px`,
              fontSize: 13,
              color: "var(--fg-soft)",
            }}
          >
            <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {n.name}
            </span>
            <span style={{ width: 6, height: 6, borderRadius: 3, background: "#FF8A50", flexShrink: 0 }} />
          </div>
          {renderTree(n.children, depth + 1)}
        </div>
      ),
    );

  const tree = data ? buildReviewTree(data.files) : [];

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div
        ref={menusRef}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "8px 14px",
          flexShrink: 0,
        }}
      >
        <span style={{ position: "relative", display: "flex" }}>
          <button
            onClick={() => setModeMenu((o) => !o)}
            aria-expanded={modeMenu}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              background: "transparent",
              border: "none",
              color: colors.fg,
              fontSize: 14,
              fontWeight: 500,
              cursor: "pointer",
              fontFamily: "inherit",
              padding: "4px 0",
            }}
          >
            {mode === "branch" ? "Branch" : "Working Tree"}
            <span style={{ fontSize: 10, color: colors.dim }}>▾</span>
          </button>
          {modeMenu && (
            <div
              style={{
                position: "absolute",
                top: "calc(100% + 6px)",
                left: 0,
                minWidth: 180,
                background: colors.panel,
                border: `1px solid ${colors.border}`,
                borderRadius: 12,
                padding: 6,
                zIndex: 30,
                boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
              }}
            >
              {(
                [
                  { id: "branch", label: "Branch" },
                  { id: "working", label: "Working Tree" },
                ] as { id: "branch" | "working"; label: string }[]
              ).map((m) => (
                <button
                  key={m.id}
                  onClick={() => {
                    setMode(m.id);
                    setModeMenu(false);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    width: "100%",
                    background: "transparent",
                    border: "none",
                    borderRadius: 8,
                    padding: "8px 10px",
                    fontSize: 13.5,
                    color: colors.fg,
                    cursor: "pointer",
                    textAlign: "left",
                    fontFamily: "inherit",
                  }}
                >
                  <span style={{ flex: 1 }}>{m.label}</span>
                  {mode === m.id && <CheckIcon />}
                </button>
              ))}
            </div>
          )}
        </span>
        {data && (
          <span style={{ fontSize: 13.5, fontWeight: 500 }}>
            <span style={{ color: colors.ok }}>+{data.plus}</span>{" "}
            <span style={{ color: colors.err }}>-{data.minus}</span>
          </span>
        )}
        <span style={{ flex: 1 }} />
        {actionMsg && (
          <span style={{ color: colors.dim, fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 220 }}>
            {actionMsg}
          </span>
        )}
        <span style={{ position: "relative", display: "flex" }}>
          <button
            onClick={() => void commitPush()}
            disabled={busy}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: "var(--chip)",
              border: "none",
              borderRadius: "999px 0 0 999px",
              padding: "7px 10px 7px 14px",
              fontSize: 13,
              color: colors.fg,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            <BranchIcon />
            Commit or push
          </button>
          <button
            onClick={() => setPushMenu((o) => !o)}
            aria-label="More actions"
            aria-expanded={pushMenu}
            style={{
              display: "flex",
              alignItems: "center",
              background: "var(--chip)",
              border: "none",
              borderLeft: `1px solid ${colors.border}`,
              borderRadius: "0 999px 999px 0",
              padding: "7px 10px 7px 8px",
              color: colors.fg,
              cursor: "pointer",
            }}
          >
            <span style={{ fontSize: 10, color: colors.dim }}>▾</span>
          </button>
          {pushMenu && (
            <div
              style={{
                position: "absolute",
                top: "calc(100% + 6px)",
                right: 0,
                minWidth: 200,
                background: colors.panel,
                border: `1px solid ${colors.border}`,
                borderRadius: 12,
                padding: 6,
                zIndex: 30,
                boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
              }}
            >
              <MenuItem
                icon={<BranchIcon />}
                label="Commit or push"
                onClick={() => {
                  setPushMenu(false);
                  void commitPush();
                }}
              />
              <MenuItem
                icon={<SteerIcon />}
                label="Create PR"
                onClick={() => {
                  setPushMenu(false);
                  void createPr();
                }}
              />
            </div>
          )}
        </span>
      </div>
      {data && (
        <div style={{ padding: "0 14px 8px", fontSize: 13, color: colors.dim, flexShrink: 0 }}>
          {mode === "branch" ? (
            <>
              {data.branch} <span style={{ color: "var(--gutter)" }}>→</span> {data.baseLabel}
            </>
          ) : (
            "Uncommitted changes"
          )}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <div style={{ flex: 1, minWidth: 0, overflowY: "auto", borderRight: `1px solid ${colors.border}` }}>
          {loading && <div style={{ color: colors.dim, fontSize: 13, padding: 16 }}>Loading diff…</div>}
          {!loading && data?.error && <div style={{ color: colors.err, fontSize: 13, padding: 16 }}>{data.error}</div>}
          {!loading && data && !data.error && data.files.length === 0 && (
            <div style={{ color: colors.dim, fontSize: 13, padding: 16 }}>No changes.</div>
          )}
          {!loading &&
            data?.files.map((f) => {
              const g = grammarFor(f.path);
              const dirs = f.path.split("/");
              const name = dirs.pop();
              const isCollapsed = collapsed.has(f.path);
              let prevEnd: number | null = null;
              return (
                <div
                  key={f.path}
                  ref={(el) => {
                    if (el) fileRefs.current.set(f.path, el);
                  }}
                >
                  <div
                    onClick={() => toggleCollapsed(f.path)}
                    title={isCollapsed ? "Expand file" : "Collapse file"}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "9px 14px",
                      background: colors.panel,
                      position: "sticky",
                      top: 0,
                      zIndex: 5,
                      fontSize: 13,
                      fontFamily: "var(--font-code)",
                      cursor: "pointer",
                      userSelect: "none",
                    }}
                  >
                    <span
                      style={{
                        display: "flex",
                        flexShrink: 0,
                        color: colors.dim,
                        transform: isCollapsed ? "rotate(-90deg)" : "none",
                        transition: "transform 120ms var(--ease-out)",
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                    </span>
                    <span style={{ minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {dirs.length > 0 && <span style={{ color: colors.dim }}>{dirs.join("/")}/</span>}
                      <span style={{ color: colors.fg }}>{name}</span>
                    </span>
                    <span style={{ color: colors.ok, flexShrink: 0 }}>+{f.plus}</span>
                    <span style={{ color: colors.err, flexShrink: 0 }}>-{f.minus}</span>
                  </div>
                  {!isCollapsed && f.hunks.map((h, hi) => {
                    const gap = prevEnd === null ? h.newStart - 1 : h.newStart - prevEnd;
                    prevEnd = h.newStart + h.lines.filter((l) => l.t !== "d").length;
                    return (
                      <div key={hi}>
                        {gap > 0 && (
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 10,
                              padding: "5px 14px",
                              background: "var(--panel-2)",
                              color: colors.dim,
                              fontSize: 12,
                            }}
                          >
                            <span style={{ fontSize: 10 }}>⇕</span>
                            {gap} unmodified line{gap === 1 ? "" : "s"}
                          </div>
                        )}
                        {h.lines.map((l, li) => (
                          <div
                            key={li}
                            style={{
                              display: "flex",
                              fontFamily: "var(--font-code)",
                              fontSize: 12,
                              lineHeight: 1.6,
                              background:
                                l.t === "a"
                                  ? "rgba(93, 202, 165, 0.10)"
                                  : l.t === "d"
                                    ? "rgba(240, 110, 110, 0.11)"
                                    : "transparent",
                            }}
                          >
                            <span
                              style={{
                                width: 44,
                                textAlign: "right",
                                paddingRight: 10,
                                color: l.t === "a" ? colors.ok : l.t === "d" ? colors.err : "var(--gutter)",
                                flexShrink: 0,
                                userSelect: "none",
                              }}
                            >
                              {l.no}
                            </span>
                            {g?.grammar ? (
                              <span
                                style={{ whiteSpace: "pre", flex: 1, color: "var(--code-fg)" }}
                                dangerouslySetInnerHTML={{
                                  __html: Prism.highlight(l.text, g.grammar, g.lang),
                                }}
                              />
                            ) : (
                              <span style={{ whiteSpace: "pre", flex: 1, color: "var(--code-fg)" }}>{l.text}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              );
            })}
        </div>
        {data && data.files.length > 0 && (
          <div style={{ width: "32%", minWidth: 170, maxWidth: 260, flexShrink: 0, overflowY: "auto", padding: "6px 6px 12px" }}>
            {renderTree(tree, 0)}
          </div>
        )}
      </div>
    </div>
  );
}

/** The embedded browser's renderer half: toolbar + a placeholder div whose
 *  bounds the native WebContentsView (main process) is pinned to. The
 *  actual page pixels are the native layer floating above this spot. */
function BrowserPane({ browserId }: { browserId: number }) {
  const holdRef = useRef<HTMLDivElement>(null);
  const [urlDraft, setUrlDraft] = useState("");
  const [state, setState] = useState<BrowserState>({
    id: browserId,
    url: "",
    title: "",
    canGoBack: false,
    canGoForward: false,
    loading: false,
  });
  const editingRef = useRef(false);

  useEffect(() => {
    void window.unbiased.openBrowser({ id: browserId });
    const off = window.unbiased.onBrowserState((s) => {
      if (s.id !== browserId) return;
      setState(s);
      if (!editingRef.current) setUrlDraft(s.url === "about:blank" ? "" : s.url);
    });
    const el = holdRef.current;
    if (!el) return off;
    const sync = () => {
      const r = el.getBoundingClientRect();
      void window.unbiased.setBrowserBounds({ id: browserId, x: r.x, y: r.y, width: r.width, height: r.height });
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    window.addEventListener("resize", sync);
    return () => {
      off();
      ro.disconnect();
      window.removeEventListener("resize", sync);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserId]);

  const navBtn = (label: string, enabled: boolean, action: "back" | "forward" | "reload") => (
    <button
      onClick={() => void window.unbiased.navigateBrowser({ id: browserId, action })}
      disabled={!enabled}
      aria-label={label}
      title={label}
      style={{
        background: "transparent",
        border: "none",
        color: enabled ? colors.fg : "var(--gutter)",
        cursor: enabled ? "pointer" : "default",
        padding: "4px 6px",
        fontSize: 14,
        fontFamily: "inherit",
        lineHeight: 1,
      }}
    >
      {label === "Back" ? "←" : label === "Forward" ? "→" : "⟳"}
    </button>
  );

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "8px 10px",
          borderBottom: `1px solid ${colors.border}`,
          flexShrink: 0,
        }}
      >
        {navBtn("Back", state.canGoBack, "back")}
        {navBtn("Forward", state.canGoForward, "forward")}
        {navBtn("Reload", state.url !== "", "reload")}
        <input
          value={urlDraft}
          onChange={(e) => setUrlDraft(e.target.value)}
          onFocus={() => {
            editingRef.current = true;
          }}
          onBlur={() => {
            editingRef.current = false;
            setUrlDraft(state.url === "about:blank" ? "" : state.url);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && urlDraft.trim()) {
              void window.unbiased.navigateBrowser({ id: browserId, url: urlDraft.trim() });
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
          placeholder="Enter a URL…"
          spellCheck={false}
          autoFocus={!state.url || state.url === "about:blank"}
          style={{
            flex: 1,
            background: "var(--panel-2)",
            border: `1px solid ${colors.border}`,
            borderRadius: 8,
            padding: "6px 10px",
            color: colors.fg,
            fontSize: 12.5,
            outline: "none",
            fontFamily: "inherit",
            minWidth: 0,
          }}
        />
        {state.loading && <span style={{ color: colors.dim, fontSize: 11, flexShrink: 0 }}>…</span>}
        <button
          onClick={() => void window.unbiased.openExternal(state.url)}
          disabled={!/^https?:/.test(state.url)}
          title="Open in external browser"
          aria-label="Open in external browser"
          style={{
            background: "transparent",
            border: "none",
            color: /^https?:/.test(state.url) ? colors.fg : "var(--gutter)",
            cursor: /^https?:/.test(state.url) ? "pointer" : "default",
            padding: "4px 6px",
            display: "flex",
            alignItems: "center",
            flexShrink: 0,
          }}
        >
          <ExternalLinkIcon />
        </button>
        <button
          onClick={() => void window.unbiased.startBrowserAnnotate(browserId)}
          disabled={!state.url || state.url === "about:blank"}
          title="Annotate"
          aria-label="Annotate page"
          style={{
            background: "transparent",
            border: "none",
            color: state.url && state.url !== "about:blank" ? colors.fg : "var(--gutter)",
            cursor: state.url && state.url !== "about:blank" ? "pointer" : "default",
            padding: "4px 6px",
            display: "flex",
            alignItems: "center",
            flexShrink: 0,
          }}
        >
          <AnnotationIcon />
        </button>
      </div>
      <div ref={holdRef} style={{ flex: 1, minHeight: 0, background: "var(--code-bg)" }} />
    </div>
  );
}

/** The integrated terminal: xterm.js in front, a PTY (user's shell, cwd =
 *  the active conversation's root) in the main process. Mounted for as
 *  long as its tab exists — hiding the tab only hides this component, so
 *  the shell session survives tab switches. */
/** A completed turn's work — narration, agent lifecycle rows, command
 *  groups — collapsed under a dim "Worked for Ns" header, Codex-style.
 *  The final message stays outside, always visible. */
function WorkedGroup({ duration, children }: { duration: number | null; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ margin: "14px 0" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          // Was width:100% with a full-bleed bottom rule — a horizontal line
          // across the whole transcript for what is a piece of metadata about
          // one turn. Shrinking it to its content makes it a label you can
          // click, and drops a divider that was competing with the content.
          width: "fit-content",
          background: "transparent",
          border: "none",
          padding: "2px 0 4px",
          color: colors.dim,
          fontSize: 12.5,
          letterSpacing: "var(--track-meta)",
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        {duration !== null ? `Worked for ${formatDuration(duration)}` : "Worked"}
        <span
          style={{
            display: "inline-block",
            transform: open ? "rotate(90deg)" : "none",
            transition: "transform 120ms var(--ease-out)",
            fontSize: 10,
          }}
        >
          ›
        </span>
      </button>
      {open && <div style={{ paddingTop: 2 }}>{children}</div>}
    </div>
  );
}

/** Codex-style sub-agent lifecycle marker in the transcript flow: a dim
 *  icon row ("Created an agent ⌄") that expands to the agent's name and an
 *  open-conversation link. The pinned engine's subAgentActivity items carry
 *  kind + agent path only, so the detail line names the model-chosen task
 *  name rather than the spawn instructions (which never reach the client). */
function AgentLifecycleRow({
  entry,
  onOpen,
}: {
  entry: Extract<Entry, { kind: "agent" }>;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Live spawns carry the instructions in the event; rows rebuilt from
  // history (resumed conversations) fetch them lazily from the agent's
  // transcript — the first inbound mail IS the task.
  const [fetchedPrompt, setFetchedPrompt] = useState<string | null>(null);
  useEffect(() => {
    if (!open || entry.prompt || fetchedPrompt || !entry.agentThreadId) return;
    // Only spawn rows: a "Messaged an agent" row's text is a later mail,
    // not the first one, so falling back to it would show the wrong text.
    if (entry.event !== "started") return;
    let alive = true;
    void window.unbiased.subagentTranscript(entry.agentThreadId).then((r) => {
      if (!alive) return;
      const task = r.entries.find((x) => x.kind === "user");
      if (task && task.kind === "user") setFetchedPrompt(task.text);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const prompt = entry.prompt ?? fetchedPrompt;
  const LABELS: Record<string, { verb: string; detail: string }> = {
    started: { verb: "Created", detail: "Created" },
    interacted: { verb: "Messaged", detail: "Messaged" },
    interrupted: { verb: "Interrupted", detail: "Interrupted" },
    completed: { verb: "Closed", detail: "Closed" },
    failed: { verb: "Failed", detail: "Failed:" },
  };
  const label = LABELS[entry.event] ?? { verb: entry.event, detail: entry.event };
  // The identity lives in the header ("Created 🍄 Singer"), so the expanded
  // line goes generic — repeating the name twice taught nothing. A row whose
  // agent never registered a name falls back to the old wording.
  const headerName = entry.name
    ? `${entry.agentThreadId ? `${agentEmoji(entry.agentThreadId)} ` : ""}${entry.name}`
    : "an agent";
  return (
    <div style={{ margin: "14px 0" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "transparent",
          border: "none",
          padding: 0,
          color: entry.event === "failed" ? colors.err : colors.dim,
          fontSize: 13.5,
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        <AgentIcon />
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {label.verb} <span style={{ color: entry.event === "failed" ? "inherit" : "var(--fg-soft)" }}>{headerName}</span>
        </span>
        <span
          style={{
            display: "inline-block",
            transform: open ? "rotate(90deg)" : "none",
            transition: "transform 120ms var(--ease-out)",
            fontSize: 10,
          }}
        >
          ›
        </span>
      </button>
      {open && (
        <div
          style={{
            color: colors.dim,
            fontSize: 13,
            padding: "6px 0 0 26px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            minWidth: 0,
          }}
        >
          <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {label.detail}{" "}
            {onOpen ? (
              // "a sub-agent" keeps the open-conversation affordance the name
              // button used to carry — the name itself moved to the header.
              <button
                onClick={onOpen}
                title="Open conversation"
                style={{
                  background: "transparent",
                  border: "none",
                  color: colors.accent,
                  fontSize: "inherit",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  padding: 0,
                }}
              >
                a sub-agent
              </button>
            ) : (
              <span>a sub-agent</span>
            )}
            {prompt ? ` with the instructions: ${prompt}` : entry.path ? ` — ${entry.path}` : ""}
          </span>
        </div>
      )}
    </div>
  );
}

function AgentIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="8" width="14" height="10" rx="3" />
      <path d="M12 8V5" />
      <circle cx="12" cy="3.5" r="1.2" />
      <path d="M9.5 12.5v1.2M14.5 12.5v1.2" />
    </svg>
  );
}

/** Read-only view of one sub-agent's conversation (multi-agent v2). The
 *  transcript comes from the engine on open and refetches on that thread's
 *  item completions; the in-flight reply streams live via deltas. The task
 *  the agent was GIVEN is not a thread item (it rides the engine's internal
 *  inter-agent channel), so the view shows the agent's side: its replies
 *  and the commands it runs. */
/** Markdown component set shared by the main chat and the sub-agent pane —
 *  same code blocks, file chips, links, and typography everywhere. */
/** The host of an external link, or null for anything that gets no icon:
 *  relative links, in-page anchors, and non-http(s) schemes. */
function linkHost(href?: string): string | null {
  if (!href || !/^https?:\/\//i.test(href)) return null;
  try {
    return new URL(href).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** `[X](X)` → `X`, for a pasted markdown link that only points at itself —
 *  what you get copying a link out of a rendered markdown surface. Returns
 *  null for everything else, deliberately including links that carry a real
 *  label: that label is content someone chose, not packaging. Only a whole
 *  pasted string is considered, so a link inside a larger paste is untouched. */
function collapseSelfLink(text: string): string | null {
  const m = /^\s*\[([^\]]+)\]\((\S+)\)\s*$/.exec(text);
  if (!m) return null;
  const label = m[1].trim();
  const href = m[2].trim();
  return label === href ? href : null;
}

function buildMdComponents(
  openFileRef: React.MutableRefObject<((path: string) => void) | undefined>,
  openLink?: (url: string) => void,
) {
  return {
    code: (props: { className?: string; children?: React.ReactNode }) => {
      const text = extractText(props.children);
      // Block code: the surrounding <pre> (CodeBlock) owns the chrome. A
      // fence WITHOUT a language has no className, so multiline content is
      // the real block/inline discriminator — chip-styling an untagged
      // ASCII diagram paints every line with the inline background.
      if (props.className || text.includes("\n")) {
        return <code style={{ fontFamily: "inherit", fontSize: "inherit" }}>{props.children}</code>;
      }
      // Only file references that ACTUALLY resolve are interactive — the
      // chip verifies existence before dressing itself as a link.
      return (
        <InlineCodeChip text={text} openRef={openFileRef}>
          {props.children}
        </InlineCodeChip>
      );
    },
    pre: (props: { children?: React.ReactNode }) => <CodeBlock>{props.children}</CodeBlock>,
    a: (props: { href?: string; children?: React.ReactNode }) => {
      const host = linkHost(props.href);
      return (
        <a
          href={props.href}
          onClick={(e) => {
            e.preventDefault();
            const href = props.href ?? "";
            if (/^https?:/.test(href)) openLink?.(href);
          }}
          // textDecoration:none is doing real work: the underline here was the
          // UA default, and a full-width solid rule under a long link title
          // out-weighed every other accent in the transcript. Colour carries
          // the affordance instead.
          style={{ color: "var(--accent)", cursor: "pointer", textDecoration: "none" }}
          title="Open in browser tab"
        >
          {host ? <Favicon host={host} /> : null}
          {props.children}
        </a>
      );
    },
    blockquote: (props: { children?: React.ReactNode }) => (
      <blockquote
        style={{
          margin: "10px 0",
          padding: "2px 12px",
          borderLeft: `3px solid ${colors.accent}`,
          // Same surface as the composer box; sized to its content.
          background: colors.panel,
          borderRadius: "0 8px 8px 0",
          color: "var(--fg-msg)",
          width: "fit-content",
          maxWidth: "100%",
        }}
      >
        {props.children}
      </blockquote>
    ),
    p: (props: { children?: React.ReactNode }) => <p style={{ margin: "12px 0" }}>{props.children}</p>,
    h1: (props: { children?: React.ReactNode }) => (
      <h1 style={{ fontSize: "1.5em", fontWeight: 650, margin: "28px 0 12px", color: "var(--fg)" }}>
        {props.children}
      </h1>
    ),
    h2: (props: { children?: React.ReactNode }) => (
      <h2 style={{ fontSize: "1.35em", fontWeight: 650, margin: "26px 0 12px", color: "var(--fg)" }}>
        {props.children}
      </h2>
    ),
    h3: (props: { children?: React.ReactNode }) => (
      <h3 style={{ fontSize: "1.15em", fontWeight: 600, margin: "22px 0 10px", color: "var(--fg)" }}>
        {props.children}
      </h3>
    ),
    ul: (props: { children?: React.ReactNode }) => (
      <ul style={{ margin: "10px 0", paddingLeft: 24 }}>{props.children}</ul>
    ),
    ol: (props: { children?: React.ReactNode }) => (
      <ol style={{ margin: "10px 0", paddingLeft: 24 }}>{props.children}</ol>
    ),
    li: (props: { children?: React.ReactNode }) => <li style={{ margin: "7px 0" }}>{props.children}</li>,
  };
}

function SubAgentPane({ threadId, name, status }: { threadId: string; name: string; status: string }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [path, setPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tail, setTail] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  // No file viewer owns this pane, so chips stay non-interactive; links
  // open in the system browser.
  const noOpenFile = useRef<((path: string) => void) | undefined>(undefined);
  const mdComponents = useMemo(
    () => buildMdComponents(noOpenFile, (href) => void window.unbiased.openExternal(href)),
    [],
  );

  useEffect(() => {
    let alive = true;
    const fetchTranscript = async () => {
      const r = await window.unbiased.subagentTranscript(threadId);
      if (!alive) return;
      setEntries(r.entries);
      setPath(r.path);
      setError(r.error ?? null);
      // A delta can land between the engine snapshot and this resolve —
      // never let the older snapshot truncate newer streamed text. An empty
      // snapshot always wins: the turn ended and the entries now carry it.
      setTail((t) => (r.streamText && t.startsWith(r.streamText) ? t : r.streamText));
    };
    void fetchTranscript();
    // Debounced refetch on this thread's item completions; deltas append
    // between refetches so streaming text is visible immediately.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const offs = [
      window.unbiased.onSubAgentActivity((p) => {
        if (p.threadId !== threadId) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void fetchTranscript(), 250);
      }),
      window.unbiased.onSubAgentDelta((p) => {
        if (p.threadId !== threadId) return;
        setTail((t) => t + p.delta);
      }),
    ];
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      offs.forEach((off) => off());
    };
  }, [threadId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [entries, tail]);

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div
        style={{
          padding: "10px 16px",
          borderBottom: `1px solid ${colors.border}`,
          fontSize: 12.5,
          color: colors.dim,
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexShrink: 0,
        }}
        title={path ?? undefined}
      >
        <span style={{ fontSize: 15, lineHeight: 1 }}>{agentEmoji(threadId)}</span>
        <span style={{ color: colors.fg, fontWeight: 600, fontSize: 13.5, letterSpacing: -0.1 }}>{name}</span>
        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{path}</span>
        <span style={{ flex: 1 }} />
        {status === "running" ? (
          <ShimmerText text="working…" />
        ) : (
          <span style={{ color: status === "failed" ? colors.err : colors.dim }}>{status}</span>
        )}
      </div>
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "18px 20px" }}>
        {error && <div style={{ color: colors.err, fontSize: 13 }}>{error}</div>}
        {!error && entries.length === 0 && tail === "" && (
          <div style={{ color: colors.dim, fontSize: 13 }}>
            No replies yet — the agent is {status === "running" ? "working on its task." : "idle."}
          </div>
        )}
        {entries.map((e, i) => {
          if (e.kind === "assistant") {
            return (
              <div key={i} style={{ margin: "12px 0", lineHeight: 1.65, fontSize: 14, color: "var(--fg-msg)" }}>
                <Markdown remarkPlugins={REMARK_PLUGINS} components={mdComponents}>{e.text}</Markdown>
              </div>
            );
          }
          if (e.kind === "user") {
            return (
              <div key={i} style={{ display: "flex", justifyContent: "flex-end", margin: "10px 0" }}>
                <div
                  style={{
                    maxWidth: "85%",
                    padding: "8px 12px",
                    borderRadius: 12,
                    background: colors.panel,
                    whiteSpace: "pre-wrap",
                    fontSize: 13,
                  }}
                >
                  {e.text}
                </div>
              </div>
            );
          }
          if (e.kind === "command") {
            return (
              <div
                key={i}
                style={{
                  margin: "8px 0",
                  padding: "8px 12px",
                  borderRadius: 10,
                  background: "var(--code-bg)",
                  border: `1px solid ${colors.border}`,
                  fontFamily: "var(--font-code)",
                  fontSize: 12,
                  color: colors.dim,
                }}
              >
                <span style={{ color: e.status === "failed" ? colors.err : colors.ok }}>▸ </span>
                <span style={{ color: colors.fg, whiteSpace: "pre-wrap", minWidth: 0, overflowWrap: "anywhere" }}>{e.command}</span>
              </div>
            );
          }
    if (e.kind === "compaction") {
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, margin: "14px 0" }}>
                <span style={{ flex: 1, height: 1, background: colors.border }} />
                <span style={{ color: colors.dim, fontSize: 11 }}>context compacted</span>
                <span style={{ flex: 1, height: 1, background: colors.border }} />
              </div>
            );
          }
          return null;
        })}
        {tail !== "" && (
          <div style={{ margin: "12px 0", lineHeight: 1.65, fontSize: 14, color: "var(--fg-msg)" }}>
            <Markdown remarkPlugins={REMARK_PLUGINS} components={mdComponents}>{tail}</Markdown>
          </div>
        )}
        {status === "running" && (
          <div style={{ display: "flex", margin: "10px 0" }}>
            <div
              style={{
                padding: "8px 12px",
                borderRadius: 12,
                background: colors.panel,
                border: `1px solid ${colors.border}`,
                fontSize: 13,
                color: colors.dim,
              }}
            >
              <ShimmerText text="working…" fontSize={13} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Live mirror of the agent's Chrome: JPEG frames from main's CDP screencast,
 *  with clicks/scroll/typing forwarded back. object-fit:contain letterboxes
 *  the frame, so a click's pane coordinates must be mapped through the drawn
 *  rect to page coordinates or input lands in the wrong place. */
function AgentMirrorPane({ active, threadId }: { active: boolean; threadId: string | null }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [frame, setFrame] = useState<{ src: string; width: number; height: number } | null>(null);
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const [status, setStatus] = useState<{ connected: boolean; url?: string; reason?: string }>({
    connected: false,
  });
  const lastMoveRef = useRef(0);

  // Start when this tab is shown, stop when hidden — no point streaming JPEGs
  // into a pane nobody is looking at.
  useEffect(() => {
    if (!active) return;
    const el = wrapRef.current;
    const w = el?.clientWidth ?? 800;
    const h = el?.clientHeight ?? 600;
    // devicePixelRatio: the pane is painted at w*dpr real pixels, so the
    // capture must match or the frame is upscaled and text goes soft.
    void window.unbiased.agentMirrorStart({ width: w, height: h, dpr: window.devicePixelRatio || 1, threadId });
    // TRAILING debounce. The old version was leading-edge only: it sent the
    // first size it saw and dropped everything within 250ms after it. The pane
    // is still laying out at mount, so the size it sent was a half-height box
    // and the corrected one — arriving milliseconds later — was thrown away.
    // The page then rendered at the wrong aspect and letterboxed for good.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver((entries) => {
            const r = entries[0]?.contentRect;
            if (!r || r.width < 1 || r.height < 1) return;
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
              resizeTimer = null;
              void window.unbiased.agentMirrorResize({
                width: r.width,
                height: r.height,
                dpr: window.devicePixelRatio || 1,
              });
            }, 150);
          })
        : null;
    if (el && ro) ro.observe(el);
    return () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      ro?.disconnect();
      void window.unbiased.agentMirrorStop();
    };
    // threadId included: switching conversations has to re-point the mirror,
    // or the pane keeps streaming the tab of the chat you just left.
  }, [active, threadId]);

  useEffect(() => {
    const offs = [
      window.unbiased.onAgentMirrorFrame((p) => setFrame(p)),
      window.unbiased.onAgentMirrorState((p) =>
        setStatus({ connected: p.connected, url: p.url, reason: p.reason }),
      ),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  // Pane point -> page point, accounting for the letterbox contain-fit.
  const toPage = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const img = imgRef.current;
    const f = frameRef.current;
    if (!img || !f) return null;
    const box = img.getBoundingClientRect();
    const scale = Math.min(box.width / f.width, box.height / f.height);
    const drawnW = f.width * scale;
    const drawnH = f.height * scale;
    const offX = box.left + (box.width - drawnW) / 2;
    const offY = box.top + (box.height - drawnH) / 2;
    const x = (clientX - offX) / scale;
    const y = (clientY - offY) / scale;
    if (x < 0 || y < 0 || x > f.width || y > f.height) return null; // clicked the letterbox
    return { x: Math.round(x), y: Math.round(y) };
  };

  const send = (ev: Record<string, unknown>) => void window.unbiased.agentMirrorInput(ev);
  // Modifiers come from the event that carries them — a shared ref would go
  // stale, since a mouse event can be modified without any key event firing.
  const modsOf = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
    (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

  const onMouse = (type: "mousePressed" | "mouseReleased" | "mouseMoved") => (e: React.MouseEvent) => {
    // Native mousemove fires ~120x/s; each one is an IPC round trip and Chrome
    // only needs enough to drive hover. Presses and releases are never dropped.
    if (type === "mouseMoved") {
      const now = Date.now();
      if (now - lastMoveRef.current < 33) return;
      lastMoveRef.current = now;
    }
    const p = toPage(e.clientX, e.clientY);
    if (!p) return;
    const button = e.button === 2 ? "right" : e.button === 1 ? "middle" : "left";
    send({ kind: "mouse", type, x: p.x, y: p.y, button: type === "mouseMoved" ? "none" : button, clickCount: e.detail || 1, modifiers: modsOf(e) });
  };

  const onWheel = (e: React.WheelEvent) => {
    const p = toPage(e.clientX, e.clientY);
    if (!p) return;
    send({ kind: "wheel", x: p.x, y: p.y, deltaX: -e.deltaX, deltaY: -e.deltaY, modifiers: modsOf(e) });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Focus lives on the wrapper; keep the app's own shortcuts out of the page.
    e.preventDefault();
    const mods = modsOf(e);
    // A single printable char with no ctrl/meta is text; everything else is a key.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      send({ kind: "text", text: e.key });
      return;
    }
    const keyCode = e.key === "Enter" ? 13 : e.key === "Backspace" ? 8 : e.key === "Tab" ? 9 : e.key === "Escape" ? 27 : e.key === "ArrowUp" ? 38 : e.key === "ArrowDown" ? 40 : e.key === "ArrowLeft" ? 37 : e.key === "ArrowRight" ? 39 : (e.keyCode || 0);
    send({ kind: "key", type: "rawKeyDown", key: e.key, code: e.code, keyCode, modifiers: mods });
    send({ kind: "key", type: "keyUp", key: e.key, code: e.code, keyCode, modifiers: mods });
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "var(--code-bg)" }}>
      <div style={{ padding: "6px 12px", fontSize: 12, color: colors.dim, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flexShrink: 0 }}>
        {status.connected ? status.url || "Agent browser" : "Connecting to the agent browser…"}
      </div>
      <div
        ref={wrapRef}
        tabIndex={0}
        onMouseDown={onMouse("mousePressed")}
        onMouseUp={onMouse("mouseReleased")}
        onMouseMove={onMouse("mouseMoved")}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
        style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", outline: "none", cursor: "default", overflow: "hidden" }}
      >
        {frame ? (
          // width/height 100% + contain: the frame's aspect now matches the
          // pane's, so "contain" fills it edge to edge with no bars.
          <img ref={imgRef} src={frame.src} draggable={false} style={{ width: "100%", height: "100%", objectFit: "contain", userSelect: "none" }} alt="" />
        ) : (
          <span style={{ color: colors.dim, fontSize: 13 }}>
            {status.connected
              ? "Waiting for the first frame…"
              : status.reason === "no-tab"
                ? "This conversation has not used the browser yet."
                : "The agent browser is not open."}
          </span>
        )}
      </div>
    </div>
  );
}

function TerminalPane() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const cs = getComputedStyle(host);
    const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
    const term = new Terminal({
      fontFamily: v("--font-code", "Menlo, monospace"),
      fontSize: 12.5,
      cursorBlink: true,
      theme: {
        background: v("--code-bg", "#0d0d0d"),
        foreground: v("--fg", "#fcfcfc"),
        cursor: v("--accent", "#FF563F"),
        selectionBackground: "rgba(127, 127, 127, 0.35)",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    // StrictMode double-mounts in dev: the disposed flag keeps the first
    // pass's PTY from leaking once its create resolves after cleanup.
    let termId: string | null = null;
    let disposed = false;
    const offs: (() => void)[] = [];
    void window.unbiased.createTerminal(term.cols, term.rows).then(({ id }) => {
      if (disposed) {
        void window.unbiased.killTerminal(id);
        return;
      }
      termId = id;
      offs.push(
        window.unbiased.onTermData((p) => {
          if (p.id === id) term.write(p.data);
        }),
        window.unbiased.onTermExit((p) => {
          if (p.id === id) term.write(`\r\n[process exited with code ${p.exitCode}]\r\n`);
        }),
      );
    });
    const dataDisp = term.onData((d) => {
      if (termId) void window.unbiased.writeTerminal(termId, d);
    });
    const ro = new ResizeObserver(() => {
      if (host.offsetWidth === 0) return; // tab hidden — nothing to fit
      fit.fit();
      if (termId) void window.unbiased.resizeTerminal(termId, term.cols, term.rows);
    });
    ro.observe(host);

    return () => {
      disposed = true;
      ro.disconnect();
      dataDisp.dispose();
      offs.forEach((off) => off());
      if (termId) void window.unbiased.killTerminal(termId);
      term.dispose();
    };
  }, []);

  return (
    <div
      ref={hostRef}
      style={{ flex: 1, minHeight: 0, background: "var(--code-bg)", padding: "8px 4px 8px 12px" }}
    />
  );
}

/** An image inside a markdown preview. Relative srcs resolve against the
 *  markdown file's own directory and load through the main process (the
 *  CSP forbids file:// URLs); http(s) srcs are left alone and simply
 *  won't load under the CSP — the alt text shows instead. */
function MdImage({ src, alt, baseDir }: { src?: string; alt?: string; baseDir: string }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (!src) return;
    if (/^(https?:|data:)/.test(src)) {
      setUrl(src);
      return;
    }
    const resolved = src.startsWith("/") ? src : `${baseDir}/${src}`;
    void (async () => {
      if (/\.svg$/i.test(resolved)) {
        const r = await window.unbiased.readFile(resolved);
        if (alive) setUrl(r.content ? `data:image/svg+xml;utf8,${encodeURIComponent(r.content)}` : null);
      } else {
        const r = await window.unbiased.readImage(resolved);
        if (alive) setUrl(r.dataUrl ?? null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [src, baseDir]);

  if (!url) return <span style={{ color: colors.dim, fontSize: 12.5 }}>[image: {alt || src}]</span>;
  return <img src={url} alt={alt} style={{ maxWidth: "100%", borderRadius: 8 }} />;
}

/** Codex-style file view: breadcrumb, line numbers, Prism highlighting.
 *  With onOpenFile, each crumb opens a dropdown of its parent directory
 *  (siblings, the crumb pre-expanded) for quick navigation. */
function FileViewer({
  file,
  onOpenFile,
  onOpenLink,
  preview,
}: {
  file: OpenFileInfo;
  onOpenFile?: (path: string, line?: number) => void;
  onOpenLink?: (url: string) => void;
  preview?: boolean;
}) {
  const content = file.content ?? "";
  // The preview component map memoizes per file — the link handler rides a
  // ref so the memo never closes over a stale prop.
  const onOpenLinkRef = useRef(onOpenLink);
  onOpenLinkRef.current = onOpenLink;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const lang = EXT_TO_PRISM[ext];
  const grammar = lang ? Prism.languages[lang] : undefined;
  const html = grammar ? Prism.highlight(content, grammar, lang) : escapeHtml(content);
  const lineCount = content === "" ? 0 : content.split("\n").length;
  const crumbs = file.relPath.split("/").filter(Boolean);
  const fullSegs = file.fullPath.split("/").filter(Boolean);
  const segOffset = fullSegs.length - crumbs.length;

  const [crumbMenu, setCrumbMenu] = useState<{ root: string; expand: string | null; left: number } | null>(null);
  const headerRef = useRef<HTMLDivElement>(null);

  // ⌘-click references: VS Code-style symbol navigation, powered by a
  // whole-word project search rather than a language server. The anchor is
  // the clicked spot in code-content coordinates, so the popover rides the
  // scroll with the line it points at.
  const [refs, setRefs] = useState<{
    word: string;
    items: RefHit[];
    truncated: boolean;
    loading: boolean;
    error?: string;
    x: number;
    lineTop: number;
  } | null>(null);
  const scrollBodyRef = useRef<HTMLDivElement>(null);
  const refsPanelRef = useRef<HTMLDivElement>(null);
  // 12.5px font × 1.6 line-height, shared by the gutter and code panes.
  const LINE_H = 20;
  const PAD_TOP = 14;

  // Markdown-preview element overrides: theme-colored links (opened via
  // the system browser), images resolved against this file's directory,
  // and code surfaces matching the app. Memoized per file — a fresh map
  // would remount the preview subtree every render.
  const previewComponents = useMemo(() => {
    const baseDir = file.fullPath.split("/").slice(0, -1).join("/") || "/";
    return {
      a: (props: { href?: string; children?: React.ReactNode }) => (
        <a
          href={props.href}
          onClick={(e) => {
            e.preventDefault();
            const href = props.href ?? "";
            if (/^https?:/.test(href)) onOpenLinkRef.current?.(href);
          }}
          // textDecoration:none is doing real work: the underline here was the
          // UA default, and a full-width solid rule under a long link title
          // out-weighed every other accent in the transcript. Colour carries
          // the affordance instead.
          style={{ color: "var(--accent)", cursor: "pointer", textDecoration: "none" }}
          title="Open in browser tab"
        >
          {props.children}
        </a>
      ),
      img: (props: { src?: string; alt?: string }) => (
        <MdImage src={props.src} alt={props.alt} baseDir={baseDir} />
      ),
      pre: (props: { children?: React.ReactNode }) => (
        <pre
          style={{
            background: "var(--code-bg)",
            border: `1px solid ${colors.border}`,
            borderRadius: 10,
            padding: "12px 14px",
            overflowX: "auto",
            fontFamily: "var(--font-code)",
            fontSize: 12.75,
            lineHeight: 1.65,
            color: "var(--code-fg)",
          }}
        >
          {props.children}
        </pre>
      ),
      code: (props: { className?: string; children?: React.ReactNode }) =>
        props.className ? (
          <code style={{ fontFamily: "inherit", fontSize: "inherit" }}>{props.children}</code>
        ) : (
          <code
            style={{
              fontFamily: "var(--font-code)",
              fontSize: "0.84em",
              background: "var(--chip)",
              padding: "2px 6px",
              borderRadius: 6,
            }}
          >
            {props.children}
          </code>
        ),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.fullPath]);

  // GitLens-style line blame: plain-click a line for the inline hint;
  // click the hint for the detail popup with an open-commit link.
  const [blame, setBlame] = useState<({ line: number; loading?: boolean } & BlameInfo) | null>(null);
  const [blameOpen, setBlameOpen] = useState(false);
  const blamePanelRef = useRef<HTMLDivElement>(null);
  const codePreRef = useRef<HTMLPreElement>(null);

  /** X position just past the end of a line's text (content coords). */
  function lineEndX(line: number): number {
    const pre = codePreRef.current;
    if (!pre) return 16;
    const cs = getComputedStyle(pre);
    const text = (content.split("\n")[line - 1] ?? "").replace(/\t/g, "        ");
    return pre.offsetLeft + parseFloat(cs.paddingLeft) + text.length * monoCharWidth(cs.font) + 16;
  }

  useEffect(() => {
    setCrumbMenu(null);
    setRefs(null);
    setBlame(null);
    setBlameOpen(false);
  }, [file.fullPath]);

  useEffect(() => {
    if (!blameOpen) return;
    function onDown(e: MouseEvent) {
      if (!blamePanelRef.current?.contains(e.target as Node)) setBlameOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setBlameOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [blameOpen]);

  // Land the target line in the upper third of the viewport.
  useEffect(() => {
    const el = scrollBodyRef.current;
    if (file.line && el) {
      el.scrollTop = Math.max(0, PAD_TOP + (file.line - 1) * LINE_H - el.clientHeight / 3);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.fullPath, file.line]);

  useEffect(() => {
    if (!refs) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setRefs(null);
    }
    function onDown(e: MouseEvent) {
      if (!refsPanelRef.current?.contains(e.target as Node)) setRefs(null);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [refs]);

  function handleCodeClick(e: React.MouseEvent<HTMLDivElement>) {
    // Plain click = line blame; ⌘/Ctrl-click = references.
    if (!(e.metaKey || e.ctrlKey)) {
      if (!window.getSelection()?.isCollapsed) return; // selecting, not clicking
      const el = scrollBodyRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const contentY = e.clientY - rect.top + el.scrollTop;
      const line = Math.floor(Math.max(contentY - PAD_TOP, 0) / LINE_H) + 1;
      if (line < 1 || line > lineCount) return;
      if (blame?.line === line) return; // already showing this line
      setBlameOpen(false);
      setBlame({ line, loading: true });
      void window.unbiased.blameLine(file.fullPath, line).then((r) => {
        setBlame((cur) => (cur?.line === line ? { line, ...r } : cur));
      });
      return;
    }
    if (!onOpenFile) return;
    const range = document.caretRangeFromPoint(e.clientX, e.clientY);
    const node = range?.startContainer;
    if (!node || node.nodeType !== Node.TEXT_NODE) return;
    const text = node.textContent ?? "";
    const isWord = (ch: string) => /[\w$]/.test(ch);
    let s = range.startOffset;
    let en = range.startOffset;
    while (s > 0 && isWord(text[s - 1])) s--;
    while (en < text.length && isWord(text[en])) en++;
    const word = text.slice(s, en);
    if (!word || word.length > 128 || /^\d+$/.test(word)) return;
    e.preventDefault();
    setCrumbMenu(null);
    // Anchor at the clicked line, in content coordinates (scroll included).
    const el = scrollBodyRef.current;
    const rect = el?.getBoundingClientRect();
    const contentX = rect && el ? e.clientX - rect.left + el.scrollLeft : 0;
    const contentY = rect && el ? e.clientY - rect.top + el.scrollTop : 0;
    const lineTop = PAD_TOP + Math.floor(Math.max(contentY - PAD_TOP, 0) / LINE_H) * LINE_H;
    const anchor = { x: contentX, lineTop };
    setRefs({ word, items: [], truncated: false, loading: true, ...anchor });
    void window.unbiased.searchRefs(word).then((res) => {
      setRefs({
        word,
        items: res.results ?? [],
        truncated: res.truncated ?? false,
        loading: false,
        error: res.error,
        ...anchor,
      });
    });
  }

  useEffect(() => {
    if (!crumbMenu) return;
    function onDown(e: MouseEvent) {
      if (!headerRef.current?.contains(e.target as Node)) setCrumbMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setCrumbMenu(null);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [crumbMenu]);

  function onCrumbClick(i: number, e: React.MouseEvent<HTMLElement>) {
    if (!onOpenFile) return;
    const selfAbs = "/" + fullSegs.slice(0, segOffset + i + 1).join("/");
    const parentSegs = fullSegs.slice(0, segOffset + i);
    // Root crumb: no parent to list siblings from — list the crumb itself.
    const root = parentSegs.length > 0 ? "/" + parentSegs.join("/") : selfAbs;
    const expand = i < crumbs.length - 1 && root !== selfAbs ? selfAbs : null;
    const left = (e.currentTarget as HTMLElement).offsetLeft;
    setCrumbMenu((m) => (m && m.left === left ? null : { root, expand, left }));
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div ref={headerRef} style={{ position: "relative", borderBottom: `1px solid ${colors.border}`, flexShrink: 0 }}>
        <div
          style={{
            padding: "10px 16px",
            fontSize: 12.5,
            color: colors.dim,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={file.fullPath}
        >
          {crumbs.map((c, i) => (
            <span key={i}>
              {i > 0 && <span style={{ margin: "0 6px", color: "var(--gutter)" }}>›</span>}
              <button
                onClick={(e) => onCrumbClick(i, e)}
                style={{
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  fontFamily: "inherit",
                  fontSize: "inherit",
                  color: i === crumbs.length - 1 ? colors.fg : colors.dim,
                  cursor: onOpenFile ? "pointer" : "default",
                }}
              >
                {c}
              </button>
            </span>
          ))}
        </div>
        {crumbMenu && onOpenFile && (
          <div
            style={{
              position: "absolute",
              top: "100%",
              left: Math.min(crumbMenu.left, Math.max((headerRef.current?.clientWidth ?? 320) - 296, 8)),
              width: 288,
              maxHeight: 340,
              overflowY: "auto",
              background: colors.panel,
              border: `1px solid ${colors.border}`,
              borderRadius: 12,
              padding: 6,
              zIndex: 30,
              boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
            }}
          >
            <DirTree
              root={crumbMenu.root}
              initialExpanded={crumbMenu.expand ? [crumbMenu.expand] : undefined}
              onOpenFile={(p) => {
                setCrumbMenu(null);
                onOpenFile(p);
              }}
            />
          </div>
        )}
      </div>
      {file.error ? (
        <div style={{ padding: 24, color: colors.err, fontSize: 13 }}>{file.error}</div>
      ) : preview && /\.svg$/i.test(file.name) ? (
        <div
          style={{
            flex: 1,
            overflow: "auto",
            display: "grid",
            placeItems: "center",
            background: "var(--code-bg)",
            padding: 20,
          }}
        >
          <img
            src={`data:image/svg+xml;utf8,${encodeURIComponent(content)}`}
            alt={file.name}
            style={{ maxWidth: "100%", maxHeight: "100%", display: "block" }}
          />
        </div>
      ) : preview && /\.(md|markdown)$/i.test(file.name) ? (
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 28px", fontSize: 14.5, lineHeight: 1.7 }}>
          <Markdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={previewComponents}>
            {content}
          </Markdown>
        </div>
      ) : file.imageSrc ? (
        <div
          style={{
            flex: 1,
            overflow: "auto",
            display: "grid",
            placeItems: "center",
            background: "var(--code-bg)",
            padding: 20,
          }}
        >
          <img
            src={file.imageSrc}
            alt={file.name}
            style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: 8, display: "block" }}
          />
        </div>
      ) : (
        <div
          ref={scrollBodyRef}
          onClick={handleCodeClick}
          style={{ flex: 1, overflow: "auto", display: "flex", background: "var(--code-bg)", position: "relative" }}
        >
          {file.line !== undefined && (
            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: PAD_TOP + (file.line - 1) * LINE_H,
                height: LINE_H,
                background: "color-mix(in srgb, var(--accent) 14%, transparent)",
                pointerEvents: "none",
              }}
            />
          )}
          {refs &&
            onOpenFile &&
            (() => {
              const containerW = scrollBodyRef.current?.clientWidth ?? 480;
              const panelW = Math.min(520, containerW - 16);
              const panelLeft = Math.max(8, Math.min(refs.x - panelW / 2, containerW - panelW - 8));
              // Above the clicked line with a small gap; flip below when
              // the click is too close to the top of the file.
              const placeAbove = refs.lineTop > 352;
              return (
          <div
            ref={refsPanelRef}
            style={{
              position: "absolute",
              left: panelLeft,
              width: panelW,
              ...(placeAbove
                ? { top: refs.lineTop - 10, transform: "translateY(-100%)" }
                : { top: refs.lineTop + LINE_H + 10 }),
              maxHeight: 320,
              overflowY: "auto",
              boxSizing: "border-box",
              background: colors.panel,
              border: `1px solid ${colors.border}`,
              borderRadius: 12,
              padding: 6,
              zIndex: 30,
              boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 10px 6px",
                fontSize: 12.5,
                color: colors.dim,
              }}
            >
              <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                References to <code style={{ fontFamily: "var(--font-code)", color: colors.fg }}>{refs.word}</code>
                {refs.loading
                  ? " · searching…"
                  : ` · ${refs.items.length}${refs.truncated ? "+" : ""} result${refs.items.length === 1 ? "" : "s"}`}
              </span>
              <button
                onClick={() => setRefs(null)}
                aria-label="Close references"
                style={{ background: "transparent", border: "none", color: colors.dim, cursor: "pointer", padding: 0, display: "flex" }}
              >
                <CloseIcon />
              </button>
            </div>
            {refs.error && !refs.loading && (
              <div style={{ padding: "4px 10px 8px", fontSize: 12.5, color: colors.dim }}>{refs.error}</div>
            )}
            {!refs.loading && !refs.error && refs.items.length === 0 && (
              <div style={{ padding: "4px 10px 8px", fontSize: 12.5, color: colors.dim }}>No references found.</div>
            )}
            {refs.items.map((hit, i) => (
              <button
                key={`${hit.path}:${hit.line}:${i}`}
                onClick={() => {
                  setRefs(null);
                  onOpenFile(hit.path, hit.line);
                }}
                title={`${hit.rel}:${hit.line}`}
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 10,
                  width: "100%",
                  background: "transparent",
                  border: "none",
                  borderRadius: 6,
                  padding: "5px 10px",
                  fontSize: 12.5,
                  cursor: "pointer",
                  textAlign: "left",
                  fontFamily: "inherit",
                }}
              >
                <span style={{ color: colors.dim, flexShrink: 0, fontFamily: "var(--font-code)" }}>
                  {hit.rel}:{hit.line}
                </span>
                <span
                  style={{
                    color: colors.fg,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    fontFamily: "var(--font-code)",
                  }}
                >
                  {hit.text}
                </span>
              </button>
            ))}
          </div>
              );
            })()}
          {blame && (
            <span
              onClick={(e) => {
                e.stopPropagation();
                if (!blame.loading && !blame.error) setBlameOpen(true);
              }}
              title={blame.error ?? "Show commit details"}
              style={{
                position: "absolute",
                top: PAD_TOP + (blame.line - 1) * LINE_H,
                left: lineEndX(blame.line),
                height: LINE_H,
                display: "flex",
                alignItems: "center",
                whiteSpace: "nowrap",
                fontFamily: "var(--font-code)",
                fontSize: 11.5,
                color: "var(--gutter)",
                cursor: blame.loading || blame.error ? "default" : "pointer",
                zIndex: 4,
              }}
            >
              {blame.loading
                ? "…"
                : blame.error
                  ? blame.error
                  : blame.uncommitted
                    ? "You • Uncommitted changes"
                    : `${blame.author}, ${relTime(blame.time ?? 0)} • ${blame.summary}`}
            </span>
          )}
          {blameOpen && blame && !blame.loading && !blame.error && (
            <div
              ref={blamePanelRef}
              style={{
                position: "absolute",
                top: PAD_TOP + blame.line * LINE_H + 8,
                left: Math.max(
                  16,
                  Math.min(lineEndX(blame.line), (scrollBodyRef.current?.clientWidth ?? 400) - 356),
                ),
                width: 340,
                maxWidth: "calc(100% - 24px)",
                background: colors.panel,
                border: `1px solid ${colors.border}`,
                borderRadius: 12,
                padding: "12px 14px",
                zIndex: 30,
                boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
                fontFamily: "var(--font-ui)",
              }}
            >
              <div style={{ fontSize: 13.5, color: colors.fg, fontWeight: 500 }}>
                {blame.uncommitted ? "You" : blame.author}
                <span style={{ color: colors.dim, fontWeight: 400 }}>
                  {" · "}
                  {relTime(blame.time ?? 0)}
                  {blame.time ? ` (${new Date(blame.time).toLocaleString()})` : ""}
                </span>
              </div>
              <div style={{ color: colors.dim, fontSize: 13, marginTop: 6 }}>
                {blame.uncommitted ? "Uncommitted changes" : blame.summary}
              </div>
              {!blame.uncommitted && (
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
                  <code
                    style={{
                      fontFamily: "var(--font-code)",
                      fontSize: 11.5,
                      background: "var(--chip)",
                      borderRadius: 6,
                      padding: "2px 7px",
                      color: colors.dim,
                    }}
                  >
                    {blame.hash?.slice(0, 7)}
                  </code>
                  {blame.url && onOpenLink && (
                    <button
                      onClick={() => {
                        setBlameOpen(false);
                        onOpenLink(blame.url!);
                      }}
                      style={{
                        background: "transparent",
                        border: "none",
                        color: colors.accent,
                        fontSize: 13,
                        cursor: "pointer",
                        fontFamily: "inherit",
                        padding: 0,
                      }}
                    >
                      Open commit ↗
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          <pre
            aria-hidden="true"
            style={{
              margin: 0,
              padding: "14px 0 14px 16px",
              textAlign: "right",
              color: "var(--gutter)",
              userSelect: "none",
              fontFamily: "var(--font-code)",
              fontSize: 12.5,
              lineHeight: 1.6,
              flexShrink: 0,
            }}
          >
            {Array.from({ length: lineCount }, (_, i) => i + 1).join("\n")}
          </pre>
          <pre
            ref={codePreRef}
            style={{
              margin: 0,
              padding: "14px 16px",
              flex: 1,
              fontFamily: "var(--font-code)",
              fontSize: 12.5,
              lineHeight: 1.6,
              color: "var(--code-fg)",
            }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      )}
    </div>
  );
}

function ChatPane({
  paneId,
  connected,
  reset,
  contextChip,
  onContextClear,
  emptyState,
  onBusyChange,
  onTurnLanded,
  onThreadCreated,
  onAskSideChat,
  onOpenFile,
  onPreviewImage,
  onOpenLink,
  accessMode,
  onAccessModeChange,
  planMode,
  onTogglePlanMode,
  draftSeed,
  composerHeader,
  threadId,
  persistTranscript,
  onOpenAgent,
  onOpenScheduled,
  onOpenMcp,
  onOpenConnectors,
  onOpenSkills,
}: {
  paneId: PaneId;
  connected: boolean;
  reset: {
    entries: Entry[];
    nonce: number;
    // Present when the conversation was reopened mid-turn.
    resume?: { running: boolean; approvals: HeldApproval[] } | null;
    runningTurnStart?: number | null;
    runningTurnStartedAt?: number | null;
  };
  contextChip?: string | { text: string; comment?: string; tag?: string; thumb?: string } | null;
  onContextClear?: () => void;
  emptyState: React.ReactNode;
  onBusyChange?: (busy: boolean) => void;
  onTurnLanded?: () => void;
  /** The thread this pane is on, once the engine has made one. Threads are
   *  created lazily by the first send, and until App knows the id it treats
   *  the pane as having no conversation at all: the title stays "New chat",
   *  the sidebar highlights nothing, the side panel is never snapshotted, and
   *  — the reason this exists — the context gauge is never cleared, because
   *  the only reset is keyed on the thread id changing and null never became
   *  anything. Main-pane only; a side chat's ephemeral fork is not the
   *  conversation the window is showing. */
  onThreadCreated?: (threadId: string, created: boolean, firstMessage: string) => void;
  onAskSideChat?: (text: string) => void;
  onOpenFile?: (path: string) => void;
  onPreviewImage?: (a: Attachment) => void;
  onOpenLink?: (url: string) => void;
  accessMode: AccessMode;
  onAccessModeChange: (mode: AccessMode) => void;
  planMode: boolean;
  onTogglePlanMode: () => void;
  // Start-page suggestion cards seed the composer through this.
  draftSeed?: { text: string; nonce: number } | null;
  // Rendered above the composer box (the project/branch context strip).
  composerHeader?: React.ReactNode;
  // The engine thread this pane shows (resumed threads); fresh chats learn
  // their id from the first send. Drives the transcript cache.
  threadId?: string | null;
  persistTranscript?: boolean;
  // Opens a sub-agent's conversation in the side panel (lifecycle rows).
  onOpenAgent?: (a: { threadId: string; name: string }) => void;
  /** Open the Scheduled view focused on a task the agent just created. */
  onOpenScheduled?: (key: string) => void;
  onOpenMcp?: () => void;
  onOpenConnectors?: () => void;
  onOpenSkills?: () => void;
}) {
  const [entries, setEntries] = useState<Entry[]>(reset.entries);
  const [draft, setDraft] = useState("");
  // The composer grows with its content instead of scrolling a fixed two-row
  // box: a pasted URL wraps to three lines, and hiding two of them behind a
  // scrollbar makes it look like the paste half-failed. Height is measured,
  // not counted from "\n" — soft-wrapped long tokens have no newline to count.
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fitComposer = () => {
    const el = taRef.current;
    if (!el) return;
    // Collapse first: scrollHeight only shrinks back if the box isn't already
    // holding the taller content open.
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, COMPOSER_MIN_H), COMPOSER_MAX_H)}px`;
  };
  useLayoutEffect(fitComposer, [draft]);
  // Width drives wrapping, and wrapping drives height — dragging the side-panel
  // divider rewraps a draft that never changed, so measuring only on [draft]
  // leaves the box the wrong size and hides the overflow it was meant to show.
  const lastWidth = useRef(0);
  useEffect(() => {
    const el = taRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      // Width only. Reacting to height would observe the very change this
      // callback makes and spin the observer against itself.
      const w = entries[0]?.contentRect.width ?? 0;
      if (w === lastWidth.current) return;
      lastWidth.current = w;
      fitComposer();
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  useEffect(() => {
    if (draftSeed) setDraft(draftSeed.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftSeed?.nonce]);
  // Annotations staged for the next send: transcript excerpts, each with an
  // optional comment, all attached together when the message goes out. The
  // side pane's handed-down selection (contextChip) is consumed into the
  // same list, so both panes present selections identically.
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  // null = the selection toolbar shows its buttons; a string (possibly
  // empty) = the "Add to chat" comment input is open with that draft.
  const [pendingComment, setPendingComment] = useState<string | null>(null);
  useEffect(() => {
    if (!contextChip) return;
    const a = typeof contextChip === "string" ? { text: contextChip, tag: "selection" } : contextChip;
    setAnnotations((list) => [...list, a]);
    onContextClear?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextChip]);

  // The + button's popup menu, plus whether the clipboard held an image
  // when it was opened (drives the "Image from clipboard" item's state).
  const [plusOpen, setPlusOpen] = useState(false);
  // Entry state for the + menu. A transition off a mounted flag rather than a
  // keyframe: keyframes restart from zero when re-triggered, and this menu can
  // be toggled fast. Set on the next frame so the browser has a "from" to
  // animate out of.
  const [plusShown, setPlusShown] = useState(false);
  useEffect(() => {
    if (!plusOpen) {
      setPlusShown(false);
      return;
    }
    const id = requestAnimationFrame(() => setPlusShown(true));
    return () => cancelAnimationFrame(id);
  }, [plusOpen]);
  // The menu panel hangs off the composer box (full width), not the +
  // button, so outside-click must spare both.
  const plusRef = useRef<HTMLSpanElement>(null);
  const plusMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!plusOpen) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (plusRef.current?.contains(t) || plusMenuRef.current?.contains(t)) return;
      setPlusOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setPlusOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [plusOpen]);

  // Drag-and-drop onto the conversation.
  //
  // dragleave fires every time the pointer crosses into a CHILD element, so a
  // naive leave handler makes the overlay strobe as you move across the
  // transcript. Counting enters against leaves is the standard fix: the drag
  // has genuinely left only when the depth returns to zero.
  const dragDepth = useRef(0);
  const [dropping, setDropping] = useState(false);
  /** Only file drags. Dragging selected text within the app also fires these
   *  events, and offering to "attach" a text selection is nonsense. */
  const isFileDrag = (e: React.DragEvent) => Array.from(e.dataTransfer.types ?? []).includes("Files");

  function onDragEnter(e: React.DragEvent) {
    if (!isFileDrag(e)) return;
    dragDepth.current += 1;
    setDropping(true);
  }
  function onDragLeave(e: React.DragEvent) {
    if (!isFileDrag(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDropping(false);
  }
  function onDragOver(e: React.DragEvent) {
    if (!isFileDrag(e)) return;
    // Required: without preventDefault on dragover the drop never fires, and
    // Electron falls back to navigating the window to the dropped file.
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
  async function onDrop(e: React.DragEvent) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDropping(false);
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.unbiased.pathForDroppedFile(f))
      .filter(Boolean);
    if (paths.length === 0) return;
    const res = await window.unbiased.attachPaths(paths);
    if (!res.attachments?.length) return;
    // De-duplicate against what is already staged — dropping the same file
    // twice should not queue it twice.
    setAttachments((list) => {
      const seen = new Set(list.map((a) => a.path));
      return [...list, ...res.attachments.filter((a) => !seen.has(a.path))];
    });
    taRef.current?.focus();
  }

  function openPlusMenu() {
    // No longer async: the clipboard probe existed only to enable or disable
    // the "Image from clipboard" row, and opening a menu should not wait on
    // IPC. Pasting an image into the composer still attaches it.
    setPlusOpen(true);
  }

  // The access-mode picker popping over the composer.
  const [modeOpen, setModeOpen] = useState(false);
  const modeRef = useRef<HTMLSpanElement>(null);
  const modeMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!modeOpen) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (modeRef.current?.contains(t) || modeMenuRef.current?.contains(t)) return;
      setModeOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setModeOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [modeOpen]);

  function stageAttachment(a: Attachment) {
    setAttachments((list) => (list.some((x) => x.path === a.path) ? list : [...list, a]));
  }

  async function addAttachments() {
    setPlusOpen(false);
    const { attachments: picked } = await window.unbiased.chooseAttachments();
    picked.forEach(stageAttachment);
  }

  async function attachClipboardImage() {
    setPlusOpen(false);
    const { attachment } = await window.unbiased.clipboardImage();
    if (attachment) stageAttachment(attachment);
  }
  const [busy, setBusyState] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  // Messages queued while a turn runs; flushed one per turn completion.
  const [queue, setQueue] = useState<QueuedMsg[]>([]);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const nextQueueIdRef = useRef(1);
  const [sendHover, setSendHover] = useState(false);
  // Live context occupancy (per turn, from the engine) + the usage popover.
  const [ctxUsage, setCtxUsage] = useState<{ used: number; window: number | null; percent: number | null } | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [billing, setBilling] = useState<BillingResult | null>(null);
  const usageRef = useRef<HTMLSpanElement>(null);

  // Seed the gauge from the persisted reading on open/resume; live
  // notifications take over from there.
  useEffect(() => {
    let alive = true;
    setCtxUsage(null);
    if (!threadId) return;
    void window.unbiased.contextUsage(threadId).then((r) => {
      if (alive && r.usage) setCtxUsage(r.usage);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  useEffect(() => {
    if (!usageOpen) return;
    function onDown(e: MouseEvent) {
      if (!usageRef.current?.contains(e.target as Node)) setUsageOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setUsageOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [usageOpen]);
  // x = the selection's horizontal midpoint (anchors the button pill);
  // right = its bounding-box right edge (anchors the comment box beside
  // the numbered badge); y = its top.
  const [selection, setSelection] = useState<{ text: string; x: number; y: number; right: number } | null>(null);
  const savedRangeRef = useRef<Range | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);

  // Failsafe: if the compaction completion event never arrives (engine error,
  // or a compaction that produced nothing), don't strand the UI in the
  // "compacting" state forever — release it and flush the queue.
  useEffect(() => {
    if (!compacting) return;
    const timer = setTimeout(() => {
      setCompacting(false);
      const [head, ...rest] = queueRef.current;
      if (head) {
        setQueue(rest);
        void sendNow(head);
      }
    }, 180000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compacting]);

  // These props get a fresh identity on every parent render. The markdown
  // component map below must stay referentially stable — React reads a new
  // component-function identity as a different type and remounts the whole
  // subtree, which detaches the text nodes an active selection points at.
  // Routing the callbacks through refs keeps the map's deps empty.
  const onAskSideChatRef = useRef(onAskSideChat);
  onAskSideChatRef.current = onAskSideChat;
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  const onOpenLinkRef = useRef(onOpenLink);
  onOpenLinkRef.current = onOpenLink;

  function setBusy(b: boolean) {
    setBusyState(b);
    onBusyChange?.(b);
  }

  const threadIdRef = useRef<string | null>(threadId ?? null);
  // Set when an assistant message completes: the next delta starts a NEW
  // assistant entry instead of appending to the finished one. Multi-agent
  // turns emit several messages per turn; without this they run together.
  const messageBoundaryRef = useRef(false);
  // Did the current turn emit anything visible (text, command, plan)? A
  // turn that completes having produced NOTHING — the gateway returned an
  // empty completion — otherwise leaves the chat looking frozen with no
  // error. Reset on send, set on the first sign of output.
  const producedRef = useRef(true);
  // Consecutive empty turns. One is likely a transient upstream blip; two+
  // means something in the conversation history is being suppressed every
  // turn (e.g. Pareto's safety guard on credential-exfil content), so
  // retrying THIS chat won't help — a fresh chat will.
  const emptyStreakRef = useRef(0);

  /** Update command entries wherever they live — top level or folded inside
   *  a work group (turn completion moves entries there, and approval cards
   *  can still be live inside the fold). */
  function mapCommandsDeep(es: Entry[], f: (e: CommandEntry) => Entry): Entry[] {
    return es.map((e) => {
      if (e.kind === "command") return f(e as CommandEntry);
      if (e.kind === "work") return { ...e, entries: mapCommandsDeep(e.entries, f) };
      return e;
    });
  }

  /** Every command entry, walking into folded work groups — the same reach as
   *  mapCommandsDeep, but reading rather than rewriting. */
  function collectCommands(es: Entry[]): CommandEntry[] {
    const out: CommandEntry[] = [];
    for (const e of es) {
      if (e.kind === "command") out.push(e);
      else if (e.kind === "work") out.push(...collectCommands(e.entries));
    }
    return out;
  }

  // Attach an approval request to its command card (or make one). Shared
  // by the live event and the replay of requests held while backgrounded.
  function applyApproval(p: HeldApproval): void {
    setEntries((es) => {
      const cleaned = withoutTrailingPlaceholder(es);
      const approval = {
        requestId: p.requestId,
        reason: p.reason,
        kind: p.kind,
        grantRoot: p.grantRoot,
        message: p.message,
      };
      const idx = cleaned.findIndex((e) => e.kind === "command" && e.itemId === p.itemId);
      // A resumed conversation's approval attaches to a card INSIDE history,
      // below the turn scope — widen the scope so the waiting… status sees
      // it. Idempotent (min), so StrictMode's double-invoke is harmless.
      if (idx !== -1 && turnStartIndexRef.current !== null && idx < turnStartIndexRef.current) {
        turnStartIndexRef.current = idx;
      }
      if (idx !== -1) {
        const cmd = cleaned[idx] as CommandEntry;
        const updated: Entry = { ...cmd, status: "awaitingApproval", approval };
        return [...cleaned.slice(0, idx), updated, ...cleaned.slice(idx + 1)];
      }
      return [
        ...cleaned,
        {
          kind: "command",
          itemId: p.itemId ?? p.requestId,
          // A sub-agent's request has no command card in THIS transcript —
          // name the agent so the human knows who is asking.
          command: p.agentName ? `[sub-agent ${p.agentName}] ${p.command}` : p.command,
          status: "awaitingApproval",
          approval,
        },
      ];
    });
  }

  useEffect(() => {
    threadIdRef.current = threadId ?? null;
    messageBoundaryRef.current = false;
    setEntries(reset.entries);
    // A reopened conversation may still be mid-turn: restore its busy
    // state and any approval requests the agent is blocked on.
    setBusy(!!reset.resume?.running);
    // A conversation opened mid-turn: the fold at completion must reach back
    // over the REPLAYED half of the running turn, not just what streams after
    // this moment — otherwise its narration-so-far is stranded above the fold
    // forever. Main reports where that turn's output starts in the replay.
    turnStartIndexRef.current = reset.resume?.running
      ? (reset.runningTurnStart ?? reset.entries.length)
      : null;
    turnStartedAtRef.current = reset.resume?.running ? (reset.runningTurnStartedAt ?? null) : null;
    for (const held of reset.resume?.approvals ?? []) applyApproval(held);
    // A restored step can only still be running if the thread is. Statuses are
    // persisted in the transcript, so a command that died as inProgress when
    // the app quit is restored as inProgress — and StepsGroup reads exactly
    // that to say "Working…", forever, about work no process is doing. Same
    // disease as the stale approval cards above, one field over.
    if (!reset.resume?.running) {
      setEntries((es) =>
        mapCommandsDeep(es, (e) => (e.status === "inProgress" ? { ...e, status: "canceled" } : e)),
      );
    }
    // Occupancy is a property of the conversation being left, not the one
    // being entered. The [threadId] effect below also clears it, but only when
    // the id actually changes — this covers a reset where it does not.
    setCtxUsage(null);
    setCompacting(false);
    // A card persisted in the transcript looks exactly like a live one, so
    // anything restored has to be checked against what main is actually
    // holding. Without this, an approval whose turn died with the app still
    // offers Allow — and clicking it does nothing at all.
    // Only the cards being RESTORED are candidates. The answer arrives an IPC
    // round trip later, and an approval raised in that window would not be in
    // the set — judging it against a snapshot that predates it would expire a
    // live request permanently, since the verdict is persisted too. Opening a
    // thread mid-turn is exactly when that race is live.
    const restored = new Set(
      collectCommands(reset.entries)
        .filter((e) => e.status === "awaitingApproval" && e.approval && !e.approval.decision)
        .map((e) => e.approval!.requestId),
    );
    if (restored.size > 0) {
      void window.unbiased.liveApprovals().then(({ requestIds }) => {
        const live = new Set(requestIds);
        setEntries((es) =>
          mapCommandsDeep(es, (e) =>
            e.approval && restored.has(e.approval.requestId) && !live.has(e.approval.requestId)
              ? { ...e, approval: { ...e.approval, expired: true } }
              : e,
          ),
        );
      });
    }
    // Staged annotations belong to the conversation they came from.
    setAnnotations([]);
    setPendingComment(null);
    setQueue([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reset.nonce]);

  // Persist the rendered transcript per thread (debounced) — the engine's
  // own history can't hold renderer-only content.
  useEffect(() => {
    if (!persistTranscript) return;
    const id = threadIdRef.current;
    if (!id || entries.length === 0) return;
    const timer = setTimeout(() => {
      void window.unbiased.saveTranscript(id, entries);
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, persistTranscript]);

  // Where the running turn's output starts in `entries`, and when it began —
  // consumed on completion to fold the work into a "Worked for Ns" group.
  const turnStartIndexRef = useRef<number | null>(null);
  const turnStartedAtRef = useRef<number | null>(null);

  // An undecided approval means the agent is waiting on the human — the
  // thinking clock pauses rather than blaming the model for our latency.
  // Scoped to the RUNNING turn: an orphaned card from an earlier turn must
  // not pin the status line forever.
  const turnScopeStart = turnStartIndexRef.current ?? entries.length;
  const awaitingApproval = entries.some(
    (e, i) =>
      i >= turnScopeStart &&
      e.kind === "command" &&
      e.status === "awaitingApproval" &&
      e.approval &&
      !e.approval.decision &&
      !e.approval.expired,
  );

  // Pareto completes the whole response before its first byte arrives
  // (~3-5s of silence), so the wait needs to look attended, not frozen.
  // The clock accumulates across approval pauses instead of resetting.
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    if (awaitingApproval) return; // frozen while the human decides
    const startedAt = Date.now() - elapsed * 1000;
    const timer = setInterval(() => setElapsed((Date.now() - startedAt) / 1000), 100);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, awaitingApproval]);

  useEffect(() => {
    const offs = [
      window.unbiased.onDelta((p) => {
        if (p.paneId !== paneId) return;
        producedRef.current = true;
        const boundary = messageBoundaryRef.current;
        messageBoundaryRef.current = false;
        setEntries((es) => {
          const last = es[es.length - 1];
          if (!last || last.kind !== "assistant" || boundary) return [...es, { kind: "assistant", text: p.delta }];
          return [...es.slice(0, -1), { ...last, text: last.text + p.delta }];
        });
      }),
      window.unbiased.onMessageBoundary((p) => {
        if (p.paneId !== paneId) return;
        messageBoundaryRef.current = true;
      }),
      window.unbiased.onTurnCompleted((p) => {
        // The agent browser is a view of work in progress — when the turn ends
        // there is nothing left to watch, so it closes itself rather than
        // lingering as a still frame. Reopen any time from the "Agent Browser"
        // label in the transcript; that is now its only door, which matters
        // for sign-ins, where the page is the only place to type.
        if (p.paneId === paneId) closeAgentMirrorRef.current?.();
        if (p.paneId !== paneId) return;
        setBusy(false);
        onTurnLanded?.();
        // A turn that produced anything breaks the empty streak.
        if (producedRef.current) emptyStreakRef.current = 0;
        // Read-and-clear OUTSIDE the updater: React can invoke updaters
        // more than once (StrictMode), and a consumed ref on the second
        // pass would silently skip the work fold.
        const workStart = turnStartIndexRef.current;
        const workStartedAt = turnStartedAtRef.current;
        turnStartIndexRef.current = null;
        turnStartedAtRef.current = null;
        setEntries((es) => {
          let next = es;
          if (p.status === "interrupted") {
            const last = next[next.length - 1];
            if (last?.kind === "assistant" && last.text !== "") {
              next = [...next.slice(0, -1), { ...last, interrupted: true }];
            }
          }
          next = withoutTrailingPlaceholder(next);
          // Fold a completed turn's intermediate output — narration, agent
          // lifecycle rows, command groups — under a "Worked for Ns" header,
          // leaving the final message visible (Codex-style). Only turns that
          // actually did agent/tool work get folded; failed and interrupted
          // turns stay raw so nothing hides the evidence.
          if (p.status === "completed") {
            const start = workStart;
            if (start !== null && start >= 0 && start < next.length) {
              const turnEntries = next.slice(start);
              const last = turnEntries[turnEntries.length - 1];
              const finalMsg = last?.kind === "assistant" ? last : null;
              const work = finalMsg ? turnEntries.slice(0, -1) : turnEntries;
              const didWork = work.some((e) => e.kind === "agent" || e.kind === "command");
              if (didWork && work.length > 0) {
                const duration = workStartedAt !== null ? (Date.now() - workStartedAt) / 1000 : null;
                next = [
                  ...next.slice(0, start),
                  { kind: "work", duration, entries: work },
                  ...(finalMsg ? [finalMsg] : []),
                ];
              }
            }
          }
          // A failed turn with no visible cause looks like the app doing
          // nothing — always say why.
          if (p.status === "failed") {
            next = [
              ...next,
              { kind: "assistant", text: `⚠ Turn failed${p.error ? `: ${p.error}` : "."}` },
            ];
          } else if (p.narrated) {
            // The turn produced progress narration and then yielded without
            // writing an answer. The work generally DID happen — this is the
            // "narrate and stop" mode — but nothing on screen said so, and a
            // conversation that simply halts mid-task looks like a hang. Only
            // fires when main positively saw commentary and never a final
            // answer, so a provider that does not stamp phase stays quiet.
            next = [
              ...next,
              {
                kind: "assistant",
                text: "⚠ The agent stopped after its progress notes without writing a final answer. Ask it to continue and it will pick up where it left off.",
              },
            ];
          } else if (p.status !== "interrupted" && !producedRef.current) {
            // "Completed" with zero output: the model returned an empty
            // completion. Indistinguishable from a hang unless we say so.
            emptyStreakRef.current += 1;
            const persistent = emptyStreakRef.current >= 2;
            next = [
              ...next,
              {
                kind: "assistant",
                text: persistent
                  ? "⚠ The model returned an empty response again. Something earlier in this conversation is being suppressed every turn — start a new chat to continue."
                  : "⚠ The model returned an empty response — try sending again.",
              },
            ];
          }
          // Stamp the settled final message — the hover timestamp beside
          // its copy button.
          const settled = next[next.length - 1];
          if (settled?.kind === "assistant" && settled.at === undefined) {
            next = [...next.slice(0, -1), { ...settled, at: Date.now() }];
          }
          return next;
        });
        // One queued message per completed turn.
        const [head, ...rest] = queueRef.current;
        if (head) {
          setQueue(rest);
          void sendNow(head);
        }
      }),
      window.unbiased.onApprovalRequest((p) => {
        if (p.paneId !== paneId) return;
        // A permission card IS output — the turn-completion check below already
        // counts it as work (kind === "command"), but producedRef did not, so a
        // turn whose only visible result was a card got labelled "the model
        // returned an empty response" — and on the second one, told the user to
        // abandon a perfectly good conversation. Two notions of "did anything
        // happen" in one function, disagreeing.
        producedRef.current = true;
        applyApproval(p);
      }),
      // The owning turn died (interrupt/failure) — the engine dropped the
      // request, so live Allow/Deny buttons would decide into the void.
      window.unbiased.onApprovalCanceled((p) => {
        if (p.paneId !== paneId) return;
        setEntries((es) =>
          mapCommandsDeep(es, (e) =>
            e.status === "awaitingApproval" && e.approval?.requestId === p.requestId && !e.approval.decision
              ? { ...e, status: "canceled" }
              : e,
          ),
        );
      }),
      window.unbiased.onTokenUsage((p) => {
        if (p.paneId !== paneId) return;
        setCtxUsage({ used: p.used, window: p.window, percent: p.percent });
      }),
      window.unbiased.onPlan((p) => {
        if (p.paneId !== paneId) return;
        producedRef.current = true;
        setEntries((es) => [...withoutTrailingPlaceholder(es), { kind: "assistant", text: p.text }]);
      }),
      window.unbiased.onSubAgentRenames((p) => {
        if (p.paneId !== paneId) return;
        // Nicknames recovered from the rollout after a reopen. Rows restored
        // from the transcript still read as raw task names ("app_bridge_routing")
        // because the live raw events that carry a nickname only flow for
        // threads the engine STARTED — never for a resumed one. Retitle by the
        // name the row currently shows, since the registry is empty after a
        // restart and cannot supply thread ids to match on.
        const names = p.names ?? {};
        if (Object.keys(names).length === 0) return;
        const retitle = (list: Entry[]): Entry[] =>
          list.map((e) => {
            if (e.kind === "agent" && e.name && names[e.name]) return { ...e, name: names[e.name] };
            if (e.kind === "work") return { ...e, entries: retitle(e.entries) };
            return e;
          });
        setEntries(retitle);
      }),
      window.unbiased.onSubAgentEvent((p) => {
        if (p.paneId !== paneId) return;
        if (p.event === "renamed") {
          // The engine-assigned nickname lands moments after the spawn —
          // retitle every row (top-level or inside a work group).
          const rename = (list: Entry[]): Entry[] =>
            list.map((e) => {
              if (e.kind === "agent" && e.agentThreadId === p.agentThreadId) return { ...e, name: p.name };
              if (e.kind === "work") return { ...e, entries: rename(e.entries) };
              return e;
            });
          setEntries(rename);
          return;
        }
        producedRef.current = true;
        setEntries((es) => [
          ...withoutTrailingPlaceholder(es),
          { kind: "agent", event: p.event, name: p.name, path: p.path, agentThreadId: p.agentThreadId, prompt: p.prompt },
        ]);
      }),
      window.unbiased.onScheduledCreated((p) => {
        if (p.paneId !== paneId) return;
        producedRef.current = true;
        setEntries((es) => [
          ...withoutTrailingPlaceholder(es),
          { kind: "scheduled", key: p.key, name: p.name, cadence: p.cadence },
        ]);
      }),
      window.unbiased.onCompaction((p) => {
        if (p.paneId !== paneId) return;
        setEntries((es) => {
          const cleaned = withoutTrailingPlaceholder(es);
          // Consecutive compactions collapse into one divider.
          if (cleaned[cleaned.length - 1]?.kind === "compaction") return cleaned;
          return [...cleaned, { kind: "compaction" }];
        });
        // Manual compaction finished — clear the state and release anything
        // the user queued while it ran (one send; its completion flushes the
        // rest, matching the per-turn queue drain).
        setCompacting(false);
        const [head, ...rest] = queueRef.current;
        if (head) {
          setQueue(rest);
          void sendNow(head);
        }
      }),
      window.unbiased.onCommand((p) => {
        if (p.paneId !== paneId) return;
        producedRef.current = true;
        const item = p.item;
        setEntries((es) => {
          const cleaned = withoutTrailingPlaceholder(es);
          const itemId = item.id ?? "unknown";
          // The card may have been folded into a work group by the time a
          // late item event lands — update it in place wherever it lives
          // instead of appending a duplicate.
          let found = false;
          const mapped = mapCommandsDeep(cleaned, (existing) => {
            if (existing.itemId !== itemId) return existing;
            found = true;
            return {
              ...existing,
              command: item.command ?? existing.command,
              status: item.status ?? existing.status,
              exitCode: item.exitCode ?? existing.exitCode,
              output: item.aggregatedOutput ?? item.output ?? existing.output,
            };
          });
          if (found) return mapped;
          return [
            ...cleaned,
            {
              kind: "command",
              itemId,
              command: item.command ?? "(command)",
              status: item.status ?? (p.phase === "started" ? "inProgress" : "completed"),
              exitCode: item.exitCode,
              output: item.aggregatedOutput ?? item.output,
            },
          ];
        });
      }),
    ];
    return () => offs.forEach((off) => off());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [entries]);

  // Drawn anew every time this pane shows a (different) conversation.
  const chatPlaceholder = useMemo(
    () => CHAT_PLACEHOLDERS[Math.floor(Math.random() * CHAT_PLACEHOLDERS.length)],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reset.nonce, threadId],
  );

  const lastEntry = entries[entries.length - 1];
  const showThinking = busy && !(lastEntry?.kind === "assistant" && lastEntry.text !== "");
  const canSend = connected && (draft.trim() !== "" || annotations.length > 0);
  // Compaction is offerable only when there IS uncompacted content: a
  // non-empty conversation whose last entry isn't already a compaction
  // divider, and nothing else in flight.
  const canCompact =
    !!threadIdRef.current &&
    !compacting &&
    !busy &&
    entries.length > 0 &&
    lastEntry?.kind !== "compaction";

  /** Summarize the history: frees context, and cuts the tool-call density
   *  that makes long conversations return empty responses. Stays "compacting"
   *  until the engine emits its contextCompaction item — the start RPC
   *  resolving only means it kicked off. */
  async function compactNow(): Promise<void> {
    if (!canCompact) return;
    setCompacting(true);
    const r = await window.unbiased.compact(paneId);
    if (!r.ok) {
      setCompacting(false);
      setEntries((es) => [
        ...es,
        { kind: "assistant", text: `⚠ Could not compact: ${r.error ?? "unknown error"}` },
      ]);
    }
  }

  /** Send a prepared message right now (fresh sends and queue flushes). */
  async function sendNow(q: QueuedMsg) {
    setBusy(true);
    producedRef.current = false;
    turnStartedAtRef.current = Date.now();
    setEntries((es) => {
      const next: Entry[] = [...es, { kind: "user", text: q.text, annotations: q.annotations }];
      turnStartIndexRef.current = next.length;
      return next;
    });
    try {
      const res = await window.unbiased.sendMessage(paneId, q.wire, q.attachments);
      threadIdRef.current = res.threadId;
      onThreadCreated?.(res.threadId, res.created, q.text);
    } catch (err) {
      setBusy(false);
      setEntries((es) => [...es, { kind: "assistant", text: `Something went wrong: ${String(err)}` }]);
    }
  }

  async function submit() {
    const text = draft.trim();
    // Annotations alone are a sendable message — the excerpts plus their
    // comments carry the intent even without accompanying prose.
    if ((!text && annotations.length === 0) || !connected) return;
    const anns = annotations;
    const wire = (
      anns.length > 0
        ? `Regarding ${anns.length === 1 ? "this excerpt" : "these excerpts"} from the conversation:\n\n` +
          anns
            .map((a, i) => {
              const head = anns.length > 1 ? `Excerpt ${i + 1}:\n` : "";
              const quoted = `> ${a.text.replace(/\n/g, "\n> ")}`;
              return head + quoted + (a.comment ? `\nComment: ${a.comment}` : "");
            })
            .join("\n\n") +
          `\n\n${text}`
        : text
    ).trimEnd();
    const sentAttachments = attachments;
    setDraft("");
    setAttachments([]);
    setAnnotations([]);
    const suffix = sentAttachments.length > 0 ? `📎 ${sentAttachments.map((a) => a.name).join(", ")}` : "";
    const msg: QueuedMsg = {
      id: nextQueueIdRef.current++,
      text: [text, suffix].filter(Boolean).join("\n\n"),
      wire,
      attachments: sentAttachments,
      annotations:
        anns.length > 0
          ? anns.map((a) => ({ text: a.text, comment: a.comment, tag: a.tag, thumb: a.thumb }))
          : undefined,
    };
    // A running turn — or an in-progress compaction — means the message
    // queues by default, Codex-style; it flushes when the work completes.
    if (busy || compacting) {
      setQueue((list) => [...list, msg]);
      return;
    }
    await sendNow(msg);
  }

  // Queue row actions. Steer = run this message next, immediately: it goes
  // to the queue front and the current turn is interrupted; the completion
  // flush sends it.
  function steerQueued(q: QueuedMsg) {
    if (!busy) {
      setQueue((list) => list.filter((x) => x.id !== q.id));
      void sendNow(q);
      return;
    }
    setQueue((list) => [q, ...list.filter((x) => x.id !== q.id)]);
    void window.unbiased.interrupt(paneId);
  }

  function deleteQueued(q: QueuedMsg) {
    setQueue((list) => list.filter((x) => x.id !== q.id));
  }

  function editQueued(q: QueuedMsg) {
    setQueue((list) => list.filter((x) => x.id !== q.id));
    setDraft(q.text);
    setAttachments(q.attachments);
    if (q.annotations) setAnnotations(q.annotations);
  }

  async function decide(itemId: string, requestId: string, decision: ApprovalDecision) {
    setEntries((es) =>
      mapCommandsDeep(es, (e) =>
        e.itemId === itemId && e.approval
          ? {
              ...e,
              approval: { ...e.approval, decision },
              status: decision === "decline" ? "declined" : "inProgress",
            }
          : e,
      ),
    );
    const r = await window.unbiased.decideApproval(requestId, decision);
    // Nothing was listening. Put the card back and say why, instead of
    // leaving it spinning on "running" forever.
    if (!r.ok) {
      setEntries((es) =>
        mapCommandsDeep(es, (e) =>
          e.itemId === itemId && e.approval
            ? {
                ...e,
                approval: { ...e.approval, decision: undefined, expired: true },
                status: "awaitingApproval",
              }
            : e,
        ),
      );
    }
  }

  const statusLabel = (e: CommandEntry) => {
    if (e.status === "awaitingApproval")
      return e.approval?.expired
        ? { text: "▸ expired", color: colors.dim }
        : { text: "▸ needs approval", color: colors.dim };
    if (e.status === "canceled") return { text: "▸ canceled", color: colors.dim };
    if (e.status === "inProgress") return { text: "▸ running", color: colors.amber };
    if (e.status === "declined") return { text: "▸ declined", color: colors.dim };
    if (e.status === "failed" || (e.exitCode ?? 0) !== 0)
      return { text: `▸ exit ${e.exitCode ?? "?"}`, color: colors.err };
    return { text: "▸ done", color: colors.ok };
  };

  function handleMouseUp() {
    if (!onAskSideChat) return;
    if (pendingComment !== null) return; // comment input open — Esc cancels, ✓ confirms
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? "";
    if (!text || !sel || sel.rangeCount === 0) {
      setSelection(null);
      return;
    }
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const paneRect = paneRef.current?.getBoundingClientRect();
    if (!paneRect) return;
    savedRangeRef.current = range.cloneRange();
    setSelection({
      text,
      x: rect.left - paneRect.left + rect.width / 2,
      y: rect.top - paneRect.top,
      right: rect.right - paneRect.left,
    });
  }

  useLayoutEffect(() => {
    if (selection && savedRangeRef.current) {
      try {
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(savedRangeRef.current);
        }
      } catch {
        // Range invalid if DOM nodes were replaced
      }
    }
  }, [selection]);

  // The excerpt being annotated stays tinted via the CSS Custom Highlight
  // API — the browser selection collapses the instant the comment input
  // takes focus, so the native highlight can't carry this. Names are
  // pane-scoped because CSS.highlights is a document-global registry.
  //
  // The pane id goes through highlightName() first: a side pane is "side:1",
  // and a registered name containing ":" can never be written as a
  // ::highlight() selector — the colon is not a valid ident character. So the
  // side-chat tints were registered and then styled by nothing at all, which
  // is why annotating in a side chat produced a badge but no colour.
  const highlightName = (kind: string) => `${kind}-${paneId.replace(/:/g, "-")}`;
  useEffect(() => {
    if (typeof Highlight === "undefined") return;
    const name = highlightName("pending");
    if (pendingComment !== null && savedRangeRef.current) {
      CSS.highlights.set(name, new Highlight(savedRangeRef.current));
    } else {
      CSS.highlights.delete(name);
    }
    return () => void CSS.highlights.delete(name);
  }, [pendingComment, paneId]);

  // Confirmed annotations keep their tint until the message sends. A range
  // dies silently if its DOM re-renders; the captured text is unaffected.
  useEffect(() => {
    if (typeof Highlight === "undefined") return;
    const name = highlightName("annotations");
    const ranges = annotations.map((a) => a.range).filter((r): r is Range => Boolean(r));
    if (ranges.length > 0) CSS.highlights.set(name, new Highlight(...ranges));
    else CSS.highlights.delete(name);
    return () => void CSS.highlights.delete(name);
  }, [annotations, paneId]);

  // Numbered badges pinned at the top-right corner of each annotated
  // excerpt, Codex-style. Positions come from the stored ranges after
  // layout, in the transcript content's coordinate space, so they ride
  // along as it scrolls. A dead range (rect collapses to zero) simply
  // contributes no badge; the annotation chip still stands.
  const contentRef = useRef<HTMLDivElement>(null);
  const [badges, setBadges] = useState<{ n: number; left: number; top: number; label: string }[]>([]);
  useLayoutEffect(() => {
    function compute() {
      const contentRect = contentRef.current?.getBoundingClientRect();
      if (!contentRect) {
        setBadges([]);
        return;
      }
      const list: { n: number; left: number; top: number; label: string }[] = [];
      const push = (range: Range | null | undefined, n: number, label: string) => {
        const rect = range?.getBoundingClientRect();
        if (!rect || (rect.width === 0 && rect.height === 0)) return;
        list.push({
          n,
          label,
          left: Math.max(0, Math.min(rect.right - contentRect.left + 4, contentRect.width - 28)),
          top: rect.top - contentRect.top - 22,
        });
      };
      annotations.forEach((a, i) => push(a.range, i + 1, a.comment ?? a.text));
      if (pendingComment !== null) push(savedRangeRef.current, annotations.length + 1, "");
      setBadges(list);
    }
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, [annotations, pendingComment, entries]);

  function confirmAnnotation() {
    if (!selection) return;
    const comment = (pendingComment ?? "").trim();
    setAnnotations((list) => [
      ...list,
      {
        text: selection.text,
        comment: comment || undefined,
        range: savedRangeRef.current?.cloneRange(),
        tag: "selection",
      },
    ]);
    setPendingComment(null);
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }

  function cancelAnnotation() {
    setPendingComment(null);
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }

  // Escape dismisses the annotate flow at any stage — button pill or
  // comment box, focused or not.
  useEffect(() => {
    if (!selection) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") cancelAnnotation();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection]);

  const mdComponents = useMemo(
    () => buildMdComponents(onOpenFileRef, (href) => onOpenLinkRef.current?.(href)),
    [],
  );

  // `nested` = rendered inside a "Worked for Ns" group. It used to be inferred
  // from isLast being false, which held only while the action row required
  // isLast to be TRUE; now that every settled reply shows one, the group's
  // intermediate narration has to be excluded explicitly or each line of it
  // sprouts a copy button.
  const renderBlock = (block: DisplayBlock, isLast = false, nested = false): React.ReactNode => {
    if (block.kind === "steps") {
      return (
        <StepsGroup key={`s${block.key}`} items={block.items} statusLabel={statusLabel} decide={decide} />
      );
    }
    const e = block.entry;
    if (e.kind === "user") {
      return (
        <div
          key={block.key}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: 8,
            margin: "10px 0",
          }}
        >
          {e.annotations && e.annotations.length > 0 && <SentAnnotations items={e.annotations} />}
          {e.text && (
            <div
              style={{
                // Narrower than before (85% let a long question run almost the
                // full pane, which defeats the point of the right-alignment
                // doing the speaker-identification work) and given a border,
                // so the bubble reads as a distinct surface rather than a
                // slightly different shade of the background.
                maxWidth: "72%",
                padding: "10px 14px",
                borderRadius: 14,
                background: "var(--chip)",
                border: `1px solid ${colors.border}`,
                whiteSpace: "pre-wrap",
                lineHeight: 1.55,
                fontSize: 14,
                letterSpacing: "var(--track-body)",
              }}
            >
              {e.text}
            </div>
          )}
          {e.text && <CopyButton text={e.text} />}
        </div>
      );
    }
    if (e.kind === "scheduled") {
      return (
        <div
          key={block.key}
          style={{ display: "flex", alignItems: "center", gap: 8, margin: "14px 0", fontSize: 13 }}
        >
          <span style={{ color: colors.accent, display: "flex" }}>
            <ClockIcon size={14} />
          </span>
          <span style={{ color: colors.dim }}>
            Scheduled <span style={{ color: colors.fg }}>{e.name}</span> — {e.cadence}.
          </span>
          {onOpenScheduled && (
            <button
              onClick={() => onOpenScheduled(e.key)}
              style={{
                background: "transparent",
                border: "none",
                padding: 0,
                color: colors.accent,
                fontSize: 13,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              View task
            </button>
          )}
        </div>
      );
    }
    if (e.kind === "compaction") {
      return (
        <div
          key={block.key}
          style={{ display: "flex", alignItems: "center", gap: 12, margin: "18px 0" }}
        >
          <span style={{ flex: 1, height: 1, background: colors.border }} />
          <span style={{ color: colors.dim, fontSize: 11.5, whiteSpace: "nowrap" }}>
            context compacted — earlier turns summarized
          </span>
          <span style={{ flex: 1, height: 1, background: colors.border }} />
        </div>
      );
    }
    if (e.kind === "agent") {
      return (
        <AgentLifecycleRow
          key={block.key}
          entry={e}
          onOpen={
            onOpenAgent && e.agentThreadId
              ? () => onOpenAgent({ threadId: e.agentThreadId!, name: e.name })
              : undefined
          }
        />
      );
    }
    if (e.kind === "assistant") {
      // The ⚠ rows are app-authored notices ("empty response", "turn failed"),
      // not model output — but they were rendered as ordinary assistant text,
      // so a one-line failure arrived at 15.5px in the reading colour and read
      // louder than the answer above it. A notice should be quieter than the
      // content it comments on: smaller, dim, and set apart by a rule rather
      // than by size.
      if (e.text.startsWith("⚠")) {
        return (
          <div
            key={block.key}
            style={{
              margin: "14px 0",
              padding: "9px 12px",
              maxWidth: "var(--measure)",
              borderRadius: 10,
              background: "var(--panel-2)",
              borderLeft: `2px solid ${colors.amber}`,
              color: colors.dim,
              fontSize: 13,
              lineHeight: 1.5,
              letterSpacing: "var(--track-meta)",
            }}
          >
            {e.text.replace(/^⚠\s*/, "")}
          </div>
        );
      }
      return (
        <div
          key={block.key}
          style={{
            margin: "22px 0",
            lineHeight: 1.7,
            fontSize: 15.5,
            color: "var(--fg-msg)",
            letterSpacing: "var(--track-body)",
            // Capped measure: at full pane width a reply runs well past 100
            // characters per line, and the eye loses its place on the return
            // sweep. Turn spacing goes up with it (16 → 22) so consecutive
            // turns read as separate rather than as one wall.
            maxWidth: "var(--measure)",
          }}
        >
          <Markdown remarkPlugins={REMARK_PLUGINS} components={mdComponents}>
            {e.text}
          </Markdown>
          {e.interrupted && <div style={{ color: colors.dim, fontSize: 12, marginTop: 4 }}>— stopped</div>}
          {/* Every settled reply gets its action row, not just the newest one:
              wanting to copy an answer from earlier in a conversation is at
              least as common as copying the last one, and the timestamp is the
              only record of when a turn landed.

              Two exclusions. The reply still streaming: a copy button on half
              an answer copies half an answer, and its timestamp does not exist
              yet. And anything folded into a work group, which `nested`
              carries — that content is intermediate narration, and a copy row
              per line of it would bury the group it belongs to. */}
          {e.text && !nested && !(isLast && busy) && (
            <AssistantActions text={e.text} at={e.at} />
          )}
        </div>
      );
    }
    if (e.kind === "work") {
      return (
        <WorkedGroup key={`w${block.key}`} duration={e.duration}>
          {toDisplayBlocks(e.entries).map((b) => renderBlock(b, false, true))}
        </WorkedGroup>
      );
    }
    return null;
  };

  return (
    <div
      ref={paneRef}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={(e) => void onDrop(e)}
      style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}
    >
      {/* The drop target. Feedback has to be visible DURING the drag, not on
          release — until something on screen changes, there is nothing telling
          you the window will accept what you are holding. Inert to the pointer
          so it cannot swallow the drop event it exists to advertise. */}
      {dropping && (
        <div
          data-popover
          style={{
            position: "absolute",
            inset: 8,
            zIndex: 30,
            pointerEvents: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            borderRadius: 16,
            border: `1.5px dashed color-mix(in srgb, var(--accent) 55%, transparent)`,
            background: "color-mix(in srgb, var(--bg) 72%, transparent)",
            backdropFilter: "blur(3px)",
            WebkitBackdropFilter: "blur(3px)",
            color: colors.fg,
            fontSize: 14.5,
            fontWeight: 500,
            letterSpacing: "var(--track-body)",
          }}
        >
          <span style={{ color: colors.accent, display: "flex" }}>
            <PaperclipIcon />
          </span>
          Drop to attach
        </div>
      )}
      {selection && onAskSideChat && (
        <div
          style={{
            position: "absolute",
            // Button pill: centered over the selection. Comment box: hung
            // up-and-right of the numbered badge (which marks the excerpt's
            // end), Codex-style, with the badge in the gap between them.
            left:
              pendingComment !== null
                ? Math.max(8, Math.min(selection.right + 16, (paneRef.current?.clientWidth ?? 400) - 310))
                : Math.max(80, Math.min(selection.x, (paneRef.current?.clientWidth ?? 400) - 80)),
            top: Math.max(8, selection.y - (pendingComment !== null ? 64 : 40)),
            transform: pendingComment !== null ? "none" : "translateX(-50%)",
            zIndex: 10,
            display: "flex",
            alignItems: "center",
            background: "var(--chip)",
            border: `1px solid ${colors.border}`,
            // Comment mode is a full pill, matching the in-page picker.
            borderRadius: pendingComment !== null ? 999 : 8,
            overflow: "hidden",
            boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          }}
        >
          {pendingComment === null ? (
            <>
              <button onClick={() => setPendingComment("")} style={pillButtonStyle}>
                Add to chat
              </button>
              <button
                onClick={() => {
                  onAskSideChat(selection.text);
                  setSelection(null);
                  window.getSelection()?.removeAllRanges();
                }}
                style={{ ...pillButtonStyle, borderLeft: `1px solid ${colors.border}` }}
              >
                Ask in side chat
              </button>
            </>
          ) : (
            <>
              <input
                autoFocus
                value={pendingComment}
                onChange={(e) => setPendingComment(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") confirmAnnotation();
                  if (e.key === "Escape") cancelAnnotation();
                }}
                placeholder="Add an optional comment…"
                style={{
                  width: 240,
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  color: colors.fg,
                  fontSize: 12.5,
                  padding: "10px 6px 10px 16px",
                  fontFamily: "inherit",
                }}
              />
              <button
                onClick={confirmAnnotation}
                title="Add annotation"
                aria-label="Add annotation"
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 14,
                  background: colors.accent,
                  color: "var(--accent-fg)",
                  border: "none",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 0,
                  margin: "4px 5px 4px 0",
                  flexShrink: 0,
                }}
              >
                <CheckIcon />
              </button>
            </>
          )}
        </div>
      )}

      <div ref={scrollRef} onMouseUp={handleMouseUp} style={{ flex: 1, overflowY: "auto", padding: "24px 0" }}>
        {entries.length === 0 && (
          <div style={{ height: "100%", display: "grid", placeItems: "center" }}>{emptyState}</div>
        )}
        <div ref={contentRef} style={{ maxWidth: 768, margin: "0 auto", padding: "0 24px", position: "relative" }}>
          {badges.map((b) => (
            <span
              key={b.n}
              title={b.label || undefined}
              style={{
                position: "absolute",
                left: b.left,
                top: b.top,
                zIndex: 5,
                minWidth: 20,
                height: 20,
                padding: "0 5px",
                boxSizing: "border-box",
                borderRadius: "999px 999px 999px 4px",
                background: colors.accent,
                color: "var(--accent-fg)",
                fontSize: 11.5,
                fontWeight: 600,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                boxShadow: "0 1px 4px rgba(0,0,0,0.35)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {b.n}
            </span>
          ))}
          {toDisplayBlocks(entries).map((b, i, arr) => renderBlock(b, i === arr.length - 1))}
          {compacting && (
            <div style={{ display: "flex", justifyContent: "flex-start", margin: "10px 0" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  padding: "10px 14px",
                  borderRadius: 12,
                  background: colors.panel,
                  border: `1px solid ${colors.border}`,
                  fontSize: 14,
                  color: colors.dim,
                }}
              >
                <span
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: 6,
                    border: `2px solid ${colors.border}`,
                    borderTopColor: colors.accent,
                    animation: "unbiased-spin 0.8s linear infinite",
                  }}
                />
                <ShimmerText text="Compacting conversation…" fontSize={14} />
              </div>
            </div>
          )}
          {busy && !compacting && (
            // Bare status line, no bubble: "thinking… Ns" until the first
            // output, then "waiting…" while the turn is still running
            // (streaming pauses, sub-agents working). Static text while
            // blocked on the human — shimmer means the MACHINE is busy.
            <div style={{ display: "flex", margin: "10px 0" }}>
              {showThinking && !awaitingApproval ? (
                <ShimmerText text={`thinking… ${formatDuration(elapsed)}`} fontSize={14} />
              ) : (
                <ShimmerText text="waiting…" fontSize={14} />
              )}
            </div>
          )}
        </div>
      </div>

      <div style={{ padding: "8px 16px 16px" }}>
        {composerHeader}
        {queue.length > 0 && (
          <div style={{ maxWidth: 768, margin: "0 auto 8px", display: "flex", flexDirection: "column", gap: 6 }}>
            {queue.map((q) => (
              <QueuedRow
                key={q.id}
                q={q}
                onSteer={() => steerQueued(q)}
                onDelete={() => deleteQueued(q)}
                onEdit={() => editQueued(q)}
                onOpenSideChat={
                  onAskSideChat
                    ? () => {
                        deleteQueued(q);
                        onAskSideChat(q.text);
                      }
                    : undefined
                }
              />
            ))}
          </div>
        )}
        <div
          style={{
            position: "relative",
            maxWidth: 768,
            margin: "0 auto",
            background: colors.panel,
            borderRadius: 16,
            padding: "12px 14px 10px",
          }}
        >
          {plusOpen && (
            <div
              ref={plusMenuRef}
              data-popover
              style={{
                position: "absolute",
                bottom: "calc(100% + 8px)",
                // Full composer width. Width on its own is what made this look
                // sparse before — five short labels ragged across 700px — so
                // the rows are given columns instead: a fixed icon gutter, a
                // fixed label column, then descriptions all starting at the
                // same x. Aligned columns are what makes a wide list read as
                // structured rather than empty.
                left: 0,
                right: 0,
                // Same surface as the composer box — Codex renders both at
                // one elevation, not the popup a step lighter.
                background: colors.panel,
                border: `1px solid ${colors.border}`,
                borderRadius: 14,
                padding: 6,
                zIndex: 20,
                boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
                // Grows out of its trigger rather than its own centre, so the
                // button and the menu read as one object. Starts at 0.96, not
                // 0 — nothing in the real world appears from nothing.
                transformOrigin: "bottom left",
                opacity: plusShown ? 1 : 0,
                transform: plusShown ? "scale(1)" : "scale(0.96)",
                // 140ms: this menu is opened many times a day, and past about
                // 200ms a frequently-used control starts to feel slow.
                transition: "opacity 140ms var(--ease-out), transform 140ms var(--ease-out)",
              }}
            >
              <div
                style={{
                  color: colors.dim,
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "var(--track-overline)",
                  padding: "6px 10px 6px",
                }}
              >
                Add
              </div>
              <MenuItem icon={<PaperclipIcon />} label="Files and folders" onClick={() => void addAttachments()} />
              {/* Second group. These three neither attach nor add anything —
                  two open a panel and one flips a mode — so they were sitting
                  under a heading that did not describe them. Proximity implies
                  relationship, and it was implying the wrong one. */}
              <div
                style={{
                  color: colors.dim,
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "var(--track-overline)",
                  padding: "12px 10px 6px",
                  marginTop: 4,
                  borderTop: `1px solid ${colors.border}`,
                }}
              >
                Pareto
              </div>
              <MenuItem
                icon={<SkillIcon />}
                label="Skills"
                desc="What Pareto knows how to do"
                trailing={<MenuChevron />}
                onClick={() => {
                  setPlusOpen(false);
                  onOpenSkills?.();
                }}
              />
              {/* Above MCP deliberately. Both reach the same machinery, but
                  this is the front door — pick a service, sign in — and MCP is
                  the escape hatch for a server you type in yourself. Ordering
                  them the other way puts the advanced form first. */}
              <MenuItem
                icon={<PlugIcon />}
                label="Connectors"
                desc="Connect Linear, Notion, Figma and more"
                trailing={<MenuChevron />}
                onClick={() => {
                  setPlusOpen(false);
                  onOpenConnectors?.();
                }}
              />
              <MenuItem
                icon={<McpIcon />}
                label="MCP"
                desc="Show MCP server status"
                trailing={<MenuChevron />}
                onClick={() => {
                  setPlusOpen(false);
                  onOpenMcp?.();
                }}
              />
              <MenuItem
                icon={<LightbulbIcon />}
                label="Plan mode"
                desc="Research first, propose a plan, act after"
                trailing={<StatePill on={planMode} />}
                onClick={() => {
                  setPlusOpen(false);
                  onTogglePlanMode();
                }}
              />
            </div>
          )}
          {(() => {
            const q = draft.startsWith("/") ? draft.slice(1).toLowerCase() : null;
            const showPlan = q !== null && "plan".startsWith(q);
            if (!showPlan) return null;
            return (
              <div
                style={{
                  position: "absolute",
                  bottom: "calc(100% + 8px)",
                  left: 0,
                  right: 0,
                  background: colors.panel,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 14,
                  padding: 6,
                  zIndex: 20,
                  boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
                }}
              >
                <button
                  onClick={() => {
                    onTogglePlanMode();
                    setDraft("");
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    width: "100%",
                    background: "var(--chip)",
                    border: "none",
                    borderRadius: 10,
                    padding: "10px 12px",
                    fontSize: 13.5,
                    color: colors.fg,
                    cursor: "pointer",
                    textAlign: "left",
                    fontFamily: "inherit",
                  }}
                >
                  <span style={{ color: colors.dim, display: "flex" }}>
                    <LightbulbIcon />
                  </span>
                  <span style={{ fontWeight: 500 }}>Plan</span>
                  <span style={{ color: colors.dim }}>mode</span>
                  <span style={{ flex: 1 }} />
                  <span style={{ color: colors.dim, fontSize: 12.5 }}>
                    {planMode ? "Turn plan mode off" : "Turn plan mode on"}
                  </span>
                </button>
              </div>
            );
          })()}
          {modeOpen && (
            <div
              ref={modeMenuRef}
              style={{
                position: "absolute",
                bottom: "calc(100% + 8px)",
                left: 0,
                right: 0,
                background: colors.panel,
                border: `1px solid ${colors.border}`,
                borderRadius: 16,
                padding: "10px 8px 8px",
                zIndex: 20,
                boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
              }}
            >
              <div style={{ color: colors.dim, fontSize: 13, padding: "0 10px 8px" }}>
                How should Pareto actions be approved?
              </div>
              {ACCESS_MODES.map((m) => {
                const selected = m.id === accessMode;
                const tone = m.danger ? colors.amber : colors.fg;
                return (
                  <button
                    key={m.id}
                    onClick={() => {
                      onAccessModeChange(m.id);
                      setModeOpen(false);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 12,
                      width: "100%",
                      background: "transparent",
                      border: "none",
                      borderRadius: 10,
                      padding: "9px 10px",
                      cursor: "pointer",
                      textAlign: "left",
                      fontFamily: "inherit",
                    }}
                  >
                    <span style={{ color: m.danger ? colors.amber : colors.dim, display: "flex", marginTop: 2, flexShrink: 0 }}>
                      {m.id === "ask" ? <HandIcon /> : m.id === "auto" ? <ShieldCheckIcon /> : <ShieldAlertIcon />}
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, color: tone, fontWeight: 500 }}>{m.name}</div>
                      <div style={{ fontSize: 12.5, color: m.danger ? colors.amber : colors.dim, marginTop: 2 }}>
                        {m.desc}
                      </div>
                    </span>
                    {selected && (
                      <span style={{ color: m.danger ? colors.amber : colors.fg, display: "flex", marginTop: 4 }}>
                        <CheckIcon />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          {attachments.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 10, paddingTop: 4 }}>
              {attachments.map((a) => {
                const remove = () => setAttachments((list) => list.filter((x) => x.path !== a.path));
                return a.kind === "image" && a.thumb ? (
                  <span key={a.path} title={a.path} style={{ position: "relative", display: "flex" }}>
                    <img
                      src={a.thumb}
                      alt={a.name}
                      onClick={onPreviewImage ? () => onPreviewImage(a) : undefined}
                      title={onPreviewImage ? "Open preview" : a.path}
                      style={{
                        width: 56,
                        height: 56,
                        objectFit: "cover",
                        borderRadius: 12,
                        border: `1px solid ${colors.border}`,
                        display: "block",
                        cursor: onPreviewImage ? "pointer" : "default",
                      }}
                    />
                    <RemoveBadge label={`Remove ${a.name}`} onClick={remove} />
                  </span>
                ) : (
                  <span
                    key={a.path}
                    title={a.path}
                    style={{
                      position: "relative",
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      background: "var(--chip)",
                      border: `1px solid ${colors.border}`,
                      borderRadius: 14,
                      padding: "8px 22px 8px 8px",
                      maxWidth: 240,
                    }}
                  >
                    <span
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 10,
                        background: "var(--code-bg)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: colors.fg,
                        flexShrink: 0,
                      }}
                    >
                      {a.kind === "folder" ? <FolderOutlineIcon /> : <FileIcon />}
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 13.5,
                          color: colors.fg,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {a.name}
                      </div>
                      <div style={{ fontSize: 12, color: colors.dim }}>
                        {a.kind === "folder" ? "Folder" : "File"}
                      </div>
                    </span>
                    <RemoveBadge label={`Remove ${a.name}`} onClick={remove} />
                  </span>
                );
              })}
            </div>
          )}
          {annotations.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
              {annotations.map((a, i) => (
                <span
                  key={i}
                  title={a.comment ? `${a.text}\n— ${a.comment}` : a.text}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    background: "var(--chip)",
                    border: `1px solid ${colors.border}`,
                    borderRadius: 8,
                    padding: "4px 8px",
                    fontSize: 12,
                    color: colors.dim,
                    maxWidth: 260,
                  }}
                >
                  <AnnotationIcon />
                  <span
                    style={{
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      color: colors.fg,
                    }}
                  >
                    {a.comment || a.text}
                  </span>
                  <button
                    onClick={() => setAnnotations((list) => list.filter((_, j) => j !== i))}
                    aria-label="Remove annotation"
                    style={{
                      background: "transparent",
                      border: "none",
                      color: colors.dim,
                      cursor: "pointer",
                      padding: 0,
                      display: "flex",
                    }}
                  >
                    <CloseIcon />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // ⌘Enter queues explicitly; plain Enter sends (which also
              // queues automatically while a turn is running).
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                // A matching slash command takes Enter before sending.
                const q = draft.startsWith("/") ? draft.slice(1).toLowerCase() : null;
                if (q !== null && "plan".startsWith(q)) {
                  onTogglePlanMode();
                  setDraft("");
                  return;
                }
                void submit();
              } else if (e.key === "Escape" && busy) {
                e.preventDefault();
                void window.unbiased.interrupt(paneId);
              }
            }}
            onPaste={(e) => {
              // A pasted image becomes an attachment.
              const items = Array.from(e.clipboardData?.items ?? []);
              if (items.some((it) => it.type.startsWith("image/"))) {
                e.preventDefault();
                void attachClipboardImage();
                return;
              }
              // Text pastes as usual, except a link that only points at itself:
              // brackets around a URL are packaging, not content.
              const bare = collapseSelfLink(e.clipboardData?.getData("text/plain") ?? "");
              if (bare === null) return;
              e.preventDefault();
              const el = e.currentTarget;
              const start = el.selectionStart ?? draft.length;
              const end = el.selectionEnd ?? start;
              setDraft(draft.slice(0, start) + bare + draft.slice(end));
              // React restores the caret to the end of the value; put it back
              // after what was inserted, so typing continues where you paused.
              const caret = start + bare.length;
              requestAnimationFrame(() => taRef.current?.setSelectionRange(caret, caret));
            }}
            placeholder={!connected ? "Engine starting…" : entries.length > 0 ? chatPlaceholder : "Do anything"}
            disabled={!connected}
            ref={taRef}
            rows={2}
            style={{
              width: "100%",
              resize: "none",
              background: "transparent",
              color: colors.fg,
              border: "none",
              fontSize: 14.5,
              lineHeight: 1.5,
              fontFamily: "inherit",
              outline: "none",
              display: "block",
              minHeight: COMPOSER_MIN_H,
              maxHeight: COMPOSER_MAX_H,
              overflowY: "auto",
            }}
          />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 6 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <span ref={plusRef} style={{ position: "relative", display: "flex" }}>
                <button
                  onClick={() => (plusOpen ? setPlusOpen(false) : void openPlusMenu())}
                  disabled={!connected}
                  title="Add"
                  aria-label="Add"
                  aria-expanded={plusOpen}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: connected ? colors.fg : colors.dim,
                    cursor: connected ? "pointer" : "default",
                    padding: "2px 4px",
                    fontSize: 20,
                    lineHeight: 1,
                    fontFamily: "inherit",
                    display: "flex",
                  }}
                >
                  +
                </button>
              </span>
              {planMode && (
                <button
                  onClick={onTogglePlanMode}
                  title="Plan mode is on — the agent researches read-only and proposes a plan. Click to turn off."
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    background: "var(--chip)",
                    border: "none",
                    borderRadius: 999,
                    padding: "4px 10px",
                    color: colors.accent,
                    fontSize: 13.5,
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  <LightbulbIcon />
                  Plan mode
                  <CloseIcon />
                </button>
              )}
              <span ref={modeRef} style={{ display: "flex" }}>
                <button
                  onClick={() => setModeOpen((o) => !o)}
                  aria-expanded={modeOpen}
                  title="How should Pareto actions be approved?"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    background: modeOpen ? "var(--chip)" : "transparent",
                    border: "none",
                    borderRadius: 999,
                    padding: "4px 10px",
                    color: accessMode === "full" ? colors.amber : colors.dim,
                    fontSize: 13.5,
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  {accessMode === "ask" ? <HandIcon /> : accessMode === "auto" ? <ShieldCheckIcon /> : <ShieldAlertIcon />}
                  {ACCESS_MODES.find((m) => m.id === accessMode)?.name}
                </button>
              </span>
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 14 }}>
            {ctxUsage && ctxUsage.percent !== null && (
              <span ref={usageRef} style={{ position: "relative", display: "flex" }}>
                <button
                  onClick={async () => {
                    if (usageOpen) {
                      setUsageOpen(false);
                      return;
                    }
                    setUsageOpen(true);
                    setBilling(null);
                    setBilling(await window.unbiased.readBilling());
                  }}
                  title={`Context: ${ctxUsage.percent}% used`}
                  aria-label="Context and usage"
                  style={{
                    background: "transparent",
                    border: "none",
                    padding: 2,
                    cursor: "pointer",
                    display: "flex",
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                    <circle cx="8" cy="8" r="6.5" fill="none" stroke="var(--gutter)" strokeWidth="2.5" />
                    <circle
                      cx="8"
                      cy="8"
                      r="6.5"
                      fill="none"
                      stroke={
                        ctxUsage.percent > 90 ? colors.err : ctxUsage.percent > 70 ? colors.amber : colors.dim
                      }
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeDasharray={`${(Math.min(100, ctxUsage.percent) / 100) * 40.8} 40.8`}
                      transform="rotate(-90 8 8)"
                    />
                  </svg>
                </button>
                {usageOpen && (
                  <div
                    style={{
                      position: "absolute",
                      bottom: "calc(100% + 10px)",
                      right: -40,
                      width: 320,
                      background: colors.panel,
                      border: `1px solid ${colors.border}`,
                      borderRadius: 14,
                      padding: "14px 16px",
                      zIndex: 30,
                      boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
                      fontSize: 13,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", color: colors.dim, marginBottom: 6 }}>
                      <span>Context window</span>
                      <span>
                        {fmtTokens(ctxUsage.used)}
                        {ctxUsage.window ? ` / ${fmtTokens(ctxUsage.window)} (${ctxUsage.percent}%)` : ""}
                      </span>
                    </div>
                    <div style={{ height: 4, borderRadius: 2, background: "var(--panel-2)", overflow: "hidden" }}>
                      <div
                        style={{
                          // The bar caps at full; the number beside it does not.
                          width: `${Math.min(100, ctxUsage.percent)}%`,
                          height: "100%",
                          borderRadius: 2,
                          background: ctxUsage.percent > 90 ? colors.err : ctxUsage.percent > 70 ? colors.amber : colors.accent,
                        }}
                      />
                    </div>
                    {ctxUsage.percent > 80 && (
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
                        <span style={{ flex: 1, minWidth: 0, color: ctxUsage.percent > 100 ? colors.err : colors.dim }}>
                          {ctxUsage.percent > 100
                            ? "Past the window — requests can start failing until this is compacted."
                            : "Getting full. Compacting summarizes the history and frees room."}
                        </span>
                        <button
                          onClick={() => {
                            setUsageOpen(false);
                            void compactNow();
                          }}
                          disabled={!canCompact}
                          style={{
                            flexShrink: 0,
                            background: "var(--chip)",
                            border: `1px solid ${colors.border}`,
                            borderRadius: 8,
                            color: canCompact ? colors.fg : colors.dim,
                            fontSize: 12.5,
                            padding: "5px 10px",
                            cursor: canCompact ? "pointer" : "default",
                            fontFamily: "inherit",
                          }}
                        >
                          {compacting ? "Compacting…" : "Compact now"}
                        </button>
                      </div>
                    )}
                    {/* Credits and spend from the platform. Pareto on an API
                        key is prepaid, not quota'd, so there are no reset
                        windows to show — balance is the number that matters. */}
                    {billing === null && (
                      <div style={{ color: colors.dim, marginTop: 14 }}>Loading usage…</div>
                    )}
                    {billing?.ok && (
                      <>
                        <div style={{ color: colors.dim, margin: "14px 0 6px" }}>
                          {billing.organization.name || "Your account"}
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", color: colors.fg }}>
                          <span>Credits</span>
                          <span style={{ fontVariantNumeric: "tabular-nums" }}>
                            {billing.balanceCents === null ? (
                              <span style={{ color: colors.dim }}>unavailable</span>
                            ) : (
                              <span style={{ color: billing.balanceCents <= 0 ? colors.err : colors.fg }}>
                                {fmtMoney(billing.balanceCents)}
                              </span>
                            )}
                          </span>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", color: colors.fg, marginTop: 8 }}>
                          <span>Spent this month</span>
                          <span style={{ fontVariantNumeric: "tabular-nums" }}>
                            {billing.monthToDateSpendCents === null ? (
                              <span style={{ color: colors.dim }}>unavailable</span>
                            ) : (
                              fmtMoney(billing.monthToDateSpendCents)
                            )}
                          </span>
                        </div>
                        {billing.tokens && (
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              color: colors.dim,
                              fontSize: 12,
                              marginTop: 8,
                            }}
                          >
                            <span>Tokens this month</span>
                            <span style={{ fontVariantNumeric: "tabular-nums" }}>
                              {fmtTokens(billing.tokens.input + billing.tokens.cached)} in ·{" "}
                              {fmtTokens(billing.tokens.output)} out
                            </span>
                          </div>
                        )}
                        {billing.balanceCents !== null && billing.balanceCents <= 0 && (
                          <div style={{ color: colors.err, fontSize: 12, marginTop: 10, lineHeight: 1.4 }}>
                            You're out of credits — turns will fail until the balance is topped up.
                          </div>
                        )}
                      </>
                    )}
                    {billing && !billing.ok && (
                      <div style={{ color: colors.dim, marginTop: 14 }}>Usage unavailable — {billing.error}.</div>
                    )}
                    {/* Manual compaction: summarizes the history, which both
                        frees context AND cuts the tool-call density that can
                        make a long conversation return empty responses. */}
                    <div style={{ borderTop: `1px solid ${colors.border}`, margin: "14px 0 0" }} />
                    <button
                      disabled={!canCompact}
                      onClick={() => {
                        setUsageOpen(false);
                        void compactNow();
                      }}
                      style={{
                        width: "100%",
                        textAlign: "left",
                        background: "transparent",
                        border: "none",
                        color: canCompact ? colors.fg : colors.dim,
                        fontSize: 13,
                        cursor: canCompact ? "pointer" : "default",
                        fontFamily: "inherit",
                        padding: "12px 0 2px",
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <span style={{ color: colors.dim, display: "flex" }}>
                        <CompactIcon />
                      </span>
                      {compacting
                        ? "Compacting…"
                        : lastEntry?.kind === "compaction"
                          ? "Nothing new to compact"
                          : "Compact conversation"}
                    </button>
                    <div style={{ color: colors.dim, fontSize: 11.5, lineHeight: 1.4 }}>
                      Summarizes older history to free context and fix a long conversation that returns empty replies.
                    </div>
                  </div>
                )}
              </span>
            )}
            <span style={{ color: colors.dim, fontSize: 13.5 }}>Pareto</span>
            {busy ? (
              <button
                onClick={() => void window.unbiased.interrupt(paneId)}
                title="Stop"
                aria-label="Stop"
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 16,
                  background: "transparent",
                  color: colors.err,
                  border: `1.5px solid ${colors.err}`,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 11,
                }}
              >
                ■
              </button>
            ) : (
              <span
                style={{ position: "relative", display: "flex" }}
                onMouseEnter={() => setSendHover(true)}
                onMouseLeave={() => setSendHover(false)}
              >
                {sendHover && canSend && (
                  <div
                    style={{
                      position: "absolute",
                      bottom: "calc(100% + 8px)",
                      right: 0,
                      background: colors.panel,
                      border: `1px solid ${colors.border}`,
                      borderRadius: 10,
                      padding: 6,
                      zIndex: 20,
                      boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
                      whiteSpace: "nowrap",
                      fontSize: 12.5,
                    }}
                  >
                    {[
                      { label: "Send", keys: "⏎" },
                      { label: "Queue", keys: "⌘⏎" },
                    ].map((o) => (
                      <div
                        key={o.label}
                        style={{ display: "flex", alignItems: "center", gap: 18, padding: "5px 8px", color: colors.fg }}
                      >
                        <span style={{ flex: 1 }}>{o.label}</span>
                        <span
                          style={{
                            background: "var(--panel-2)",
                            color: colors.dim,
                            borderRadius: 6,
                            padding: "1px 7px",
                            fontSize: 11,
                          }}
                        >
                          {o.keys}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <button
                  onClick={() => void submit()}
                  disabled={!canSend}
                  aria-label="Send"
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 16,
                    background: canSend ? colors.fg : "var(--panel-2)",
                    color: canSend ? "var(--bg)" : colors.dim,
                    border: "none",
                    cursor: canSend ? "pointer" : "default",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 19V5" />
                    <path d="M5 12l7-7 7 7" />
                  </svg>
                </button>
              </span>
            )}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Inline-code chip: becomes a clickable file link only after the path is
 *  CONFIRMED to resolve in the conversation's cwd — a dead link that opens
 *  "Could not open …" is worse than no link. The check runs per chip text;
 *  a file mentioned before the agent creates it stays plain until the
 *  message re-renders (rare, and honest either way). The open handler rides
 *  a ref so the markdown component map stays referentially stable. */
// Site icons, keyed by host and never cleared — unlike the path cache below,
// a host means the same thing in every conversation. Every link to the same
// site shares one in-flight request, and a null (no icon) is cached too.
const faviconCache = new Map<string, Promise<string | null>>();
// The settled answers, readable without awaiting. A resolved promise still
// costs a microtask, which is one frame of globe — and a turn folding remounts
// the whole transcript at once, so that frame is a visible flicker.
const faviconResolved = new Map<string, string | null>();
function probeFavicon(host: string): Promise<string | null> {
  let p = faviconCache.get(host);
  if (!p) {
    p = window.unbiased
      .favicon(host)
      .then((r) => r.dataUrl)
      .catch(() => null);
    faviconCache.set(host, p);
    void p.then((d) => faviconResolved.set(host, d));
  }
  return p;
}

/** The site's icon for a source link, falling back to a globe.
 *
 *  Its own component because buildMdComponents is memoized with EMPTY deps:
 *  holding this state in the `a` override would change that component's
 *  identity every time an icon resolved, remounting the markdown subtree and
 *  detaching the DOM nodes an open text selection points at — the same hazard
 *  the ref-routed callbacks there exist to avoid.
 *
 *  The box is a fixed size from the first frame, so an icon arriving mid-turn
 *  cannot reflow a streaming message. */
function Favicon({ host }: { host: string }) {
  const [src, setSrc] = useState<string | null>(() => faviconResolved.get(host) ?? null);
  useEffect(() => {
    // Already settled: paint it and skip the async path entirely.
    const known = faviconResolved.get(host);
    if (known !== undefined) {
      setSrc(known);
      return;
    }
    let live = true;
    setSrc(null);
    void probeFavicon(host).then((d) => {
      if (live) setSrc(d);
    });
    return () => {
      live = false;
    };
  }, [host]);
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 14,
        height: 14,
        marginRight: 4,
        verticalAlign: "-2px",
        flex: "none",
        color: "var(--dim)",
      }}
    >
      {src ? (
        <img src={src} width={14} height={14} alt="" style={{ borderRadius: 2, objectFit: "contain" }} />
      ) : (
        <GlobeIcon size={12} />
      )}
    </span>
  );
}

// One probe per unique path text — chips remount en masse when a turn
// folds, and every probe is an IPC + stat. Cleared on thread switch (the
// resolution base changes with the conversation's cwd).
const fileExistsCache = new Map<string, Promise<boolean>>();
function probeFileExists(text: string): Promise<boolean> {
  let p = fileExistsCache.get(text);
  if (!p) {
    p = window.unbiased.fileExists(text).then((r) => r.exists);
    fileExistsCache.set(text, p);
  }
  return p;
}

function InlineCodeChip({
  text,
  children,
  openRef,
}: {
  text: string;
  children?: React.ReactNode;
  openRef: React.MutableRefObject<((path: string) => void) | undefined>;
}) {
  const candidate = Boolean(openRef.current) && looksLikeFilePath(text);
  const [exists, setExists] = useState(false);
  useEffect(() => {
    // The text can mutate under a streaming re-render — drop the previous
    // path's verdict so an unverified chip is never momentarily clickable.
    setExists(false);
    if (!candidate) return;
    let alive = true;
    void probeFileExists(text).then((ok) => {
      if (alive) setExists(ok);
    });
    return () => {
      alive = false;
    };
  }, [candidate, text]);
  const clickable = candidate && exists;
  return (
    <code
      onClick={clickable ? () => openRef.current!(text) : undefined}
      title={clickable ? "Open file" : undefined}
      style={{
        fontFamily: "var(--font-code)",
        fontSize: "0.875em",
        background: "var(--chip)",
        // File references read as navigation, not code — accent them.
        color: clickable ? "var(--accent)" : "var(--fg-msg)",
        padding: "3px 8px",
        borderRadius: 6,
        cursor: clickable ? "pointer" : "inherit",
      }}
    >
      {children}
    </code>
  );
}

/** Pull the raw text out of react-markdown's rendered children. */
function extractText(node: React.ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (typeof node === "object" && "props" in node) {
    return extractText((node as { props: { children?: React.ReactNode } }).props.children);
  }
  return "";
}

const LANGUAGE_NAMES: Record<string, string> = {
  ts: "TypeScript",
  typescript: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  javascript: "JavaScript",
  jsx: "JavaScript",
  py: "Python",
  python: "Python",
  go: "Go",
  rust: "Rust",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  json: "JSON",
  toml: "TOML",
  yaml: "YAML",
  html: "HTML",
  css: "CSS",
  sql: "SQL",
};

/** Codex-style fenced code block: header bar with a language label and copy,
 *  dark canvas, and (in the main pane) click-to-open in the side chat. */
// Markdown fence language → loaded Prism grammar (the file viewer's
// EXT_TO_PRISM maps file EXTENSIONS; fences use language names).
const FENCE_TO_PRISM: Record<string, string> = {
  python: "python",
  py: "python",
  js: "javascript",
  javascript: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  typescript: "typescript",
  tsx: "tsx",
  jsx: "jsx",
  json: "json",
  bash: "bash",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  go: "go",
  golang: "go",
  rust: "rust",
  rs: "rust",
  toml: "toml",
  yaml: "yaml",
  yml: "yaml",
  sql: "sql",
  markdown: "markdown",
  md: "markdown",
  html: "markup",
  xml: "markup",
  svg: "markup",
  css: "css",
};

/** The fence's `language-x` class. Split out so the memo comparator below
 *  compares exactly what the render reads. */
function fenceClassOf(children?: React.ReactNode): string {
  const child = Array.isArray(children) ? children[0] : children;
  return (
    (typeof child === "object" && child && "props" in child
      ? ((child as { props: { className?: string } }).props.className ?? "")
      : "") || ""
  );
}

/** Memoized on its TEXT, not on `children` — react-markdown hands us a fresh
 *  element tree on every render, so the default shallow compare never hits and
 *  the block re-renders whenever anything in the pane changes.
 *
 *  That re-render rewrites the highlighted markup through
 *  dangerouslySetInnerHTML, which destroys and rebuilds every text node inside
 *  the block. Any live selection pointing into them dies with them — and it
 *  dies SILENTLY: addRange on a stale Range collapses rather than throwing, so
 *  the restore in ChatPane's mouseup path cannot even detect it, and its catch
 *  never fires. Selecting code to copy it was therefore impossible, while the
 *  same drag over prose worked, because prose text nodes are reconciled in
 *  place instead of replaced.
 *
 *  Streaming still updates the block: the text changes, so the compare fails
 *  and it re-renders, as it should. */
const CodeBlock = memo(function CodeBlock({ children }: { children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const className: string = fenceClassOf(children);
  const lang = /language-([\w-]+)/.exec(className)?.[1]?.toLowerCase() ?? "";
  const label = LANGUAGE_NAMES[lang] ?? (lang ? lang.toUpperCase() : "Plain text");
  const text = extractText(children).replace(/\n$/, "");
  // Syntax colors (prism-tomorrow, already themed for the file viewer).
  const prismLang = FENCE_TO_PRISM[lang];
  const grammar = prismLang ? Prism.languages[prismLang] : undefined;
  // Every streaming delta re-renders the whole Markdown tree — only
  // re-tokenize when this block's text actually changed.
  const highlighted = useMemo(
    () => (grammar ? Prism.highlight(text, grammar, prismLang) : null),
    [text, grammar, prismLang],
  );

  return (
    <div
      style={{
        background: colors.panel,
        border: `1px solid ${colors.border}`,
        borderRadius: 10,
        margin: "12px 0",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "7px 12px",
          fontSize: 12,
          color: colors.dim,
        }}
      >
        <span>{label}</span>
        <button
          onClick={(ev) => {
            ev.stopPropagation();
            void navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          title="Copy code"
          aria-label="Copy code"
          style={{
            background: "transparent",
            border: "none",
            color: copied ? colors.ok : colors.dim,
            cursor: "pointer",
            padding: 2,
            display: "flex",
            alignItems: "center",
          }}
        >
          {copied ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
      </div>
      {highlighted !== null ? (
        <pre
          style={{
            margin: 0,
            padding: "2px 14px 12px",
            overflowX: "auto",
            fontFamily: "var(--font-code)",
            fontSize: 12.75,
            lineHeight: 1.65,
            color: "var(--code-fg)",
          }}
        >
          <code style={{ fontFamily: "inherit", fontSize: "inherit" }} dangerouslySetInnerHTML={{ __html: highlighted }} />
        </pre>
      ) : (
        <pre
          style={{
            margin: 0,
            padding: "2px 14px 12px",
            overflowX: "auto",
            fontFamily: "var(--font-code)",
            fontSize: 12.75,
            lineHeight: 1.65,
            color: "var(--code-fg)",
          }}
        >
          {children}
        </pre>
      )}
    </div>
  );
},
(prev, next) =>
  extractText(prev.children) === extractText(next.children) &&
  fenceClassOf(prev.children) === fenceClassOf(next.children));

const pillButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--fg)",
  fontSize: 12.5,
  padding: "7px 12px",
  cursor: "pointer",
  fontFamily: "inherit",
  whiteSpace: "nowrap",
};

/** Sidebar card offering the newer release. Click = download, verify, swap
 *  the app bundle, relaunch. Progress replaces the label in place so the
 *  card never changes size mid-update. */
/** The Model Context Protocol mark.
 *
 *  viewBox and stroke are fitted to sit beside the app's other line icons
 *  rather than taken from the official asset. Measured: the paths span
 *  25–167.8 x 22.9–199.3, so the box is centred on (96.4, 111.1) and sized so
 *  the inked height fills 86% of it — the paperclip fills ~90% of its 24 box,
 *  and the official 12/195 stroke read visibly lighter than the paperclip's
 *  1.7/24 (7.1%) next to it. 17/225 is 7.6%, which matches. Straight from the
 *  asset the mark was both smaller and thinner than every icon around it. */
/** Destructive confirm, in the same shape Settings → Resources uses: name the
 *  thing, say exactly what goes, and put the irreversible verb on the right.
 *  zIndex clears the panel that opened it — both panels sit at 100. */
function ConfirmRemove({
  title,
  detail,
  confirmLabel = "Remove",
  onCancel,
  onConfirm,
}: {
  title: string;
  detail: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", backdropFilter: "var(--scrim-blur)", WebkitBackdropFilter: "var(--scrim-blur)", display: "grid", placeItems: "center", zIndex: 110 }}
    >
      <div
        style={{
          width: 480, maxWidth: "calc(100vw - 48px)", background: colors.panel,
          border: `1px solid ${colors.border}`, borderRadius: 16,
          padding: "22px 24px 20px", boxShadow: "0 16px 48px rgba(0,0,0,0.55)",
          fontFamily: "var(--font-ui)",
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 600, color: colors.fg, overflowWrap: "anywhere" }}>{title}</div>
        <div style={{ color: colors.dim, fontSize: 14, lineHeight: 1.55, marginTop: 10 }}>{detail}</div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 22 }}>
          <button
            onClick={onCancel}
            style={{ background: "transparent", border: "none", color: colors.dim, fontSize: 14.5, cursor: "pointer", fontFamily: "inherit", padding: "9px 14px" }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{
              background: "rgba(240, 149, 149, 0.14)", border: "none", borderRadius: 10,
              color: colors.err, fontSize: 14.5, fontWeight: 500, cursor: "pointer",
              fontFamily: "inherit", padding: "9px 18px",
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** An icon-only destructive action. Labelled for screen readers and on hover,
 *  since the glyph alone carries the meaning. */
function IconDangerButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 30, height: 30, flexShrink: 0,
        background: hover && !disabled ? "rgba(240, 149, 149, 0.14)" : "transparent",
        border: "none", borderRadius: 999,
        color: disabled ? colors.dim : hover ? colors.err : colors.dim,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <TrashIcon />
    </button>
  );
}

function McpIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="-16 -1 225 225"
      fill="none"
      stroke="currentColor"
      strokeWidth="17"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M25 97.8528L92.8823 29.9706C102.255 20.598 117.451 20.598 126.823 29.9706C136.196 39.3431 136.196 54.5391 126.823 63.9117L75.5581 115.177" />
      <path d="M76.2652 114.47L126.823 63.9117C136.196 54.5391 151.392 54.5391 160.765 63.9117C170.137 73.2843 170.137 88.4802 160.765 97.8528L92.8823 165.735C87.2254 171.392 87.2254 180.564 92.8823 186.221L105.941 199.28" />
      <path d="M109.485 46.7157L58.2196 97.9812C48.8471 107.354 48.8471 122.55 58.2196 131.922C67.5922 141.295 82.7882 141.295 92.1608 131.922L143.426 80.6569" />
    </svg>
  );
}

/** Connected MCP servers, and the form for adding one.
 *
 *  Two lists on purpose. `connected` is what the running engine has; the
 *  supervisor reads the config file only at launch, so a server the user just
 *  added is configured but not yet connected. Collapsing the two would either
 *  hide a real server or claim a pending one is live. */
const WEEKDAY_ORDER: Weekday[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const WEEKDAY_LABEL: Record<Weekday, string> = {
  MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun",
};

/** "08:00" → "8:00 AM". The stored form stays 24-hour; only the reading of it
 *  is localised, which keeps the record and the schedule maths unambiguous. */
function clockLabel(time: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m) return time;
  const h = Number(m[1]);
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]} ${suffix}`;
}

function describeSchedule(s: ScheduleSpec): string {
  switch (s.type) {
    case "hourly": {
      const every = s.intervalHours === 1 ? "Every hour" : `Every ${s.intervalHours} hours`;
      return s.days?.length ? `${every} on ${s.days.map((d) => WEEKDAY_LABEL[d]).join(", ")}` : every;
    }
    case "daily":
      return `Daily at ${clockLabel(s.time)}`;
    case "weekdays":
      return `Weekdays at ${clockLabel(s.time)}`;
    case "weekly":
      return `${s.days.map((d) => WEEKDAY_LABEL[d]).join(", ")} at ${clockLabel(s.time)}`;
  }
}

/** Short relative stamp — "in 3h", "12m ago". Absolute times for a recurring
 *  task read as noise; what matters is how far off the next run is. */
function relativeTime(iso: string): string {
  const delta = new Date(iso).getTime() - Date.now();
  const ahead = delta >= 0;
  const mins = Math.round(Math.abs(delta) / 60_000);
  const text =
    mins < 1 ? "now" : mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  if (text === "now") return "now";
  return ahead ? `in ${text}` : `${text} ago`;
}

/** The three starters from the Codex task list, as one-click prefills. */
const TASK_TEMPLATES: { name: string; schedule: ScheduleSpec; prompt: string; blurb: string }[] = [
  {
    name: "Daily brief",
    schedule: { type: "weekdays", time: "08:00" },
    blurb: "Start each weekday with a summary of what changed and what needs attention",
    prompt:
      "Summarise what changed in this project since yesterday: recent commits, open branches with uncommitted work, and anything that looks unfinished. Keep it to a short list I can read in a minute.",
  },
  {
    name: "Weekly review",
    schedule: { type: "weekly", days: ["FR"], time: "16:00" },
    blurb: "Turn the week's work into a concise status update every Friday",
    prompt:
      "Review this week's commits and write a status update: what shipped, what is in progress, and what is blocked. Group it by theme rather than by commit.",
  },
  {
    name: "Follow-up monitor",
    schedule: { type: "weekdays", time: "09:00" },
    blurb: "Review recent activity and flag anything that needs a decision",
    prompt:
      "Look through the project for things waiting on me: TODO and FIXME comments added recently, failing checks, and stale branches. Flag only what genuinely needs a decision.",
  },
];

/**
 * Scheduled tasks — a whole-window route, like Settings.
 *
 * It started as a modal, matching MCP servers and Skills, and that was the
 * wrong read: those two are dialogs you open, adjust and dismiss, whereas this
 * has its own list, search, filters and creation flow. A modal frames all of
 * that as an interruption and caps it at 620px while the content wants a page.
 * The nav is not kept visible for the same reason Settings does not keep it —
 * you are somewhere else, and "← Back to app" is the way out.
 *
 * Still not built: describing a task in prose and having the agent derive the
 * schedule. That needs a model round-trip that can fail, and it is a feature
 * rather than a layout, so the starter templates carry the "begin without a
 * form" intent instead.
 */
type ConnectorInfo = {
  name: string;
  url: string;
  displayName: string;
  description: string;
  longDescription: string;
  developer: string | null;
  version: string | null;
  category: string;
  capabilities: string[];
  prompts: string[];
  brandColor: string | null;
  websiteUrl: string | null;
  privacyUrl: string | null;
  termsUrl: string | null;
  supportUrl: string | null;
  icon: string | null;
  redirectUri: string;
  clientId: string | null;
  enabled: boolean;
  requiresClientId: boolean;
  requiresSecret: boolean;
  scopes: string[];
  added: boolean;
  authStatus: string | null;
};

/** One labelled fact in a connector's Information table. Rendered only when
 *  there is something to say — an empty row reads as missing data rather than
 *  as a field this connector does not use. */
function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  if (children === null || children === undefined || children === "") return null;
  return (
    <div style={{ display: "flex", gap: 16, padding: "9px 0", borderTop: `1px solid ${colors.border}` }}>
      <span style={{ color: colors.dim, fontSize: 13.5, width: 130, flexShrink: 0 }}>{label}</span>
      <span style={{ color: colors.fg, fontSize: 13.5, minWidth: 0, wordBreak: "break-word" }}>{children}</span>
    </div>
  );
}

/**
 * The connector catalogue.
 *
 * Only the servers that support on-the-spot registration appear here, which is
 * what lets the consent screen say Unbiased rather than Codex. Connecting is
 * one action rather than three — add the server, claim our OAuth client, sign
 * in — because the intermediate states are ours to manage, not the user's to
 * understand.
 */
/**
 * The connectors modal, opened from the composer's + menu.
 *
 * Same shell as MCP and Skills — scrim, 18-radius card, inset group, pinned
 * footer — because it is the same kind of thing: a quick look at what Pareto
 * can reach, with one switch per row. Anything beyond switching (adding,
 * signing in, reading the detail) hands off to the full page rather than
 * growing a second, smaller version of it here.
 */
function ConnectorsPanel({ onClose, onOpenFull }: { onClose: () => void; onOpenFull: () => void }) {
  const [items, setItems] = useState<ConnectorInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShown(true), 10);
    return () => clearTimeout(t);
  }, []);

  const refresh = useCallback(async () => {
    const r = await window.unbiased.connectorsList();
    setItems((r.connectors ?? []).filter((c) => c.added));
    setLoading(false);
  }, []);
  useEffect(() => void refresh(), [refresh]);

  async function toggle(c: ConnectorInfo) {
    setNotice(null);
    setBusy(c.name);
    const res = await window.unbiased.connectorsSetEnabled(c.name, !c.enabled);
    setBusy(null);
    if (!res.ok) setNotice(res.error ?? "Could not change it.");
    void refresh();
  }

  const insetStyle: React.CSSProperties = {
    background: "var(--panel-2)",
    borderRadius: 14,
    padding: "4px 16px",
    marginTop: 16,
  };

  return (
    <div
      data-popover
      role="dialog"
      aria-modal="true"
      aria-labelledby="connectors-panel-title"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        backdropFilter: "var(--scrim-blur)",
        WebkitBackdropFilter: "var(--scrim-blur)",
        display: "grid",
        placeItems: "center",
        zIndex: 100,
        opacity: shown ? 1 : 0,
        transition: "opacity 180ms var(--ease-out)",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        data-popover
        style={{
          transform: shown ? "scale(1)" : "scale(0.98)",
          transition: "transform 180ms var(--ease-out)",
          background: colors.panel,
          border: `1px solid ${colors.border}`,
          borderRadius: 18,
          width: 560,
          maxWidth: "calc(100vw - 48px)",
          maxHeight: "calc(100vh - 96px)",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 24px 60px rgba(0,0,0,0.55)",
        }}
      >
        <div style={{ overflowY: "auto", padding: "26px 26px 4px" }}>
          <h2
            id="connectors-panel-title"
            style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 19, fontWeight: 600, letterSpacing: "var(--track-title)", margin: 0, color: colors.fg }}
          >
            <span style={{ color: colors.accent, display: "flex" }}>
              <PlugIcon />
            </span>
            Connectors
          </h2>
          <p style={{ color: colors.dim, fontSize: 14, lineHeight: 1.55, margin: "10px 0 0" }}>
            The services Pareto can reach. Turning one off leaves it signed in — it just stops
            offering its tools. This applies to every chat, not only this one.
          </p>

          {notice && (
            <div style={{ marginTop: 16, color: colors.amber, fontSize: 13.5, lineHeight: 1.5 }}>{notice}</div>
          )}

          {loading && <div style={{ color: colors.dim, fontSize: 14, marginTop: 18 }}>Loading…</div>}
          {!loading && items.length === 0 && (
            <div style={{ color: colors.dim, fontSize: 14, lineHeight: 1.55, marginTop: 18 }}>
              No connectors yet. Add one to let Pareto reach the tools you use.
            </div>
          )}

          {items.length > 0 && (
            <div style={insetStyle}>
              {items.map((c, i) => (
                <div
                  key={c.name}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    padding: "13px 0",
                    borderTop: i > 0 ? `1px solid ${colors.border}` : "none",
                  }}
                >
                  <span style={{ width: 26, height: 26, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", opacity: c.enabled ? 1 : 0.4 }}>
                    {c.icon ? (
                      <img src={c.icon} alt="" style={{ maxWidth: 26, maxHeight: 26 }} />
                    ) : (
                      <span style={{ color: colors.dim, fontSize: 14, fontWeight: 600 }}>{c.displayName.slice(0, 1)}</span>
                    )}
                  </span>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 14.5, fontWeight: 500, color: c.enabled ? colors.fg : colors.dim, letterSpacing: "var(--track-body)" }}>
                      {c.displayName}
                    </div>
                    <div style={{ fontSize: 13, color: colors.dim, marginTop: 3, lineHeight: 1.45, letterSpacing: "var(--track-meta)" }}>
                      {c.authStatus === "oAuth" ? "Signed in" : "Needs sign-in"}
                    </div>
                  </span>
                  {/* The same ring-with-a-tick the scheduled list uses for the
                      same job, so "on" reads identically in both places. */}
                  <button
                    onClick={() => void toggle(c)}
                    disabled={busy !== null}
                    aria-pressed={c.enabled}
                    title={c.enabled ? `Turn ${c.displayName} off` : `Turn ${c.displayName} on`}
                    style={{
                      width: 18,
                      height: 18,
                      flexShrink: 0,
                      display: "grid",
                      placeItems: "center",
                      borderRadius: "50%",
                      border: `1.5px solid ${c.enabled ? colors.accent : colors.border}`,
                      background: c.enabled ? colors.accent : "transparent",
                      color: "var(--accent-fg)",
                      cursor: "pointer",
                      padding: 0,
                    }}
                  >
                    {c.enabled && <CheckIcon size={11} />}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div
          style={{
            flexShrink: 0,
            display: "flex",
            justifyContent: "flex-end",
            gap: 12,
            padding: "16px 26px 22px",
            borderTop: `1px solid ${colors.border}`,
          }}
        >
          <button onClick={onClose} style={btnSecondaryStyle}>
            Close
          </button>
          <button
            onClick={() => {
              onClose();
              onOpenFull();
            }}
            style={btnPrimaryStyle}
          >
            <PlugIcon />
            Browse connectors
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The last list this session rendered, kept outside the component so leaving
 * the page and coming back shows it instantly. Re-mounting used to start from
 * an empty list and a "Loading…", even though the answer had not changed.
 */
let connectorsCache: ConnectorInfo[] = [];

function ConnectorsView({ navOpen, onToggleNav }: { navOpen: boolean; onToggleNav: () => void }) {
  const [items, setItems] = useState<ConnectorInfo[]>(connectorsCache);
  // Only the very first visit of a session has nothing to show.
  const [loading, setLoading] = useState(connectorsCache.length === 0);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openName, setOpenName] = useState<string | null>(null);
  const noticeRef = useRef<HTMLDivElement | null>(null);
  const [clientIdDraft, setClientIdDraft] = useState("");
  const [clientSecretDraft, setClientSecretDraft] = useState("");
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    const r = await window.unbiased.connectorsList();
    connectorsCache = r.connectors ?? [];
    setItems(connectorsCache);
    setLoading(false);
  }, []);
  useEffect(() => void refresh(), [refresh]);
  // The catalogue is fetched in the background now, so the page has to be told
  // when a refresh actually brought something new.
  useEffect(() => window.unbiased.onConnectorsChanged(() => void refresh()), [refresh]);
  // Sign-in finishes in the browser, so nothing in this window knows it
  // happened until the engine says so. Without this the card sits on
  // "Waiting…" after a successful approval.
  useEffect(
    () =>
      window.unbiased.onMcpLoginDone(({ name, success, error }) => {
        setBusy((cur) => (cur === name ? null : cur));
        if (!success) setNotice(`Sign-in did not complete. ${error ?? ""}`.trim());
        void refresh();
      }),
    [refresh],
  );

  async function connect(c: ConnectorInfo) {
    setNotice(null);
    setBusy(c.name);
    const res = await window.unbiased.connectorsConnect(c.name);
    setBusy(null);
    if (!res.ok) {
      setNotice(res.error ?? `Could not connect ${c.displayName}.`);
    } else if (res.signIn) {
      // Worth saying which name they are about to see: the whole point of the
      // registration step is invisible otherwise.
      setNotice(
        res.branded
          ? `Approve ${c.displayName} in your browser — it will ask on behalf of Unbiased.`
          : `Approve ${c.displayName} in your browser.`,
      );
    } else {
      setNotice(`${c.displayName} was added. Use Sign in under MCP servers to finish.`);
    }
    void refresh();
  }

  async function signIn(c: ConnectorInfo) {
    setNotice(null);
    setBusy(c.name);
    const res = await window.unbiased.mcpLogin(c.name);
    if (!res.ok) {
      setBusy(null);
      setNotice(res.error ?? `Could not start sign-in for ${c.displayName}.`);
      return;
    }
    setNotice(`Approve ${c.displayName} in your browser.`);
  }

  async function saveClientId(c: ConnectorInfo) {
    setNotice(null);
    setBusy(c.name);
    const res = await window.unbiased.connectorsSetClientId(c.name, clientIdDraft.trim(), clientSecretDraft.trim());
    setBusy(null);
    setNotice(res.ok ? `Saved. Sign in to ${c.displayName} to use it.` : (res.error ?? "Could not save it."));
    void refresh();
  }

  async function remove(c: ConnectorInfo) {
    setNotice(null);
    setBusy(c.name);
    const res = await window.unbiased.connectorsRemove(c.name);
    setBusy(null);
    if (!res.ok) setNotice(res.error ?? "Could not remove it.");
    void refresh();
  }

  // The notice lives at the top of a long scrolling page, so a failure raised
  // from a card three screens down was invisible — which is indistinguishable
  // from the button doing nothing. Reported as exactly that.
  useEffect(() => {
    if (notice) noticeRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [notice]);

  const open = openName ? (items.find((c) => c.name === openName) ?? null) : null;
  useEffect(() => {
    setClientIdDraft(open?.clientId ?? "");
    // The secret is never echoed back from the config — an empty field on a
    // saved connector means "unchanged", not "missing".
    setClientSecretDraft("");
    setCopied(false);
  }, [openName, open?.clientId]);

  const groups = Array.from(
    items.reduce((m, c) => {
      const list = m.get(c.category) ?? [];
      list.push(c);
      m.set(c.category, list);
      return m;
    }, new Map<string, ConnectorInfo[]>()),
  ).sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", height: "100%" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 16px",
          flexShrink: 0,
          position: "relative",
          zIndex: 2,
        }}
      >
        <HeaderEdge />
        <IconButton title={navOpen ? "Hide sidebar" : "Show sidebar"} onClick={onToggleNav}>
          <PanelIcon />
        </IconButton>
        <span style={{ fontSize: 14, fontWeight: 500, color: colors.fg, letterSpacing: "var(--track-body)" }}>
          Connectors
        </span>
      </header>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <div style={{ maxWidth: 760, margin: "0 auto", padding: "40px 24px 64px" }}>
          {open ? (
            <>
              {/* Breadcrumb rather than a back arrow: it names where "back"
                  goes, and doubles as the label for a page whose title is the
                  connector rather than the section. */}
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13.5, marginBottom: 26 }}>
                <button
                  onClick={() => setOpenName(null)}
                  data-nopress
                  style={{ background: "none", border: "none", padding: 0, color: colors.dim, fontSize: 13.5, cursor: "pointer", fontFamily: "inherit" }}
                >
                  Connectors
                </button>
                <span style={{ color: colors.dim, display: "flex" }}><MenuChevron /></span>
                <span style={{ color: colors.fg }}>{open.displayName}</span>
              </div>

              <div style={{ display: "flex", alignItems: "flex-start", gap: 18 }}>
                <span
                  style={{
                    width: 56,
                    height: 56,
                    flexShrink: 0,
                    borderRadius: 14,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    // A brand colour is a wash behind the mark, never the mark
                    // itself — several logos are already full-colour and would
                    // fight it.
                    background: open.brandColor
                      ? `color-mix(in srgb, ${open.brandColor} 18%, transparent)`
                      : "var(--panel-2)",
                  }}
                >
                  {open.icon ? (
                    <img src={open.icon} alt="" style={{ maxWidth: 34, maxHeight: 34 }} />
                  ) : (
                    <span style={{ color: colors.dim, fontSize: 22, fontWeight: 600 }}>{open.displayName.slice(0, 1)}</span>
                  )}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h1 style={{ fontSize: 26, fontWeight: 600, letterSpacing: "var(--track-title)", lineHeight: 1.2, margin: 0, color: colors.fg }}>
                    {open.displayName}
                  </h1>
                  <p style={{ color: colors.dim, fontSize: 14.5, lineHeight: 1.5, margin: "6px 0 0" }}>{open.description}</p>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, marginTop: 4 }}>
                  {open.added ? (
                    <>
                      {open.authStatus !== "oAuth" && (
                        <button className="u-chip" onClick={() => void signIn(open)} disabled={busy !== null} style={btnSmallStyle}>
                          {busy === open.name ? "Waiting…" : "Sign in"}
                        </button>
                      )}
                      <button className="u-chip" onClick={() => void remove(open)} disabled={busy === open.name} style={btnSmallStyle}>
                        {busy === open.name ? "Working…" : "Remove"}
                      </button>
                    </>
                  ) : open.requiresClientId && !open.clientId ? null : (
                    <button className="u-chip" onClick={() => void connect(open)} disabled={busy !== null} style={btnSmallStyle}>
                      {busy === open.name ? "Connecting…" : "Connect"}
                    </button>
                  )}
                </div>
              </div>

              {open.added && open.authStatus === "oAuth" && (
                <div style={{ marginTop: 14, fontSize: 12.5, fontWeight: 500, color: colors.ok }}>Connected</div>
              )}

              {open.prompts.length > 0 && (
                <div style={{ marginTop: 28, display: "flex", flexDirection: "column", gap: 8 }}>
                  {open.prompts.map((q) => (
                    <div
                      key={q}
                      style={{
                        background: "var(--panel-2)",
                        borderRadius: 12,
                        padding: "12px 14px",
                        color: colors.fg,
                        fontSize: 13.5,
                        lineHeight: 1.5,
                        display: "flex",
                        gap: 10,
                      }}
                    >
                      <span style={{ color: colors.dim, flexShrink: 0 }}>{open.displayName}</span>
                      <span style={{ minWidth: 0 }}>{q}</span>
                    </div>
                  ))}
                </div>
              )}

              {open.longDescription && (
                <p style={{ color: colors.dim, fontSize: 14.5, lineHeight: 1.6, margin: "28px 0 0", maxWidth: "62ch" }}>
                  {open.longDescription}
                </p>
              )}

              {/* The escape hatch for a provider that will not register us
                  automatically. The callback is shown rather than described
                  because it is unguessable, and one wrong character fails at
                  the authorize step with an error that names nothing useful. */}
              <h2 style={{ fontSize: 17, fontWeight: 600, letterSpacing: "var(--track-title)", margin: "34px 0 6px", color: colors.fg }}>
                Use your own OAuth app
              </h2>
              <p style={{ color: colors.dim, fontSize: 13.5, lineHeight: 1.55, margin: "0 0 14px", maxWidth: "62ch" }}>
                {open.requiresClientId
                  ? `${open.displayName} offers no automatic sign-up, so this is the required setup, not an override: register an application with them, give it this exact callback URL, paste its client ID here, then sign in.`
                  : "Most connectors register Unbiased with the provider for you. Where that is not offered, register an application yourself, give it this exact callback URL, and paste its client ID here."}
              </p>
              <label style={{ color: colors.dim, fontSize: 13, display: "block", marginBottom: 6 }}>Callback URL</label>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14 }}>
                <code
                  style={{
                    flex: 1,
                    minWidth: 0,
                    background: "var(--panel-2)",
                    border: `1px solid ${colors.border}`,
                    borderRadius: 10,
                    padding: "10px 12px",
                    fontSize: 12.5,
                    fontFamily: "var(--font-code)",
                    color: colors.fg,
                    overflowX: "auto",
                    whiteSpace: "nowrap",
                  }}
                >
                  {open.redirectUri}
                </code>
                <button
                  className="u-chip"
                  style={btnSmallStyle}
                  onClick={() => {
                    void navigator.clipboard.writeText(open.redirectUri);
                    setCopied(true);
                  }}
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              {open.requiresSecret && (
                <>
                  <label htmlFor="cn-secret" style={{ color: colors.dim, fontSize: 13, display: "block", marginBottom: 6 }}>
                    Client secret
                  </label>
                  <input
                    id="cn-secret"
                    className="u-field"
                    type="password"
                    value={clientSecretDraft}
                    onChange={(e) => setClientSecretDraft(e.target.value)}
                    placeholder={open.clientId ? "Saved — enter again only to change it" : "GOCSPX-…"}
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      background: "var(--panel-2)",
                      color: colors.fg,
                      border: `1px solid ${colors.border}`,
                      borderRadius: 10,
                      padding: "10px 12px",
                      fontSize: 13.5,
                      fontFamily: "var(--font-ui)",
                      outline: "none",
                      marginBottom: 14,
                    }}
                  />
                </>
              )}
              <label htmlFor="cn-clientid" style={{ color: colors.dim, fontSize: 13, display: "block", marginBottom: 6 }}>
                Client ID
              </label>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  id="cn-clientid"
                  className="u-field"
                  value={clientIdDraft}
                  onChange={(e) => setClientIdDraft(e.target.value)}
                  placeholder="Leave empty to go back to automatic sign-up"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    boxSizing: "border-box",
                    background: "var(--panel-2)",
                    color: colors.fg,
                    border: `1px solid ${colors.border}`,
                    borderRadius: 10,
                    padding: "10px 12px",
                    fontSize: 13.5,
                    fontFamily: "var(--font-ui)",
                    outline: "none",
                  }}
                />
                <button
                  className="u-chip"
                  style={btnSmallStyle}
                  disabled={busy !== null || clientIdDraft.trim() === (open.clientId ?? "")}
                  onClick={() => void saveClientId(open)}
                >
                  {busy === open.name ? "Saving…" : "Save"}
                </button>
              </div>

              <h2 style={{ fontSize: 17, fontWeight: 600, letterSpacing: "var(--track-title)", margin: "34px 0 4px", color: colors.fg }}>
                Information
              </h2>
              <div>
                <InfoRow label="Capabilities">{open.capabilities.join(", ")}</InfoRow>
                <InfoRow label="Developer">{open.developer}</InfoRow>
                <InfoRow label="Category">{open.category}</InfoRow>
                <InfoRow label="Version">{open.version}</InfoRow>
                <InfoRow label="Server">{open.url}</InfoRow>
                {([["Website", open.websiteUrl], ["Privacy Policy", open.privacyUrl], ["Terms of Service", open.termsUrl], ["Support", open.supportUrl]] as const).map(
                  ([label, href]) =>
                    href ? (
                      <InfoRow key={label} label={label}>
                        <a
                          href={href}
                          onClick={(e) => {
                            e.preventDefault();
                            void window.unbiased.openExternal(href);
                          }}
                          style={{ color: colors.accent, textDecoration: "none" }}
                        >
                          {href.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                        </a>
                      </InfoRow>
                    ) : null,
                )}
              </div>
            </>
          ) : (
          <>
          <h1
            style={{
              fontSize: 30,
              fontWeight: 600,
              letterSpacing: "var(--track-title)",
              lineHeight: 1.15,
              margin: 0,
              color: colors.fg,
            }}
          >
            Connectors
          </h1>
          <p style={{ color: colors.dim, fontSize: 14.5, lineHeight: 1.55, margin: "10px 0 0", maxWidth: "58ch" }}>
            Give Pareto access to the tools you already use. Connecting opens that service in
            your browser to ask your permission — it asks as Unbiased, and you can revoke it
            there at any time.
          </p>

          {notice && (
            <div
              ref={noticeRef}
              style={{
                marginTop: 18,
                background: "var(--panel-2)",
                borderLeft: `2px solid ${colors.accent}`,
                borderRadius: 10,
                padding: "10px 12px",
                color: colors.fg,
                fontSize: 13.5,
                lineHeight: 1.5,
              }}
            >
              {notice}
            </div>
          )}

          {loading && <div style={{ color: colors.dim, fontSize: 14, marginTop: 24 }}>Loading…</div>}
          {!loading && items.length === 0 && (
            <div style={{ color: colors.dim, fontSize: 14, lineHeight: 1.55, marginTop: 24 }}>
              No connectors are available. The catalogue ships with the engine, so this usually
              means it has not finished starting.
            </div>
          )}

          {groups.map(([category, list]) => (
            <div key={category} style={{ marginTop: 30 }}>
              <div
                style={{
                  color: colors.dim,
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "var(--track-overline)",
                  marginBottom: 10,
                }}
              >
                {category}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(232px, 1fr))", gap: 12 }}>
                {list.map((c) => {
                  const signedIn = c.added && c.authStatus === "oAuth";
                  return (
                    <div
                      key={c.name}
                      role="button"
                      tabIndex={0}
                      onClick={() => setOpenName(c.name)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setOpenName(c.name);
                        }
                      }}
                      style={{
                        background: "var(--panel-2)",
                        borderRadius: 14,
                        padding: 14,
                        display: "flex",
                        flexDirection: "column",
                        gap: 10,
                        minWidth: 0,
                        cursor: "pointer",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                        <span
                          style={{
                            width: 28,
                            height: 28,
                            flexShrink: 0,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          {c.icon ? (
                            <img src={c.icon} alt="" style={{ maxWidth: 28, maxHeight: 28 }} />
                          ) : (
                            <span style={{ color: colors.dim, fontSize: 15, fontWeight: 600 }}>
                              {c.displayName.slice(0, 1)}
                            </span>
                          )}
                        </span>
                        <span
                          style={{
                            fontSize: 14.5,
                            fontWeight: 500,
                            color: colors.fg,
                            letterSpacing: "var(--track-body)",
                            minWidth: 0,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {c.displayName}
                        </span>
                      </div>
                      <div style={{ color: colors.dim, fontSize: 13, lineHeight: 1.45, flex: 1 }}>
                        {c.description}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }} onClick={(e) => e.stopPropagation()}>
                        {c.added ? (
                          <>
                            {/* Only the connected state is stated. "Needs
                                sign-in" sat beside a button labelled Sign in,
                                so it said nothing the button did not — and at
                                card width it wrapped to two lines and squeezed
                                the actions. The spacer keeps them right-aligned
                                either way. */}
                            {signedIn ? (
                              <span style={{ color: colors.ok, fontSize: 12.5, fontWeight: 500, flex: 1 }}>Connected</span>
                            ) : (
                              <span style={{ flex: 1 }} />
                            )}
                            {/* A card can land here whenever the sign-in did
                                not finish — the browser was closed, consent was
                                declined, a token expired. Saying "Needs
                                sign-in" while offering only Remove left the one
                                state the user can act on with no way to act. */}
                            {!signedIn && (
                              <button
                                className="u-chip"
                                onClick={() => void signIn(c)}
                                disabled={busy !== null}
                                style={{ ...btnSmallStyle, fontSize: 12.5, padding: "5px 12px" }}
                              >
                                {busy === c.name ? "Waiting…" : "Sign in"}
                              </button>
                            )}
                            <button
                              className="u-chip"
                              onClick={() => void remove(c)}
                              disabled={busy === c.name}
                              style={{ ...btnSmallStyle, fontSize: 12.5, padding: "5px 12px" }}
                            >
                              {busy === c.name ? "Working…" : "Remove"}
                            </button>
                          </>
                        ) : c.requiresClientId && !c.clientId ? (
                          // No client id yet, and the provider offers no
                          // automatic sign-up — Connect would only fail. The
                          // detail page holds the callback URL and the field.
                          <button
                            className="u-chip"
                            onClick={() => setOpenName(c.name)}
                            style={{ ...btnSmallStyle, fontSize: 12.5, padding: "5px 12px" }}
                          >
                            Set up…
                          </button>
                        ) : (
                          <button
                            className="u-chip"
                            onClick={() => void connect(c)}
                            disabled={busy !== null}
                            style={{ ...btnSmallStyle, fontSize: 12.5, padding: "5px 12px", opacity: busy && busy !== c.name ? 0.45 : 1 }}
                          >
                            {busy === c.name ? "Connecting…" : "Connect"}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          </>
          )}
        </div>
      </div>
    </div>
  );
}

function ScheduledView({
  defaultProject,
  projects,
  onOpenThread,
  navOpen,
  onToggleNav,
  focusKey,
  onFocusHandled,
}: {
  defaultProject: string | null;
  projects: ProjectInfo[];
  onOpenThread: (threadId: string) => void;
  navOpen: boolean;
  onToggleNav: () => void;
  focusKey?: string | null;
  onFocusHandled?: () => void;
}) {
  const [tasks, setTasks] = useState<ScheduledTaskView[]>([]);
  const [engineReady, setEngineReady] = useState(true);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "paused">("all");
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  // `editing` is the key being edited, "" for a new task, null when closed.
  const [editing, setEditing] = useState<string | null>(null);
  const [fName, setFName] = useState("");
  const [fPrompt, setFPrompt] = useState("");
  const [fType, setFType] = useState<ScheduleSpec["type"]>("weekdays");
  const [fTime, setFTime] = useState("08:00");
  const [fDays, setFDays] = useState<Weekday[]>(["MO"]);
  const [fInterval, setFInterval] = useState(3);
  const [fProject, setFProject] = useState<string | null>(defaultProject);
  const [formError, setFormError] = useState<string | null>(null);
  // "Edit with Pareto": screenshots in, a rewritten prompt out — shown beside
  // the current one, never applied without an explicit Accept.
  const [tuneOpen, setTuneOpen] = useState(false);
  const [tuneImages, setTuneImages] = useState<Attachment[]>([]);
  const [tuneNote, setTuneNote] = useState("");
  const [tuning, setTuning] = useState(false);
  const [tuneProposal, setTuneProposal] = useState<string | null>(null);
  const [tuneError, setTuneError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void window.unbiased.scheduledList().then((r) => {
      setTasks(r.tasks ?? []);
      setEngineReady(r.engineReady);
      setLoading(false);
    });
  }, []);
  useEffect(refresh, [refresh]);
  // A tick firing or a run finishing while this page is open should land
  // without a manual refresh — it is the only signal that a task ran.
  useEffect(() => window.unbiased.onScheduledUpdated((p) => setTasks(p.tasks ?? [])), []);
  useEffect(
    () =>
      window.unbiased.onScheduledRunState(({ key, running }) =>
        setTasks((ts) => ts.map((t) => (t.key === key ? { ...t, running } : t))),
      ),
    [],
  );
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // One layer at a time — and it stops at the view. Escape used to leave
      // the whole page, which made sense while this was a modal; now it is a
      // destination like any conversation, and no conversation closes itself
      // on Escape.
      if (confirmDelete) setConfirmDelete(null);
      else if (editing !== null) closeForm();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Arriving from a "View task" link: scroll the row into view and mark it
  // long enough to be found. The mark is temporary on purpose — it answers
  // "which one did it just make", and after that it is an ordinary row.
  const focusRef = useRef<HTMLDivElement | null>(null);
  const [marked, setMarked] = useState<string | null>(null);
  useEffect(() => {
    if (!focusKey || loading) return;
    if (!tasks.some((t) => t.key === focusKey)) return;
    setFilter("all");
    setQuery("");
    setMarked(focusKey);
    focusRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    onFocusHandled?.();
    const id = setTimeout(() => setMarked(null), 2600);
    return () => clearTimeout(id);
  }, [focusKey, loading, tasks, onFocusHandled]);

  function closeForm() {
    setEditing(null);
    setFormError(null);
    // The tuning panel belongs to the form it was opened in — leaving it
    // armed would show one task's screenshots on the next task's form.
    setTuneOpen(false);
    setTuneImages([]);
    setTuneNote("");
    setTuneProposal(null);
    setTuneError(null);
  }

  function openNew(template?: (typeof TASK_TEMPLATES)[number]) {
    setEditing("");
    setFName(template?.name ?? "");
    setFPrompt(template?.prompt ?? "");
    const s = template?.schedule;
    setFType(s?.type ?? "weekdays");
    setFTime(s && "time" in s ? s.time : "08:00");
    setFDays(s && s.type === "weekly" ? s.days : ["MO"]);
    setFInterval(s && s.type === "hourly" ? s.intervalHours : 3);
    setFProject(defaultProject);
    setFormError(null);
  }

  function openEdit(t: ScheduledTaskView) {
    setEditing(t.key);
    setFName(t.name);
    setFPrompt(t.prompt);
    setFType(t.schedule.type);
    setFTime("time" in t.schedule ? t.schedule.time : "08:00");
    setFDays(t.schedule.type === "weekly" ? t.schedule.days : ["MO"]);
    setFInterval(t.schedule.type === "hourly" ? t.schedule.intervalHours : 3);
    setFProject(t.projectPath);
    setFormError(null);
  }

  function buildSchedule(): ScheduleSpec {
    if (fType === "hourly") return { type: "hourly", intervalHours: fInterval };
    if (fType === "weekly") return { type: "weekly", days: fDays, time: fTime };
    return { type: fType, time: fTime };
  }

  async function save() {
    const res = await window.unbiased.scheduledSave({
      key: editing || null,
      name: fName,
      prompt: fPrompt,
      schedule: buildSchedule(),
      projectPath: fProject,
    });
    if (!res.ok) {
      setFormError(res.error ?? "Could not save.");
      return;
    }
    if (res.tasks) setTasks(res.tasks);
    closeForm();
    setNotice(null);
  }

  async function runNow(key: string) {
    setNotice(null);
    const res = await window.unbiased.scheduledRunNow(key);
    if (!res.ok) setNotice(res.error ?? "The run failed.");
  }

  const q = query.trim().toLowerCase();
  const filtered = tasks
    .filter((t) => (filter === "all" ? true : filter === "active" ? t.enabled : !t.enabled))
    .filter((t) => (q ? `${t.name} ${t.prompt}`.toLowerCase().includes(q) : true));
  // A template already taken by an existing task is not a suggestion any more.
  const taken = new Set(tasks.map((t) => t.name.toLowerCase()));
  const suggestions = TASK_TEMPLATES.filter((t) => !taken.has(t.name.toLowerCase()));

  const inputStyle: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    minWidth: 0,
    background: "var(--panel-2)",
    color: colors.fg,
    border: `1px solid ${colors.border}`,
    borderRadius: 10,
    padding: "10px 12px",
    fontSize: 13.5,
    fontFamily: "var(--font-ui)",
    letterSpacing: "var(--track-body)",
    outline: "none",
  };
  const labelStyle: React.CSSProperties = {
    color: colors.dim,
    fontSize: 13,
    lineHeight: 1.4,
    marginBottom: 6,
    display: "block",
  };
  // The app's own button vocabulary, not a third one invented here: row
  // actions take the small chip pill that MCP and Skills use for the same job,
  // and the main action takes the tinted primary pill.
  const ghostButton = btnSmallStyle;
  const primaryButton = btnPrimaryStyle;

  return (
    // minHeight: 0 is load-bearing. Without it this flex item's min-height is
    // "auto" — its content size — so any page taller than the window grew the
    // whole view past the 100vh root instead of letting the scroll container
    // inside it scroll, and everything below the fold painted on the bare
    // white body. Measured live: a 950px window, this div at 1084px.
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
      {/* The same chrome a conversation gets — sidebar toggle, then the title
          — so this reads as another place in the app rather than a mode you
          have been dropped into. No back button: the nav is right there, and
          a chat does not have one either. */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 16px",
          flexShrink: 0,
          position: "relative",
          zIndex: 2,
        }}
      >
        <HeaderEdge />
        <IconButton title={navOpen ? "Hide sidebar" : "Show sidebar"} onClick={onToggleNav}>
          <PanelIcon />
        </IconButton>
        <span
          style={{
            fontSize: 14,
            fontWeight: 500,
            color: colors.fg,
            letterSpacing: "var(--track-body)",
          }}
        >
          Scheduled
        </span>
      </header>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {/* One centred measure for the whole page — the list, the search and
            the form all share it, so nothing needs its own width. */}
        <div style={{ maxWidth: 760, margin: "0 auto", padding: "40px 24px 64px" }}>
          {/* The action belongs beside what it acts on. In the toolbar it sat
              at the far edge of the window while the list it adds to lives in
              a 760px column — a control placed that far from its subject stops
              reading as related to it. On the title row it is the page's
              primary action, and it aligns with everything below it. */}
          <div style={{ display: "flex", alignItems: "flex-start", gap: 24 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h1
                style={{
                  fontSize: 30,
                  fontWeight: 600,
                  letterSpacing: "var(--track-title)",
                  lineHeight: 1.15,
                  margin: 0,
                  color: colors.fg,
                }}
              >
                Scheduled tasks
              </h1>
              <p
                style={{
                  color: colors.dim,
                  fontSize: 14.5,
                  lineHeight: 1.55,
                  margin: "10px 0 0",
                  maxWidth: "58ch",
                }}
              >
                Ask Pareto to run something on a schedule — a morning brief, a weekly
                review, a watch on work in progress. Tasks read files without changing
                them and can drive the signed-in Agent browser, so they can act on sites
                you are logged into. They run only while Unbiased is open; anything that
                came due while it was closed runs once when you next open it.
              </p>
            </div>
            {editing === null && (
              <button
                onClick={() => openNew()}
                // Nudged down so the button's centre sits on the title's
                // cap-height rather than its ascender line.
                style={{ ...primaryButton, flexShrink: 0, marginTop: 2 }}
              >
                <PlusIcon />
                New task
              </button>
            )}
          </div>

          {!engineReady && (
            <div
              style={{
                marginTop: 18,
                background: "var(--panel-2)",
                borderLeft: `2px solid ${colors.amber}`,
                borderRadius: 10,
                padding: "10px 12px",
                color: colors.dim,
                fontSize: 13,
                lineHeight: 1.5,
              }}
            >
              The engine isn't running, so nothing will fire. Sign in to arm these.
            </div>
          )}

          {editing !== null ? (
            <div style={{ marginTop: 28, maxWidth: 520 }}>
              <div
                style={{
                  fontSize: 17,
                  fontWeight: 600,
                  color: colors.fg,
                  letterSpacing: "var(--track-title)",
                  marginBottom: 16,
                }}
              >
                {editing ? "Edit task" : "New task"}
              </div>

              <label style={labelStyle} htmlFor="st-name">Name</label>
              <input
                id="st-name"
                className="u-field"
                value={fName}
                onChange={(e) => setFName(e.target.value)}
                placeholder="Daily brief"
                style={inputStyle}
              />

              <label style={{ ...labelStyle, marginTop: 14 }} htmlFor="st-prompt">
                What should Pareto do?
              </label>
              <textarea
                id="st-prompt"
                className="u-field"
                value={fPrompt}
                onChange={(e) => setFPrompt(e.target.value)}
                rows={5}
                placeholder="Summarise what changed in this project since yesterday…"
                style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }}
              />
              {/* Screenshot-grounded prompt tuning. Born from a measured
                  failure: a run flailed for ten minutes because its prompt
                  described intent ("set the status") with no idea what the
                  screen looks like. Screenshots become exact labels and a
                  give-up rule. */}
              {!tuneOpen && (
                <button
                  className="u-chip"
                  onClick={() => {
                    setTuneOpen(true);
                    setTuneError(null);
                  }}
                  disabled={!fPrompt.trim()}
                  style={{ ...btnSmallStyle, marginTop: 8, opacity: fPrompt.trim() ? 1 : 0.45 }}
                  title={fPrompt.trim() ? "Refine these instructions with screenshots" : "Write a draft first"}
                >
                  Edit with Pareto
                </button>
              )}
              {tuneOpen && tuneProposal === null && (
                <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const paths = Array.from(e.dataTransfer.files)
                      .map((f) => window.unbiased.pathForDroppedFile(f))
                      .filter(Boolean);
                    if (!paths.length) return;
                    void window.unbiased.attachPaths(paths).then((res) => {
                      const imgs = (res.attachments ?? []).filter((a) => a.kind === "image");
                      setTuneImages((list) => {
                        const seen = new Set(list.map((a) => a.path));
                        return [...list, ...imgs.filter((a) => !seen.has(a.path))].slice(0, 4);
                      });
                    });
                  }}
                  onPaste={(e) => {
                    if (!e.clipboardData?.types.includes("Files")) return;
                    e.preventDefault();
                    void window.unbiased.clipboardImage().then(({ attachment }) => {
                      if (attachment) setTuneImages((list) => [...list, attachment].slice(0, 4));
                    });
                  }}
                  style={{
                    marginTop: 10,
                    background: "var(--panel-2)",
                    borderRadius: 12,
                    padding: 14,
                  }}
                >
                  <div style={{ color: colors.fg, fontSize: 13.5, fontWeight: 500 }}>Refine with Pareto</div>
                  <div style={{ color: colors.dim, fontSize: 12.5, lineHeight: 1.5, marginTop: 4 }}>
                    Drop or paste screenshots of the exact screens this task works in — Pareto
                    rewrites the instructions around what is actually there, and adds a rule to
                    stop instead of flailing. You review the result before anything changes.
                  </div>
                  {tuneImages.length > 0 && (
                    <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                      {tuneImages.map((a) => (
                        <span
                          key={a.path}
                          style={{ position: "relative", width: 64, height: 44, borderRadius: 8, overflow: "hidden", background: "var(--chip)" }}
                        >
                          {a.thumb && <img src={a.thumb} alt={a.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                          <button
                            aria-label={`Remove ${a.name}`}
                            onClick={() => setTuneImages((l) => l.filter((x) => x.path !== a.path))}
                            style={{
                              position: "absolute",
                              top: 2,
                              right: 2,
                              width: 16,
                              height: 16,
                              borderRadius: 8,
                              border: "none",
                              background: "rgba(0,0,0,0.6)",
                              color: "#fff",
                              fontSize: 10,
                              lineHeight: "16px",
                              padding: 0,
                              cursor: "pointer",
                            }}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <input
                    className="u-field"
                    value={tuneNote}
                    onChange={(e) => setTuneNote(e.target.value)}
                    placeholder="Anything Pareto should know — e.g. the status dialog is behind the avatar menu"
                    style={{ ...inputStyle, marginTop: 10 }}
                  />
                  {tuneError && (
                    <div style={{ color: colors.err, fontSize: 12.5, lineHeight: 1.5, marginTop: 8 }}>{tuneError}</div>
                  )}
                  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <button
                      className="u-chip"
                      disabled={tuning || (tuneImages.length === 0 && !tuneNote.trim())}
                      onClick={() => {
                        setTuning(true);
                        setTuneError(null);
                        void window.unbiased
                          .scheduledTune({ prompt: fPrompt, note: tuneNote.trim(), images: tuneImages.map((a) => a.path) })
                          .then((r) => {
                            setTuning(false);
                            if (r.ok && r.proposal) setTuneProposal(r.proposal);
                            else setTuneError(r.error ?? "The rewrite failed.");
                          });
                      }}
                      style={btnSmallStyle}
                    >
                      {tuning ? "Rewriting…" : "Propose rewrite"}
                    </button>
                    <button
                      className="u-chip"
                      disabled={tuning}
                      onClick={() => {
                        setTuneOpen(false);
                        setTuneImages([]);
                        setTuneNote("");
                        setTuneError(null);
                      }}
                      style={btnSmallStyle}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {tuneProposal !== null && (
                <div style={{ marginTop: 10 }}>
                  {/* Old and new side by side, because Accept rewrites a prompt
                      the user tuned by hand — they should see exactly what
                      they are trading before it happens. */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    {(
                      [
                        ["Current", fPrompt],
                        ["Proposed", tuneProposal],
                      ] as const
                    ).map(([label, text]) => (
                      <div key={label} style={{ minWidth: 0 }}>
                        <div
                          style={{
                            color: label === "Proposed" ? colors.accent : colors.dim,
                            fontSize: 11,
                            fontWeight: 600,
                            textTransform: "uppercase",
                            letterSpacing: "var(--track-overline)",
                            marginBottom: 6,
                          }}
                        >
                          {label}
                        </div>
                        <div
                          style={{
                            background: "var(--panel-2)",
                            borderRadius: 12,
                            padding: 12,
                            fontSize: 12.5,
                            lineHeight: 1.55,
                            color: label === "Proposed" ? colors.fg : colors.dim,
                            whiteSpace: "pre-wrap",
                            maxHeight: 320,
                            overflowY: "auto",
                            wordBreak: "break-word",
                          }}
                        >
                          {text}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                    <button
                      className="u-chip"
                      onClick={() => {
                        setFPrompt(tuneProposal);
                        setTuneProposal(null);
                        setTuneOpen(false);
                        setTuneImages([]);
                        setTuneNote("");
                      }}
                      style={{ ...btnSmallStyle, color: colors.accent }}
                    >
                      Use proposed
                    </button>
                    <button
                      className="u-chip"
                      onClick={() => setTuneProposal(null)}
                      style={btnSmallStyle}
                    >
                      Back
                    </button>
                    <button
                      className="u-chip"
                      onClick={() => {
                        setTuneProposal(null);
                        setTuneOpen(false);
                        setTuneImages([]);
                        setTuneNote("");
                      }}
                      style={btnSmallStyle}
                    >
                      Discard
                    </button>
                  </div>
                </div>
              )}

              <label style={{ ...labelStyle, marginTop: 14 }} htmlFor="st-type">Repeat</label>
              <FieldSelect
                id="st-type"
                value={fType}
                onChange={(v) => setFType(v as ScheduleSpec["type"])}
                triggerStyle={{ ...inputStyle, paddingRight: 34 }}
                options={[
                  { value: "daily", label: "Every day" },
                  { value: "weekdays", label: "Weekdays (Mon–Fri)" },
                  { value: "weekly", label: "Certain days" },
                  { value: "hourly", label: "Every few hours" },
                ]}
              />

              {fType === "hourly" ? (
                <>
                  <label style={{ ...labelStyle, marginTop: 14 }} htmlFor="st-interval">
                    Hours between runs
                  </label>
                  <input
                    id="st-interval"
                    className="u-field"
                    type="number"
                    min={1}
                    max={24}
                    value={fInterval}
                    onChange={(e) => setFInterval(Number(e.target.value))}
                    style={inputStyle}
                  />
                </>
              ) : (
                <>
                  <label style={{ ...labelStyle, marginTop: 14 }} htmlFor="st-time">Time</label>
                  <FieldTime id="st-time" value={fTime} onChange={setFTime} style={inputStyle} />
                </>
              )}

              {fType === "weekly" && (
                <>
                  <span style={{ ...labelStyle, marginTop: 14 }}>Days</span>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {WEEKDAY_ORDER.map((d) => {
                      const on = fDays.includes(d);
                      return (
                        <button
                          key={d}
                          aria-pressed={on}
                          onClick={() => setFDays((cur) => (on ? cur.filter((x) => x !== d) : [...cur, d]))}
                          style={{
                            background: on ? colors.accent : "transparent",
                            color: on ? "var(--accent-fg)" : "var(--fg-soft)",
                            border: `1px solid ${on ? colors.accent : colors.border}`,
                            borderRadius: 8,
                            padding: "6px 10px",
                            fontSize: 12.5,
                            cursor: "pointer",
                            fontFamily: "inherit",
                          }}
                        >
                          {WEEKDAY_LABEL[d]}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}

              {/* Where the run reads from, as a control rather than an
                  announcement. It used to be a line of text stating whichever
                  project the chat happened to sit in, which is the wrong shape
                  twice over: a schedule outlives the conversation that created
                  it, so inheriting silently is surprising, and a task aimed at
                  a different repo had no way to say so from here. The inherited
                  project is still the default — it is usually right — it just
                  shows as a chosen value that can be changed. */}
              <label style={{ ...labelStyle, marginTop: 14 }} htmlFor="st-project">Project</label>
              <FieldSelect
                id="st-project"
                value={fProject ?? ""}
                onChange={(v) => setFProject(v || null)}
                triggerStyle={{ ...inputStyle, paddingRight: 34 }}
                options={[
                  { value: "", label: "None — nothing on disk is needed" },
                  ...projects.map((p) => ({ value: p.path, label: p.name })),
                  // A project the task still points at but which has left the
                  // sidebar stays listed, or the select would silently reset it
                  // to None on the next save.
                  ...(fProject && !projects.some((p) => p.path === fProject)
                    ? [{ value: fProject, label: fProject }]
                    : []),
                ]}
              />


              {formError && (
                <div style={{ color: colors.err, fontSize: 13, lineHeight: 1.5, marginTop: 12 }}>{formError}</div>
              )}

              <div style={{ display: "flex", gap: 10, marginTop: 22 }}>
                <button onClick={() => void save()} style={primaryButton}>
                  {editing ? "Save changes" : "Create task"}
                </button>
                <button onClick={closeForm} style={btnSecondaryStyle}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search scheduled tasks"
                aria-label="Search scheduled tasks"
                style={{ ...inputStyle, marginTop: 24, borderRadius: 999, padding: "11px 16px" }}
              />

              {/* Filters only earn their place once there is something to
                  filter; below that they are three controls over one row. */}
              {tasks.length > 1 && (
                <div style={{ display: "flex", gap: 4, marginTop: 18 }}>
                  {(["all", "active", "paused"] as const).map((f) => {
                    const on = filter === f;
                    const label = f === "all" ? "All" : f === "active" ? "Active" : "Paused";
                    return (
                      <button
                        key={f}
                        onClick={() => setFilter(f)}
                        aria-pressed={on}
                        style={{
                          background: on ? "var(--chip)" : "transparent",
                          color: on ? colors.fg : colors.dim,
                          border: "none",
                          borderRadius: 8,
                          padding: "6px 12px",
                          fontSize: 13.5,
                          fontWeight: on ? 500 : 400,
                          cursor: "pointer",
                          fontFamily: "inherit",
                        }}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              )}

              {notice && (
                <div style={{ color: colors.err, fontSize: 13, lineHeight: 1.5, marginTop: 16 }}>{notice}</div>
              )}

              {loading && <div style={{ color: colors.dim, fontSize: 14, marginTop: 20 }}>Loading…</div>}

              {!loading && filtered.length === 0 && (
                <div style={{ color: colors.dim, fontSize: 14, lineHeight: 1.55, marginTop: 24 }}>
                  {tasks.length === 0
                    ? "Nothing scheduled yet. Start from a suggestion below, or create a task."
                    : q
                      ? `Nothing matches “${query.trim()}”.`
                      : `No ${filter} tasks.`}
                </div>
              )}

              {filtered.length > 0 && (
                <div style={{ marginTop: 22 }}>
                  {filtered.map((t) => {
                    const show = hovered === t.key || confirmDelete === t.key;
                    return (
                      <div
                        key={t.key}
                        ref={t.key === focusKey || t.key === marked ? focusRef : undefined}
                        onMouseEnter={() => setHovered(t.key)}
                        onMouseLeave={() => setHovered(null)}
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: 12,
                          padding: "14px 0",
                          borderBottom: `1px solid ${colors.border}`,
                          ...(t.key === marked
                            ? {
                                // Same selected language as the sidebar rows:
                                // neutral fill, accent only in the rail.
                                background: "var(--chip)",
                                boxShadow: "inset 2px 0 0 0 var(--accent)",
                                paddingLeft: 10,
                              }
                            : null),
                          transition: "background 400ms var(--ease-out)",
                        }}
                      >
                        {/* The ring IS the switch — pausing is the most common
                            thing you do to a task. A tick says "armed" the way
                            a bare fill cannot: a solid dot reads as a status
                            light (something is happening now), which is wrong
                            for a task that is merely scheduled. Empty ring for
                            paused, so the pair reads as checked/unchecked. */}
                        <button
                          onClick={() =>
                            void window.unbiased
                              .scheduledSetEnabled(t.key, !t.enabled)
                              .then((r) => setTasks(r.tasks ?? []))
                          }
                          aria-pressed={t.enabled}
                          title={t.enabled ? "Pause this task" : "Resume this task"}
                          style={{
                            marginTop: 1,
                            width: 18,
                            height: 18,
                            flexShrink: 0,
                            display: "grid",
                            placeItems: "center",
                            borderRadius: "50%",
                            border: `1.5px solid ${t.enabled ? colors.accent : colors.border}`,
                            background: t.enabled ? colors.accent : "transparent",
                            color: "var(--accent-fg)",
                            cursor: "pointer",
                            padding: 0,
                          }}
                        >
                          {t.enabled && <CheckIcon size={11} />}
                        </button>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            style={{
                              fontSize: 14.5,
                              fontWeight: 500,
                              color: t.enabled ? colors.fg : colors.dim,
                              letterSpacing: "var(--track-body)",
                            }}
                          >
                            {t.name}
                          </div>
                          <div
                            style={{
                              color: colors.dim,
                              fontSize: 13,
                              lineHeight: 1.5,
                              marginTop: 3,
                              letterSpacing: "var(--track-meta)",
                            }}
                          >
                            {describeSchedule(t.schedule)}
                            {t.running
                              ? " · running now"
                              : t.missedAt
                                ? ` · missed ${relativeTime(t.missedAt)}`
                                : !t.enabled
                                  ? " · paused"
                                  : t.nextDueAt
                                    ? ` · next run ${relativeTime(t.nextDueAt)}`
                                    : ""}
                          </div>
                          {t.lastRunAt && (
                            <div style={{ fontSize: 12.5, lineHeight: 1.5, marginTop: 3 }}>
                              {(() => {
                                // Three states, not two. "Succeeded" is now
                                // claimed only when the agent says the work
                                // got done — a clean turn that reported "Slack
                                // status was not updated" used to read as a
                                // success, which is the one thing a status
                                // line must never do.
                                const done = t.lastStatus === "completed" && t.lastVerdict === "done";
                                const reportedFail = t.lastStatus === "completed" && t.lastVerdict === "failed";
                                const label = done
                                  ? "Last run succeeded"
                                  : reportedFail
                                    ? "Last run failed"
                                    : t.lastStatus === "completed"
                                      ? "Last run finished"
                                      : `Last run ${t.lastStatus}`;
                                const color = done ? colors.ok : t.lastStatus === "completed" && !reportedFail ? colors.dim : colors.err;
                                return <span style={{ color }}>{label}</span>;
                              })()}
                              <span style={{ color: colors.dim }}> · {relativeTime(t.lastRunAt)}</span>
                              {(t.lastVerdictNote || t.lastError) && (
                                <span style={{ color: colors.dim }}> · {t.lastVerdictNote ?? t.lastError}</span>
                              )}
                            </div>
                          )}
                        </div>

                        {/* Revealed on hover, and on focus-within too — a
                            hover-only control is invisible to the keyboard. */}
                        <div
                          style={{
                            display: "flex",
                            gap: 8,
                            flexShrink: 0,
                            opacity: show ? 1 : 0,
                            transition: "opacity 120ms var(--ease-out)",
                          }}
                          onFocus={() => setHovered(t.key)}
                        >
                          {confirmDelete === t.key ? (
                            <>
                              <span style={{ color: colors.dim, fontSize: 12.5, alignSelf: "center" }}>Delete?</span>
                              <button
                                onClick={() =>
                                  void window.unbiased.scheduledDelete(t.key).then((r) => {
                                    setTasks(r.tasks ?? []);
                                    setConfirmDelete(null);
                                  })
                                }
                                style={{ ...ghostButton, color: colors.err, background: "color-mix(in srgb, #F09595 16%, transparent)" }}
                              >
                                Delete
                              </button>
                              <button onClick={() => setConfirmDelete(null)} style={ghostButton}>Keep</button>
                            </>
                          ) : (
                            <>
                              {/* While a run is in flight the useful action is
                                  stopping it, not starting another. Offering a
                                  greyed-out "Run now" and nothing else left the
                                  only live thing in the list unreachable. */}
                              {t.running ? (
                                <button
                                  onClick={() =>
                                    void window.unbiased.scheduledStop(t.key).then((r) => {
                                      if (!r.ok) setNotice(r.error ?? "Could not stop the run.");
                                    })
                                  }
                                  style={{ ...ghostButton, color: colors.amber }}
                                >
                                  Stop
                                </button>
                              ) : (
                                <button
                                  onClick={() => void runNow(t.key)}
                                  disabled={!engineReady}
                                  style={{
                                    ...ghostButton,
                                    cursor: engineReady ? "pointer" : "default",
                                    opacity: engineReady ? 1 : 0.5,
                                  }}
                                >
                                  {t.missedAt ? "Run missed now" : "Run now"}
                                </button>
                              )}
                              {/* The live conversation while running, the
                                  previous one otherwise — one button, because
                                  "open the run" is one intention. */}
                              {(t.runningThreadId ?? t.lastThreadId) && (
                                <button
                                  onClick={() => onOpenThread((t.runningThreadId ?? t.lastThreadId)!)}
                                  style={ghostButton}
                                >
                                  {t.runningThreadId ? "Open run" : "Open last run"}
                                </button>
                              )}
                              <button onClick={() => openEdit(t)} style={ghostButton}>Edit</button>
                              <button onClick={() => setConfirmDelete(t.key)} style={ghostButton}>Delete</button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {!loading && suggestions.length > 0 && (
                <div style={{ marginTop: 38 }}>
                  <SectionLabel>Suggestions</SectionLabel>
                  <div style={{ marginTop: 4 }}>
                    {suggestions.map((t) => (
                      <button
                        key={t.name}
                        onClick={() => openNew(t)}
                        data-nopress
                        style={{
                          display: "block",
                          width: "100%",
                          textAlign: "left",
                          background: "transparent",
                          border: "none",
                          borderBottom: `1px solid ${colors.border}`,
                          padding: "13px 0",
                          cursor: "pointer",
                          fontFamily: "inherit",
                        }}
                      >
                        <span style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                          <span
                            style={{
                              color: colors.fg,
                              fontSize: 14.5,
                              fontWeight: 500,
                              letterSpacing: "var(--track-body)",
                            }}
                          >
                            {t.name}
                          </span>
                          <span style={{ color: colors.dim, fontSize: 13, letterSpacing: "var(--track-meta)" }}>
                            {describeSchedule(t.schedule)}
                          </span>
                        </span>
                        <span
                          style={{
                            display: "block",
                            color: colors.dim,
                            fontSize: 13,
                            lineHeight: 1.5,
                            marginTop: 3,
                          }}
                        >
                          {t.blurb}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** A data: image URI an MCP server advertised, if it is one we are willing to
 *  render.
 *
 *  This is third-party content — whatever the server chose to send — so it is
 *  filtered rather than trusted. Raster types only: an SVG cannot execute
 *  script inside an <img>, but it can carry external references and arbitrary
 *  markup, and there is no reason to accept one for a 20px favicon. The length
 *  cap keeps a server from parking megabytes of base64 in the panel.
 *
 *  Remote (https) icon sources are ignored on purpose: the renderer's CSP is
 *  `img-src 'self' data:`, so they would silently fail to load anyway, and
 *  routing them through main would turn opening this panel into an outbound
 *  request per server. */
const MCP_ICON_MAX = 512_000;
function mcpIconSrc(info: McpConnected["serverInfo"]): string | null {
  for (const icon of info?.icons ?? []) {
    const src = typeof icon?.src === "string" ? icon.src : "";
    if (!/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(src)) continue;
    if (src.length > MCP_ICON_MAX) continue;
    return src;
  }
  return null;
}

/** The server's own mark: an app tile, sized like one.
 *
 *  It was a 22px chip with a status dot pinned to its corner, which made the
 *  icon a detail of the badge rather than the identity of the row. Status is
 *  now stated in words on the meta line, which frees the mark to be the size
 *  its content deserves and removes a colour-only signal at the same time.
 *
 *  Falls back to a monogram rather than nothing, so every row has a left
 *  column of the same width and the titles stay aligned. */
function McpServerMark({ info, name }: { info: McpConnected["serverInfo"]; name: string }) {
  const src = mcpIconSrc(info);
  const host = info?.websiteUrl ? linkHost(info.websiteUrl) : null;
  // One column width for every row, so titles line up whichever branch runs.
  // flex, not grid. A grid with no explicit tracks sizes its implicit row to
  // CONTENT, so a 76px-tall icon made a 76px track inside a 40px box and
  // height:100% resolved against the track — overflow:hidden then clipped the
  // bottom off. It only became visible once the icons were cropped tight;
  // before that the padding kept the mark inside the clipped area.
  const tile: React.CSSProperties = {
    width: 40,
    height: 40,
    borderRadius: 10,
    flexShrink: 0,
    overflow: "hidden",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };
  // Chrome only for the fallbacks. A real logo is its own mark and needs no
  // container; a favicon or a letter needs something to sit in.
  const framed: React.CSSProperties = {
    ...tile,
    background: "var(--panel-2)",
    border: `1px solid ${colors.border}`,
  };
  if (src) {
    return (
      <span style={tile}>
        {/* Fills the box rather than sitting inside it. These marks are not
            square — Figma's is 128x160 — and with object-fit: contain the
            HEIGHT is the constraint, so a 26px square box rendered a 26px-tall
            glyph only ~21px wide, inside a 38px tile. Dropping the tile
            padding and letting the image take the full 40 is what actually
            makes it read at the size the row implies. */}
        {/* max-* rather than width/height 100%: the image sizes itself and is
            simply not allowed to exceed the box, so no aspect ratio can
            overflow it regardless of how the icon was authored. */}
        <img
          src={src}
          alt=""
          style={{ maxWidth: "100%", maxHeight: "100%", width: "auto", height: "auto", display: "block" }}
        />
      </span>
    );
  }
  if (host) {
    return (
      <span style={framed}>
        <Favicon host={host} />
      </span>
    );
  }
  return (
    <span style={{ ...framed, color: colors.dim, fontSize: 16, fontWeight: 600 }}>
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

function McpPanel({ onClose }: { onClose: () => void }) {
  const [connected, setConnected] = useState<McpConnected[]>([]);
  const [configured, setConfigured] = useState<McpServerConfig[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [applying, setApplying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ name: string; connected: boolean } | null>(null);
  // Entry transition. A modal is an occasional, deliberate interruption, so it
  // earns motion where the + menu did not — but it is still under the 300ms
  // ceiling, and it scales from its own centre rather than from a trigger:
  // a modal is not anchored to anything, so origin-awareness does not apply.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Form state
  const [fName, setFName] = useState("");
  const [fRemote, setFRemote] = useState(false);
  const [fCommand, setFCommand] = useState("");
  const [fArgs, setFArgs] = useState("");
  const [fUrl, setFUrl] = useState("");
  const [fToken, setFToken] = useState("");
  const [fEnv, setFEnv] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void window.unbiased.mcpList().then((r) => {
      setConnected(r.connected ?? []);
      setConfigured(r.configured ?? []);
      setLoadError(r.error);
      setConfigError(r.configError);
      setLoading(false);
    });
  }, []);
  useEffect(refresh, [refresh]);
  // A server starting or failing while the panel is open should be visible
  // without a manual refresh — this is the only signal that a server died.
  useEffect(() => window.unbiased.onMcpStatus(() => refresh()), [refresh]);
  // The browser hands back to a loopback port the engine listens on, so the
  // only signal the app gets is this notification — hence a "Waiting…" state
  // rather than a spinner tied to the IPC call, which returns the moment the
  // browser opens.
  useEffect(
    () =>
      window.unbiased.onMcpLoginDone(({ name, success, error }) => {
        setSigningIn((cur) => (cur === name ? null : cur));
        setNotice(success ? `Signed in to ${name}.` : `Could not sign in to ${name}. ${error ?? ""}`.trim());
        void refresh();
      }),
    [refresh],
  );

  async function signIn(name: string) {
    setNotice(null);
    setSigningIn(name);
    const res = await window.unbiased.mcpLogin(name);
    if (!res.ok) {
      setSigningIn(null);
      setNotice(res.error ?? "Could not start sign-in.");
    }
  }

  const connectedNames = new Set(connected.map((c) => c.name.toLowerCase()));
  const pending = configured.filter((c) => !connectedNames.has(c.name.toLowerCase()));

  function resetForm() {
    setFName(""); setFRemote(false); setFCommand(""); setFArgs("");
    setFUrl(""); setFToken(""); setFEnv(""); setFormError(null);
  }

  async function saveNew() {
    const env: Record<string, string> = {};
    for (const line of fEnv.split("\n").map((l) => l.trim()).filter(Boolean)) {
      const eq = line.indexOf("=");
      if (eq <= 0) { setFormError(`"${line}" should be written as NAME=value.`); return; }
      env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    const srv: McpServerConfig = fRemote
      ? { name: fName.trim(), url: fUrl.trim(), ...(fToken.trim() ? { bearerTokenEnvVar: fToken.trim() } : {}) }
      : {
          name: fName.trim(),
          command: fCommand.trim(),
          ...(fArgs.trim() ? { args: fArgs.trim().split(/\s+/) } : {}),
          ...(Object.keys(env).length ? { env } : {}),
        };
    const next = [...configured, srv];
    const res = await window.unbiased.mcpSave(next);
    if (!res.ok) { setFormError(res.error ?? "Could not save."); return; }
    setConfigured(next);
    setAdding(false);
    resetForm();
    setNotice("Saved. Restart the engine to connect it.");
  }

  async function removeServer(name: string) {
    const next = configured.filter((c) => c.name !== name);
    const res = await window.unbiased.mcpSave(next);
    if (!res.ok) { setNotice(res.error ?? "Could not save."); return; }
    setConfigured(next);
    setNotice("Removed. Restart the engine to apply.");
  }

  async function apply() {
    setApplying(true);
    const res = await window.unbiased.mcpApply();
    setApplying(false);
    if (!res.ok && res.busy) { setNotice("The conversation is still working — try again once it finishes."); return; }
    setNotice(null);
    refresh();
  }

  const inputStyle: React.CSSProperties = {
    width: "100%",
    // box-sizing: form controls get border-box from the UA sheet, but this app
    // has no global reset (it is set per-element, as in LoginView), so state it
    // rather than inherit it by luck.
    boxSizing: "border-box",
    // THE fix for the off-centre form. These fields sit inside a flex column,
    // and a flex item defaults to min-width:auto — which for an input is its
    // intrinsic ~20-character width, NOT zero. On a window narrow enough that
    // the card is 92vw rather than 560px, the fields refused to shrink, spilled
    // past the content box, and swallowed the padding on the right while the
    // left stayed put. min-width:0 lets them track the container instead.
    minWidth: 0,
    background: "var(--panel-2)",
    color: colors.fg,
    border: `1px solid ${colors.border}`,
    borderRadius: 10,
    padding: "10px 12px",
    fontSize: 13.5,
    fontFamily: "var(--font-ui)",
    outline: "none",
  };
  const labelStyle: React.CSSProperties = { color: colors.dim, fontSize: 13, lineHeight: 1.4, marginBottom: 6, display: "block" };
  // Borrowed wholesale from the Full Access disclosure so the two read as the
  // same kind of dialog: the inset panel-2 group, the 999 pills, and its type
  // scale (19 title / 14 body / 14.5 row title / 13.5 row detail).
  const insetStyle: React.CSSProperties = {
    background: "var(--panel-2)",
    borderRadius: 14,
    padding: "4px 16px",
    marginTop: 16,
  };
  const btnSecondary = btnSecondaryStyle;
  const btnPrimary = btnPrimaryStyle;
  const btnSmall = btnSmallStyle;

  return (
    <div
      data-popover
      role="dialog"
      aria-modal="true"
      aria-labelledby="mcp-panel-title"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        backdropFilter: "var(--scrim-blur)",
        WebkitBackdropFilter: "var(--scrim-blur)",
        display: "grid",
        placeItems: "center",
        zIndex: 100,
        opacity: shown ? 1 : 0,
        transition: "opacity 180ms var(--ease-out)",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        // The card carries the transform, so it is the element the
        // reduced-motion rule has to reach — on the scrim it would have
        // suppressed a fade that was never the vestibular part.
        data-popover
        style={{
          transform: shown ? "scale(1)" : "scale(0.98)",
          transition: "transform 180ms var(--ease-out)",
          background: colors.panel,
          border: `1px solid ${colors.border}`,
          // Matching the Full Access disclosure: 18 radius, 560 wide, the
          // heavier 0.55 shadow.
          borderRadius: 18,
          width: 560,
          maxWidth: "calc(100vw - 48px)",
          boxSizing: "border-box",
          // That dialog is short enough never to scroll; this one grows with
          // the server list and the form, so it needs a cap. The 6px scrollbar
          // (index.html styles it, so it takes layout space rather than
          // overlaying) sits outside padding-right, flush to the border — hence
          // 20 + 6 = 26, matching the 26 on the left. `stable` reserves the
          // gutter even when the content fits, so the padding does not jump as
          // servers are added and removed.
          // Only the middle scrolls; the footer stays put. With several servers
          // and the add form open, the buttons were below the fold.
          maxHeight: "84vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 16px 48px rgba(0,0,0,0.55)",
          fontFamily: "var(--font-ui)",
        }}
      >
        <div style={{ padding: "24px 26px 0", flexShrink: 0 }}>
        <div
          id="mcp-panel-title"
          style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 19, fontWeight: 600, color: colors.fg, letterSpacing: "var(--track-title)" }}
        >
          <span style={{ color: colors.accent, display: "flex" }}><McpIcon size={18} /></span>
          MCP servers
        </div>
        <p style={{ color: colors.dim, fontSize: 14, lineHeight: 1.55, margin: "12px 0 0" }}>
          Model Context Protocol servers give Pareto extra tools. Some are a program
          Pareto runs; others already listen on a URL — including apps on this
          machine, like Figma's Dev Mode server.
        </p>
        </div>

        {/* minHeight:0 or a flex child refuses to shrink and the scroll never
            engages. */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 20px 4px 26px", scrollbarGutter: "stable" }}>

        {loading && (
          <div style={{ color: colors.dim, fontSize: 14, lineHeight: 1.55, marginTop: 16 }}>Loading…</div>
        )}

        {!loading && connected.length === 0 && pending.length === 0 && (
          <div style={{ color: colors.dim, fontSize: 14, lineHeight: 1.55, marginTop: 16 }}>
            No MCP servers yet.
          </div>
        )}

        {/* One inset group holding every server, the way the disclosure groups
            its capabilities — rather than rows floating on the card. */}
        {(connected.length > 0 || pending.length > 0) && (
          <div style={insetStyle}>
            {[
              ...connected.map((srv) => {
                const toolCount = Object.keys(srv.tools ?? {}).length;
                return {
                  key: srv.name,
                  dot: colors.ok,
                  status: "Connected",
                  title: srv.serverInfo?.title || srv.name,
                  detail:
                    `${toolCount} ${toolCount === 1 ? "tool" : "tools"}` +
                    (srv.serverInfo?.version ? ` · v${srv.serverInfo.version}` : "") +
                    // Deliberately no authStatus here. It rendered the raw
                    // engine enum — "notLoggedIn" — in a row of prose, and the
                    // one state a user can act on now carries a Sign in button
                    // that says it in words.
                    "",
                  removable: configured.some((c) => c.name === srv.name),
                  name: srv.name,
                  info: srv.serverInfo,
                  needsAuth: srv.authStatus === "notLoggedIn",
                };
              }),
              ...pending.map((srv) => ({
                key: `pending-${srv.name}`,
                dot: colors.amber,
                status: "Not connected",
                title: srv.name,
                detail: "restart the engine to connect",
                removable: true,
                name: srv.name,
                // Nothing to show yet: icons arrive at initialize, and a
                // pending server has not connected.
                info: null as McpConnected["serverInfo"],
                needsAuth: false,
              })),
            ].map((row, i) => (
              <div
                key={row.key}
                style={{
                  display: "flex",
                  // center, not flex-start: the mark is a 40px block sitting
                  // beside a two-line stack, so top-aligning it leaves it
                  // visibly low against the pair.
                  alignItems: "center",
                  gap: 14,
                  padding: "13px 0",
                  borderTop: i > 0 ? `1px solid ${colors.border}` : "none",
                }}
              >
                <McpServerMark info={row.info} name={row.name} />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 14.5, fontWeight: 500, color: colors.fg, letterSpacing: "var(--track-body)" }}>
                    {row.title}
                  </div>
                  <div
                    style={{
                      fontSize: 13,
                      color: colors.dim,
                      marginTop: 3,
                      lineHeight: 1.45,
                      letterSpacing: "var(--track-meta)",
                    }}
                  >
                    {/* Said, not signalled. A coloured dot alone is a
                        colour-only distinction, and it was the one thing in
                        the row you could not read. */}
                    <span style={{ color: row.dot, fontWeight: 500 }}>{row.status}</span>
                    {row.detail ? ` · ${row.detail}` : ""}
                  </div>
                </span>
                {/* A server that connected but has not been signed into is
                    the one row where "Connected" is misleading — it has no
                    tools and cannot get any. Without this button the only
                    instruction available was the engine's own, which names a
                    CLI this app does not ship. */}
                {row.needsAuth && (
                  <button
                    onClick={() => void signIn(row.name)}
                    disabled={signingIn === row.name}
                    className="u-chip"
                    style={{ ...btnSmall, flexShrink: 0 }}
                  >
                    {signingIn === row.name ? "Waiting…" : "Sign in"}
                  </button>
                )}
                {row.removable && (
                  <IconDangerButton
                    label={`Remove ${row.name}`}
                    onClick={() => setConfirm({ name: row.name, connected: row.dot === colors.ok })}
                  />
                )}
              </div>
            ))}
          </div>
        )}

        {configError && (
          <div style={{ color: colors.err, fontSize: 13.5, lineHeight: 1.5, marginTop: 16 }}>
            {configError}
          </div>
        )}
        {loadError && (
          <div style={{ color: colors.dim, fontSize: 13.5, lineHeight: 1.5, marginTop: 16 }}>
            The engine did not answer, so only your saved list is shown. {loadError}
          </div>
        )}

        {/* Keyed on there BEING pending servers, not on having saved one in
            this session: a server added last time the panel was open would
            otherwise sit amber forever with no way to connect it. */}
        {(notice || pending.length > 0) && (
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16, color: colors.amber, fontSize: 13.5, lineHeight: 1.5 }}>
            <span style={{ flex: 1 }}>
              {notice ??
                `${pending.length} ${pending.length === 1 ? "server is" : "servers are"} waiting for a restart to connect.`}
            </span>
            <button onClick={() => void apply()} disabled={applying} className="u-chip" style={{ ...btnSmall, flexShrink: 0 }}>
              {applying ? "Restarting…" : "Restart engine"}
            </button>
          </div>
        )}

        {confirm && (
          <ConfirmRemove
            title={`Remove ${confirm.name}?`}
            detail={
              confirm.connected
                ? "This takes the server out of your configuration. Its tools stay available to the current conversation until the engine restarts, and nothing on the server itself is touched."
                : "This takes the server out of your configuration. Nothing on the server itself is touched."
            }
            onCancel={() => setConfirm(null)}
            onConfirm={() => { const n = confirm.name; setConfirm(null); void removeServer(n); }}
          />
        )}

        {!adding ? null : (
          <div style={{ marginTop: 20, borderTop: `1px solid ${colors.border}`, paddingTop: 18, display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <label style={labelStyle}>Name</label>
              <input value={fName} onChange={(e) => setFName(e.target.value)} placeholder="my-server" style={inputStyle} />
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              {([[false, "Runs a program"], [true, "Listens on a URL"]] as const).map(([remote, label]) => (
                <button
                  key={label}
                  onClick={() => setFRemote(remote)}
                  style={fRemote === remote ? { ...btnPrimary, padding: "8px 16px", fontSize: 13.5 } : { ...btnSecondary, padding: "8px 16px", fontSize: 13.5 }}
                >
                  {label}
                </button>
              ))}
            </div>
            {fRemote ? (
              <>
                <div>
                  <label style={labelStyle}>URL</label>
                  <input value={fUrl} onChange={(e) => setFUrl(e.target.value)} placeholder="http://127.0.0.1:3845/mcp" style={inputStyle} />
                  <div style={{ color: colors.dim, fontSize: 13, lineHeight: 1.45, marginTop: 6 }}>
                    https anywhere, or http for a server on this machine.
                  </div>
                </div>
                <div>
                  <label style={labelStyle}>Environment variable holding the bearer token (optional)</label>
                  <input value={fToken} onChange={(e) => setFToken(e.target.value)} placeholder="MY_MCP_TOKEN" style={inputStyle} />
                  <div style={{ color: colors.dim, fontSize: 13, lineHeight: 1.45, marginTop: 6 }}>
                    The variable's name is stored, never its value.
                  </div>
                </div>
              </>
            ) : (
              <>
                <div>
                  <label style={labelStyle}>Command</label>
                  <input value={fCommand} onChange={(e) => setFCommand(e.target.value)} placeholder="npx" style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>Arguments</label>
                  <input value={fArgs} onChange={(e) => setFArgs(e.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem" style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>Environment (one NAME=value per line)</label>
                  <textarea value={fEnv} onChange={(e) => setFEnv(e.target.value)} rows={3} placeholder={"API_TOKEN=abc123"} style={{ ...inputStyle, resize: "vertical" }} />
                  <div style={{ color: colors.dim, fontSize: 13, lineHeight: 1.45, marginTop: 6 }}>
                    The server sees only these plus HOME, PATH, SHELL, USER and TMPDIR — not your Unbiased key.
                  </div>
                </div>
              </>
            )}
            {formError && <div style={{ color: colors.err, fontSize: 13.5, lineHeight: 1.5 }}>{formError}</div>}
          </div>
        )}
        </div>

        {/* Pinned, with the action that matters for the current mode. */}
        <div
          style={{
            flexShrink: 0, display: "flex", justifyContent: "flex-end", gap: 12,
            padding: "16px 26px 22px", borderTop: `1px solid ${colors.border}`,
          }}
        >
          {adding ? (
            <>
              <button onClick={() => { setAdding(false); resetForm(); }} style={btnSecondary}>Cancel</button>
              <button onClick={() => void saveNew()} style={btnPrimary}>Save</button>
            </>
          ) : (
            <>
              <button onClick={onClose} style={btnSecondary}>Close</button>
              <button onClick={() => setAdding(true)} style={btnPrimary}>
                <McpIcon size={15} />
                Add custom MCP
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SkillIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2.5l2.6 5.9 6.4.6-4.8 4.3 1.4 6.2L12 16.3l-5.6 3.2 1.4-6.2L3 9l6.4-.6z" />
    </svg>
  );
}

/** Skills, in the two buckets a person actually thinks in: this project, and
 *  everywhere. Provenance is kept as a small tag on the row rather than its own
 *  section — a skill sitting in ~/.agents/skills came from another tool
 *  entirely, and that is worth knowing without turning the panel into a
 *  filesystem tour. */
function SkillsPanel({ cwd, onClose }: { cwd: string | null; onClose: () => void }) {
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [roots, setRoots] = useState<{ bundled: string; global: string; project: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<SkillEntry | null>(null);

  // Add flow
  const [adding, setAdding] = useState(false);
  const [scope, setScope] = useState<"project" | "global">(cwd ? "project" : "global");
  const [picked, setPicked] = useState<string | null>(null);
  const [check, setCheck] = useState<SkillCheck | null>(null);
  const [url, setUrl] = useState("");
  const [fetching, setFetching] = useState(false);
  const [limits, setLimits] = useState<{ label: string; maxFiles: number } | null>(null);
  const [name, setName] = useState("");
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(() => {
    void window.unbiased.skillsList(cwd).then((r) => {
      setSkills(r.skills ?? []);
      setRoots(r.roots);
      setError(r.error);
      setLoading(false);
    });
  }, [cwd]);
  useEffect(refresh, [refresh]);
  useEffect(() => {
    void window.unbiased.skillsLimits().then((l) => setLimits({ label: l.label, maxFiles: l.maxFiles }));
  }, []);

  function resetAdd() {
    setAdding(false); setPicked(null); setCheck(null); setName("");
    setDragging(false); setUrl(""); setFetching(false); setScope(cwd ? "project" : "global");
  }

  function accept(r: SkillCheck) {
    setCheck(r);
    if (r.ok) {
      // The staged copy is what gets installed: for a zip or a link the source
      // is the unpacked folder, not what the user pointed at.
      if (r.path) setPicked(r.path);
      if (r.name) setName(r.name);
    }
  }

  async function fetchFromUrl() {
    if (!url.trim()) return;
    setFetching(true);
    const r = await window.unbiased.skillsFetch(url.trim());
    setFetching(false);
    accept(r);
  }

  async function validate(path: string) {
    setPicked(path);
    accept(await window.unbiased.skillsValidate(path));
  }

  async function choose() {
    const r = await window.unbiased.skillsChoose();
    if (r.path) await validate(r.path);
  }

  async function save() {
    if (!picked) return;
    setSaving(true);
    const r = await window.unbiased.skillsInstall({ path: picked, name: name.trim(), scope, cwd });
    setSaving(false);
    if (!r.ok) { setCheck({ ok: false, error: r.error }); return; }
    resetAdd();
    refresh();
  }

  async function toggle(sk: SkillEntry) {
    setBusy(sk.path);
    const r = await window.unbiased.skillsSetEnabled(sk.path, !sk.enabled);
    setBusy(null);
    if (!r.ok) { setError(r.error ?? "Could not change that skill."); return; }
    refresh();
  }

  async function remove(sk: SkillEntry) {
    setBusy(sk.path);
    const r = await window.unbiased.skillsRemove(sk.path, cwd);
    setBusy(null);
    if (!r.ok) { setError(r.error ?? "Could not remove that skill."); return; }
    refresh();
  }

  // Two buckets. Project = found in this conversation's folder. Everything
  // else is available everywhere, whoever put it there.
  const g = roots;
  const inProject = (sk: SkillEntry) => !!g?.project && sk.path.startsWith(g.project);
  const ours = (sk: SkillEntry) =>
    (!!g?.global && sk.path.startsWith(g.global)) || inProject(sk);
  const tagFor = (sk: SkillEntry): string | null => {
    if (ours(sk)) return null;
    if (g?.bundled && sk.path.startsWith(g.bundled)) return "included";
    if (sk.scope === "system") return "built in";
    return "another tool";
  };
  const project = skills.filter(inProject);
  const global = skills.filter((sk) => !inProject(sk));

  const inset: React.CSSProperties = { background: "var(--panel-2)", borderRadius: 14, padding: "4px 16px", marginTop: 10 };
  const btnSecondary = btnSecondaryStyle;
  const btnPrimary = btnPrimaryStyle;
  const btnSmall = btnSmallStyle;
  const inputStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", minWidth: 0, background: "var(--panel-2)",
    color: colors.fg, border: `1px solid ${colors.border}`, borderRadius: 10,
    padding: "10px 12px", fontSize: 13.5, fontFamily: "var(--font-ui)", outline: "none",
  };
  // One label style for every field. The form previously had six text blocks at
  // near-identical size and weight, which reads as noise rather than structure.
  const fieldLabel: React.CSSProperties = {
    color: colors.dim, fontSize: 12.5, fontWeight: 500, lineHeight: 1.4, marginBottom: 7, display: "block",
  };
  const helpText: React.CSSProperties = { color: colors.dim, fontSize: 12, lineHeight: 1.45, marginTop: 6 };

  function Group({ title, items, empty }: { title: string; items: SkillEntry[]; empty: string }) {
    return (
      <div style={{ marginTop: 18 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: colors.fg }}>{title}</div>
        {items.length === 0 ? (
          <div style={{ ...inset, padding: "13px 16px", color: colors.dim, fontSize: 13.5, lineHeight: 1.45 }}>{empty}</div>
        ) : (
          <div style={inset}>
            {items.map((sk, i) => {
              const tag = tagFor(sk);
              return (
                <div key={sk.path} style={{ display: "flex", alignItems: "flex-start", gap: 14, padding: "13px 0", borderTop: i > 0 ? `1px solid ${colors.border}` : "none" }}>
                  <span style={{ minWidth: 0, flex: 1, opacity: sk.enabled ? 1 : 0.5 }}>
                    <div style={{ fontSize: 14.5, fontWeight: 600, color: colors.fg, display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {sk.interface?.displayName || sk.name}
                      </span>
                      {tag && (
                        <span style={{ color: colors.dim, fontSize: 11, fontWeight: 400, border: `1px solid ${colors.border}`, borderRadius: 999, padding: "1px 7px", flexShrink: 0 }}>
                          {tag}
                        </span>
                      )}
                    </div>
                    {/* Two lines. A description is written for the MODEL and runs
                        300-570 characters in practice; full text on hover. */}
                    <div
                      title={sk.description || sk.shortDescription || ""}
                      style={{
                        fontSize: 13.5, color: colors.dim, marginTop: 2, lineHeight: 1.45,
                        display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
                      }}
                    >
                      {sk.shortDescription || sk.description || "No description."}
                    </div>
                  </span>
                  <button onClick={() => void toggle(sk)} disabled={busy === sk.path} style={{ ...btnSmall, color: sk.enabled ? colors.fg : colors.accent }}>
                    {busy === sk.path ? "…" : sk.enabled ? "Turn off" : "Turn on"}
                  </button>
                  {ours(sk) && (
                    <IconDangerButton
                      label={`Delete ${sk.name}`}
                      disabled={busy === sk.path}
                      onClick={() => setConfirm(sk)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", backdropFilter: "var(--scrim-blur)", WebkitBackdropFilter: "var(--scrim-blur)", display: "grid", placeItems: "center", zIndex: 100 }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: colors.panel, border: `1px solid ${colors.border}`, borderRadius: 18,
          width: 560, maxWidth: "calc(100vw - 48px)", boxSizing: "border-box",
          // The card no longer scrolls; only its middle does. Otherwise the
          // buttons sit at the bottom of the CONTENT, and with a long list you
          // had to scroll past every skill to reach "Add skill".
          maxHeight: "84vh", display: "flex", flexDirection: "column", overflow: "hidden",
          boxShadow: "0 16px 48px rgba(0,0,0,0.55)", fontFamily: "var(--font-ui)",
        }}
      >
        <div style={{ padding: "24px 26px 0", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 19, fontWeight: 600, color: colors.fg, letterSpacing: "var(--track-title)" }}>
            <span style={{ color: colors.accent, display: "flex" }}><SkillIcon size={18} /></span>
            Skills
          </div>
          <p style={{ color: colors.dim, fontSize: 14, lineHeight: 1.55, margin: "12px 0 0" }}>
            A skill is a folder of instructions Pareto reads when a task calls for it.
            Add one to this project, or to every conversation.
          </p>
        </div>

        {/* minHeight:0 is load-bearing — a flex child will not shrink below its
            content without it, so the scroll never engages and the footer gets
            pushed off the bottom instead. */}
        <div
          style={{
            flex: 1, minHeight: 0, overflowY: "auto",
            padding: "0 20px 4px 26px", scrollbarGutter: "stable",
          }}
        >

        {loading && <div style={{ color: colors.dim, fontSize: 14, lineHeight: 1.55, marginTop: 16 }}>Loading…</div>}
        {error && <div style={{ color: colors.err, fontSize: 13.5, lineHeight: 1.5, marginTop: 16 }}>{error}</div>}

        {confirm && (
          <ConfirmRemove
            title={`Delete ${confirm.interface?.displayName || confirm.name}?`}
            // Unlike an MCP server, this really does delete files.
            detail={
              (inProject(confirm)
                ? "This deletes the skill's folder from this project on disk. If it is committed, it stays in git history and will come back on checkout."
                : "This deletes the skill's folder from disk.") + " This can't be undone from here."
            }
            confirmLabel="Delete"
            onCancel={() => setConfirm(null)}
            onConfirm={() => { const sk = confirm; setConfirm(null); void remove(sk); }}
          />
        )}

        {!loading && !adding && (
          <>
            <Group
              title="In this project"
              items={project}
              empty={cwd ? "Nothing yet." : "Open a project to add skills just for it."}
            />
            <Group title="Available everywhere" items={global} empty="Nothing yet." />
          </>
        )}

        {adding && (
          <div style={{ marginTop: 20, borderTop: `1px solid ${colors.border}`, paddingTop: 16, display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <span style={fieldLabel}>Where should it apply?</span>
              <div style={{ display: "flex", gap: 8 }}>
                {([["project", "This project"], ["global", "Everywhere"]] as const).map(([v, label]) => (
                  <button
                    key={v}
                    onClick={() => setScope(v)}
                    disabled={v === "project" && !cwd}
                    title={v === "project" && !cwd ? "Open a project first" : undefined}
                    style={{
                      ...(scope === v ? btnPrimary : btnSecondary),
                      padding: "8px 16px", fontSize: 13.5,
                      opacity: v === "project" && !cwd ? 0.45 : 1,
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const f = e.dataTransfer.files[0];
                if (!f) return;
                const path = window.unbiased.pathForDroppedFile(f);
                if (path) void validate(path);
              }}
              style={{
                border: `1px dashed ${dragging ? colors.accent : colors.border}`,
                background: dragging ? "rgba(255, 86, 63, 0.06)" : "var(--panel-2)",
                borderRadius: 12, padding: "16px 16px", textAlign: "center",
              }}
            >
              <div style={{ fontSize: 13.5, color: colors.fg, lineHeight: 1.45 }}>
                Drop a folder or .zip
              </div>
              <button
                onClick={() => void choose()}
                style={{
                  background: "none", border: "none", padding: 0, marginTop: 4,
                  color: colors.dim, fontSize: 12.5, fontFamily: "inherit",
                  cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 2,
                }}
              >
                or choose one
              </button>
              {limits && (
                <div style={{ color: colors.dim, fontSize: 11.5, lineHeight: 1.4, marginTop: 8, opacity: 0.75 }}>
                  up to {limits.label}, {limits.maxFiles} files
                </div>
              )}
            </div>

            <div>
              <span style={fieldLabel}>Or paste a link</span>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && url.trim()) void fetchFromUrl(); }}
                  placeholder="github.com/owner/repo or skills.sh/…"
                  style={inputStyle}
                />
                <button
                  onClick={() => void fetchFromUrl()}
                  disabled={!url.trim() || fetching}
                  style={{ ...btnSmall, opacity: !url.trim() || fetching ? 0.45 : 1 }}
                >
                  {fetching ? "Fetching…" : "Fetch"}
                </button>
              </div>
              <div style={helpText}>A skills.sh page, a GitHub repo or folder, a .zip, or a SKILL.md.</div>
            </div>

            {check && !check.ok && (
              <div style={{ color: colors.err, fontSize: 13.5, lineHeight: 1.5 }}>{check.error}</div>
            )}

            {check?.ok && (
              <>
                <div style={{ color: colors.ok, fontSize: 13.5, lineHeight: 1.5 }}>
                  Looks like a skill
                  {check.files ? ` — ${check.files} ${check.files === 1 ? "file" : "files"}, ${check.sizeLabel}` : ""}
                  {check.fromArchive ? ", unpacked and checked" : ""}.
                </div>
                {check.description && (
                  <div style={{ color: colors.dim, fontSize: 13, lineHeight: 1.45 }}>{check.description}</div>
                )}
                {check.warning && (
                  <div style={{ color: colors.amber, fontSize: 13, lineHeight: 1.45 }}>{check.warning}</div>
                )}
                {!!check.scripts?.length && (
                  <div style={{ color: colors.amber, fontSize: 13, lineHeight: 1.45 }}>
                    Ships {check.scripts.length} script{check.scripts.length === 1 ? "" : "s"} Pareto may run:{" "}
                    <span style={{ fontFamily: "var(--font-code)", fontSize: 12 }}>
                      {check.scripts.slice(0, 3).join(", ")}{check.scripts.length > 3 ? ", …" : ""}
                    </span>
                  </div>
                )}
                <div>
                  <span style={fieldLabel}>Name</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
                  <div style={helpText}>The folder it lands in, and how Pareto refers to it.</div>
                </div>
              </>
            )}

          </div>
        )}
        </div>

        {/* Pinned. Its contents follow the mode, so whichever action matters is
            always on screen. */}
        <div
          style={{
            flexShrink: 0, display: "flex", justifyContent: "flex-end", gap: 12,
            padding: "16px 26px 22px", borderTop: `1px solid ${colors.border}`,
          }}
        >
          {adding ? (
            <>
              <button onClick={resetAdd} style={btnSecondary}>Cancel</button>
              <button
                onClick={() => void save()}
                disabled={!check?.ok || !name.trim() || saving}
                style={{ ...btnPrimary, opacity: !check?.ok || !name.trim() || saving ? 0.45 : 1 }}
              >
                {saving ? "Adding…" : "Add skill"}
              </button>
            </>
          ) : (
            <>
              <button onClick={onClose} style={btnSecondary}>Close</button>
              <button onClick={() => { setAdding(true); setScope(cwd ? "project" : "global"); }} style={btnPrimary}>
                <SkillIcon size={15} />
                Add skill
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function UpdateBanner({
  version,
  progress,
  error,
  staged,
  onAct,
}: {
  version: string;
  progress: { phase: UpdatePhase; percent: number } | null;
  error: string | null;
  staged: boolean;
  onAct: () => void;
}) {
  const busy = progress !== null;
  const label = error
    ? "Update failed — retry"
    : progress?.phase === "downloading"
      ? `Downloading… ${progress.percent}%`
      : progress?.phase === "verifying"
        ? "Verifying…"
        : progress?.phase === "installing"
          ? "Installing…"
          : progress?.phase === "relaunching"
            ? "Relaunching…"
            : staged
              ? "Relaunch to update"
              : `Update to v${version}`;
  return (
    <div style={{ padding: "6px 14px 2px", flexShrink: 0 }}>
      <button
        onClick={() => !busy && onAct()}
        disabled={busy}
        title={error ?? (staged ? `v${version} is ready — relaunch to apply` : `Version ${version} is available`)}
        style={{
          position: "relative",
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          gap: 11,
          width: "100%",
          background: "var(--chip)",
          border: `1px solid ${error ? colors.err : colors.border}`,
          borderRadius: 12,
          padding: "10px 12px",
          cursor: busy ? "default" : "pointer",
          fontFamily: "inherit",
          textAlign: "left",
        }}
      >
        {/* Download progress fills the card behind the text. */}
        {progress?.phase === "downloading" && (
          <span
            style={{
              position: "absolute",
              inset: 0,
              // scaleX from a full-width bar rather than an animated width.
              // This one updates continuously while a download runs, so a
              // layout-triggering property here is the worst case for it —
              // and a bar is the one place scaleX is exactly equivalent,
              // since there is no content inside to distort.
              width: "100%",
              transformOrigin: "left center",
              transform: `scaleX(${Math.max(0, Math.min(100, progress.percent)) / 100})`,
              background: colors.accent,
              opacity: 0.16,
              transition: "transform 200ms var(--ease-out)",
            }}
          />
        )}
        {/* Sad while an update is pending; happy once it's staged and a
            relaunch away. */}
        <span style={{ fontSize: 22, lineHeight: 1, flexShrink: 0, zIndex: 1 }} aria-hidden="true">
          {staged && !error ? "😄" : "😞"}
        </span>
        <span style={{ flex: 1, minWidth: 0, zIndex: 1 }}>
          <span
            style={{
              display: "block",
              fontSize: 13.5,
              color: colors.fg,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {label}
          </span>
          <span style={{ display: "block", fontSize: 12, color: colors.dim, marginTop: 1 }}>v{version}</span>
        </span>
        {!busy && (
          <span style={{ color: colors.dim, display: "flex", flexShrink: 0, zIndex: 1 }}>
            <ArrowRightIcon />
          </span>
        )}
      </button>
    </div>
  );
}

/** Shown for the brief moment while we check for a remembered session. */
function AuthSplash() {
  return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ opacity: 0.6 }}>
        <BrandMark size={40} />
      </div>
    </div>
  );
}

/** The sign-in screen: sign in through the browser, paste a key, or continue
 *  with a found one. Every path validates against the platform's whoami (free,
 *  no model call) before letting the engine start. */
function LoginView({ onSignedIn }: { onSignedIn: () => void }) {
  const [phase, setPhase] = useState<"loading" | "found" | "manual" | "browser">("loading");
  const [source, setSource] = useState<"env" | "file" | null>(null);
  // Offered only when this build carries a registered OAuth client id.
  const [browserSignIn, setBrowserSignIn] = useState(false);
  const [device, setDevice] = useState<Extract<DeviceStart, { ok: true }> | null>(null);
  const [foundIdentity, setFoundIdentity] = useState<WhoamiResult | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  // On mount: is there a stored key? If so, validate it and offer "continue".
  useEffect(() => {
    let alive = true;
    void (async () => {
      const st = await window.unbiased.authStatus();
      if (!alive) return;
      setSource(st.source);
      setBrowserSignIn(st.browserSignIn);
      if (st.hasKey) {
        const who = await window.unbiased.authValidate();
        if (!alive) return;
        setFoundIdentity(who);
        setPhase("found");
      } else {
        setPhase("manual");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Rollout guidance: warn (don't block) if the platform reports <100%.
  function rolloutWarning(who: WhoamiResult): string | null {
    if (who.ok && typeof who.paretoRolloutPercent === "number" && who.paretoRolloutPercent < 100) {
      return `This workload's Pareto rollout is ${who.paretoRolloutPercent}% — set it to 100% in the dashboard so every request routes to Pareto.`;
    }
    return null;
  }

  async function completeLogin(key?: string) {
    setBusy(true);
    setError(null);
    setWarn(null);
    const who = await window.unbiased.authLogin(key);
    setBusy(false);
    finishSignIn(who);
  }

  /** The shared tail of every sign-in path: refuse a non-granted org, warn
   *  about a partial Pareto rollout, otherwise enter the app. */
  function finishSignIn(who: WhoamiResult) {
    if (!who.ok) {
      setError(who.error);
      return;
    }
    if (who.accessStatus && who.accessStatus !== "granted" && who.accessStatus !== "active") {
      setError(`This organization's access is "${who.accessStatus}". Contact your admin before signing in.`);
      return;
    }
    const w = rolloutWarning(who);
    if (w) setWarn(w); // shown briefly; we still proceed
    onSignedIn();
  }

  // The platform's device flow: main opens the browser on the platform, we
  // show the code to confirm there, and main polls until a key is issued.
  async function signInWithBrowser() {
    setBusy(true);
    setError(null);
    setWarn(null);
    const started = await window.unbiased.authDeviceStart();
    if (!started.ok) {
      setBusy(false);
      setError(started.error);
      return;
    }
    setDevice(started);
    setPhase("browser");
    const who = await window.unbiased.authDeviceWait();
    setBusy(false);
    setDevice(null);
    setPhase("manual");
    // Cancel is the person's own doing, not an error to report.
    if (!who.ok && who.code === "canceled") return;
    finishSignIn(who);
  }

  const cardStyle: React.CSSProperties = {
    width: 380,
    background: colors.panel,
    border: `1px solid ${colors.border}`,
    borderRadius: 16,
    padding: 28,
  };
  const inputStyle: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    background: "var(--panel-2)",
    color: colors.fg,
    border: `1px solid ${error ? colors.err : colors.border}`,
    borderRadius: 10,
    padding: "10px 12px",
    fontSize: 13,
    fontFamily: "var(--font-code)",
    outline: "none",
  };
  const primaryBtn = (enabled: boolean): React.CSSProperties => ({
    width: "100%",
    background: enabled ? colors.accent : "var(--panel-2)",
    color: enabled ? "var(--accent-fg)" : colors.dim,
    border: "none",
    borderRadius: 10,
    padding: "10px 16px",
    fontSize: 14,
    fontWeight: 500,
    cursor: enabled ? "pointer" : "default",
    fontFamily: "inherit",
    marginTop: 14,
  });

  return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={cardStyle}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginBottom: 22 }}>
          <BrandMark size={38} />
          <div style={{ fontSize: 18, fontWeight: 600, marginTop: 14 }}>Sign in to Unbiased</div>
          <div style={{ fontSize: 13, color: colors.dim, marginTop: 4, textAlign: "center" }}>
            {browserSignIn ? "Sign in with your browser, or paste an API key." : "Connect your Pareto API key to start."}
          </div>
        </div>

        {phase === "loading" && <div style={{ textAlign: "center", color: colors.dim, fontSize: 13 }}>Checking…</div>}

        {phase === "found" && (
          <>
            {foundIdentity?.ok ? (
              <div
                style={{
                  border: `1px solid ${colors.border}`,
                  borderRadius: 12,
                  padding: 14,
                  background: "var(--panel-2)",
                }}
              >
                <div style={{ fontSize: 12, color: colors.dim, marginBottom: 4 }}>
                  Found a key {source === "env" ? "in your environment" : "on this machine"}
                </div>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{foundIdentity.organization.name}</div>
                <div style={{ fontSize: 12.5, color: colors.dim, marginTop: 2 }}>
                  {foundIdentity.workload.name} · {foundIdentity.keyName}
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 13, color: colors.err }}>
                {foundIdentity?.ok === false ? foundIdentity.error : "The stored key couldn't be validated."}
              </div>
            )}
            {error && <div style={{ color: colors.err, fontSize: 12.5, marginTop: 10 }}>{error}</div>}
            <button
              disabled={busy || !foundIdentity?.ok}
              onClick={() => void completeLogin()}
              style={primaryBtn(!busy && !!foundIdentity?.ok)}
            >
              {busy ? "Signing in…" : "Continue"}
            </button>
            <button
              onClick={() => {
                setPhase("manual");
                setError(null);
              }}
              style={{
                width: "100%",
                background: "transparent",
                border: "none",
                color: colors.dim,
                fontSize: 12.5,
                cursor: "pointer",
                marginTop: 10,
                fontFamily: "inherit",
              }}
            >
              {browserSignIn ? "Sign in a different way" : "Use a different key"}
            </button>
          </>
        )}

        {phase === "manual" && (
          <>
            {browserSignIn && (
              <>
                <button
                  disabled={busy}
                  onClick={() => void signInWithBrowser()}
                  style={{ ...primaryBtn(!busy), marginTop: 0 }}
                >
                  {busy ? "Opening your browser…" : "Sign in with your browser"}
                </button>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    margin: "18px 0 12px",
                    color: colors.dim,
                    fontSize: 12,
                  }}
                >
                  <div style={{ flex: 1, height: 1, background: colors.border }} />
                  or paste an API key
                  <div style={{ flex: 1, height: 1, background: colors.border }} />
                </div>
              </>
            )}
            <input
              type="password"
              value={keyInput}
              onChange={(e) => {
                setKeyInput(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && keyInput.trim() && !busy) void completeLogin(keyInput.trim());
              }}
              placeholder="Paste your Unbiased API key"
              spellCheck={false}
              autoFocus
              style={inputStyle}
            />
            {error && <div style={{ color: colors.err, fontSize: 12.5, marginTop: 8 }}>{error}</div>}
            <button
              disabled={busy || !keyInput.trim()}
              onClick={() => void completeLogin(keyInput.trim())}
              style={primaryBtn(!busy && !!keyInput.trim())}
            >
              {busy ? "Validating…" : "Sign in"}
            </button>

            <button
              onClick={() => setShowCreate((v) => !v)}
              style={{
                width: "100%",
                background: "transparent",
                border: "none",
                color: colors.accent,
                fontSize: 12.5,
                cursor: "pointer",
                marginTop: 14,
                fontFamily: "inherit",
              }}
            >
              Don't have a key? Create one
            </button>
            {showCreate && (
              <div
                style={{
                  marginTop: 10,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 10,
                  padding: 12,
                  background: "var(--panel-2)",
                  fontSize: 12.5,
                  color: colors.dim,
                  lineHeight: 1.5,
                }}
              >
                <div style={{ marginBottom: 8 }}>
                  Create a key in the Unbiased dashboard, then paste it above:
                </div>
                <button
                  onClick={() => void window.unbiased.openExternal("https://platform.unbiased.ai/dashboard")}
                  style={{
                    background: "transparent",
                    border: `1px solid ${colors.border}`,
                    color: colors.fg,
                    borderRadius: 8,
                    padding: "6px 12px",
                    fontSize: 12.5,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    marginBottom: 10,
                  }}
                >
                  Open dashboard ↗
                </button>
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "flex-start",
                    color: colors.fg,
                    background: "rgba(255, 138, 80, 0.10)",
                    border: "1px solid rgba(255, 138, 80, 0.35)",
                    borderRadius: 8,
                    padding: "8px 10px",
                  }}
                >
                  <span style={{ flexShrink: 0 }}>⚠️</span>
                  <span>
                    Set the workload's <b>Pareto rollout to 100%</b> when creating the key — otherwise requests
                    may route to other models instead of Pareto.
                  </span>
                </div>
              </div>
            )}
          </>
        )}

        {phase === "browser" && device && (
          <>
            <div style={{ fontSize: 12.5, color: colors.dim, textAlign: "center", lineHeight: 1.5 }}>
              We opened the Unbiased platform in your browser. Confirm this code there:
            </div>
            <div
              style={{
                margin: "14px 0",
                padding: "14px 0",
                textAlign: "center",
                fontFamily: "var(--font-code)",
                fontSize: 26,
                fontWeight: 600,
                letterSpacing: "0.12em",
                border: `1px solid ${colors.border}`,
                borderRadius: 12,
                background: "var(--panel-2)",
                userSelect: "text",
              }}
            >
              {device.userCode}
            </div>
            <div style={{ fontSize: 12.5, color: colors.dim, textAlign: "center" }}>Waiting for your approval…</div>
            <button
              onClick={() => void window.unbiased.openExternal(device.verificationUriComplete)}
              style={{
                width: "100%",
                background: "transparent",
                border: "none",
                color: colors.accent,
                fontSize: 12.5,
                cursor: "pointer",
                marginTop: 14,
                fontFamily: "inherit",
              }}
            >
              Open the page again
            </button>
            <button
              onClick={() => void window.unbiased.authDeviceCancel()}
              style={{
                width: "100%",
                background: "transparent",
                border: "none",
                color: colors.dim,
                fontSize: 12.5,
                cursor: "pointer",
                marginTop: 6,
                fontFamily: "inherit",
              }}
            >
              Cancel
            </button>
          </>
        )}

        {warn && <div style={{ color: "#FF8A50", fontSize: 12, marginTop: 12, lineHeight: 1.4 }}>{warn}</div>}
      </div>
    </div>
  );
}

function fmtBytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(2)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${Math.round(n)} B`;
}

/** Minimal SVG area chart for the Resources view — no chart lib, just a
 *  polyline over the sample window with a soft fill. */
function AreaChart({
  label,
  value,
  color,
  data,
  floor,
}: {
  label: string;
  value: string;
  color: string;
  data: number[];
  /** Minimum y-axis ceiling so early samples don't look like mountains. */
  floor?: number;
}) {
  const W = 100;
  const H = 36;
  const max = Math.max(floor ?? 0, ...data, 1);
  const n = Math.max(data.length, 2);
  const pts = data.map((v, i) => `${((i / (n - 1)) * W).toFixed(2)},${(H - (v / max) * (H - 3)).toFixed(2)}`);
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        border: `1px solid ${colors.border}`,
        borderRadius: 12,
        background: colors.panel,
        padding: "12px 14px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: colors.dim, marginBottom: 6 }}>
        <span>{label}</span>
        <span style={{ color: colors.fg, fontVariantNumeric: "tabular-nums" }}>{value}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: 56, display: "block" }}>
        {data.length >= 2 && (
          <>
            <polygon points={`0,${H} ${pts.join(" ")} ${W},${H}`} fill={color} opacity={0.14} />
            <polyline
              points={pts.join(" ")}
              fill="none"
              stroke={color}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
            />
          </>
        )}
      </svg>
    </div>
  );
}

/** Settings → Resources: live process metrics (2s samples) and what each
 *  conversation costs on disk. */
function ResourcesView() {
  const [procs, setProcs] = useState<{ pid: number; kind: string; memMB: number; cpu: number }[]>([]);
  const [hist, setHist] = useState<{ mem: number; cpu: number }[]>([]);
  const [storage, setStorage] = useState<{
    threads: Record<
      string,
      {
        rolloutBytes: number;
        transcriptBytes: number;
        mtime: number;
        agent?: { nickname: string | null; task: string; parent: string | null };
      }
    >;
    worktrees: { dir: string; project: string; branch: string; kb: number }[];
    engineHomeKB: number;
  } | null>(null);
  const [titles, setTitles] = useState<Map<string, string>>(new Map());
  const [showAllConvs, setShowAllConvs] = useState(false);
  // Deletions here are irreversible (engine log, transcript cache, worktree
  // folder) — always confirm first.
  const [confirmDelete, setConfirmDelete] = useState<
    { kind: "conversation"; id: string; label: string } | { kind: "worktree"; dir: string; label: string } | null
  >(null);

  useEffect(() => {
    if (!confirmDelete) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setConfirmDelete(null);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirmDelete]);

  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const r = await window.unbiased.resourceStats();
        if (!alive) return;
        setProcs(r.procs);
        setHist((h) => [
          ...h.slice(-89),
          {
            mem: r.procs.reduce((n, p) => n + p.memMB, 0),
            cpu: r.procs.reduce((n, p) => n + p.cpu, 0),
          },
        ]);
      } catch {
        // a process exited mid-sample; next tick recovers
      }
    }
    void tick();
    const iv = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);

  // Deleting from here must not fight an in-flight sample — refetch after.
  const refreshStorage = () => void window.unbiased.storageStats().then(setStorage);

  async function runConfirmedDelete() {
    if (!confirmDelete) return;
    if (confirmDelete.kind === "conversation") await window.unbiased.deleteThread(confirmDelete.id);
    else await window.unbiased.removeWorktree(confirmDelete.dir);
    setConfirmDelete(null);
    refreshStorage();
  }

  useEffect(() => {
    void window.unbiased.storageStats().then(setStorage);
    void window.unbiased.listThreads().then((d) => {
      const m = new Map<string, string>();
      for (const p of d.projects) for (const t of p.threads) m.set(t.id, t.title);
      for (const t of d.recents) m.set(t.id, t.title);
      setTitles(m);
    });
  }, []);

  const KIND_LABEL: Record<string, string> = {
    Browser: "Main process",
    Tab: "Interface (renderer)",
    GPU: "GPU compositor",
    Utility: "Utility",
    Zygote: "Zygote",
    engine: "Pareto engine",
    terminal: "Terminal shell",
  };
  const memNow = procs.reduce((n, p) => n + p.memMB, 0);
  const cpuNow = procs.reduce((n, p) => n + p.cpu, 0);
  const sortedProcs = [...procs].sort((a, b) => b.memMB - a.memMB);

  const convRows = storage
    ? Object.entries(storage.threads)
        .map(([id, t]) => {
          // Sub-agent threads never get sidebar titles — name them from
          // their rollout meta (nickname · task) and point at the parent.
          const parentTitle = t.agent?.parent ? titles.get(t.agent.parent) : undefined;
          return {
            id,
            title:
              titles.get(id) ??
              (t.agent
                ? `${agentEmoji(id)} ${t.agent.nickname ?? "Sub-agent"} · ${t.agent.task}`
                : `${id.slice(0, 13)}…`),
            sub: t.agent ? (parentTitle ? `in ${parentTitle}` : "sub-agent") : null,
            bytes: t.rolloutBytes + t.transcriptBytes,
          };
        })
        .sort((a, b) => b.bytes - a.bytes)
    : [];
  const convTotal = convRows.reduce((n, r) => n + r.bytes, 0);
  const maxConv = convRows[0]?.bytes ?? 1;
  const wtTotalKB = storage?.worktrees.reduce((n, w) => n + w.kb, 0) ?? 0;
  const shownConvs = showAllConvs ? convRows : convRows.slice(0, 12);

  const cardStyle: React.CSSProperties = {
    border: `1px solid ${colors.border}`,
    borderRadius: 12,
    background: colors.panel,
    overflow: "hidden",
    marginBottom: 24,
  };
  const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "9px 18px",
    borderBottom: `1px solid ${colors.border}`,
    fontSize: 13,
  };

  return (
    <div style={{ maxWidth: 760, margin: "0 auto" }}>
      <h1 style={{ fontSize: 28, fontWeight: 600, letterSpacing: "var(--track-title)", lineHeight: 1.15, margin: "0 0 28px" }}>Resources</h1>

      <div style={{ display: "flex", gap: 12, marginBottom: 24 }}>
        <AreaChart
          label="Memory"
          value={fmtBytes(memNow * 1024 * 1024)}
          color={colors.accent}
          data={hist.map((h) => h.mem)}
        />
        <AreaChart
          label="CPU"
          value={`${cpuNow.toFixed(0)}%`}
          color="#5B9DFF"
          data={hist.map((h) => h.cpu)}
          floor={100}
        />
      </div>

      <div style={cardStyle}>
        <div style={{ ...rowStyle, fontWeight: 500, color: colors.dim, fontSize: 12.5 }}>
          <span style={{ flex: 1 }}>Process</span>
          <span style={{ width: 80, textAlign: "right" }}>Memory</span>
          <span style={{ width: 56, textAlign: "right" }}>CPU</span>
        </div>
        {sortedProcs.map((p, i) => (
          <div key={p.pid} style={{ ...rowStyle, ...(i === sortedProcs.length - 1 ? { borderBottom: "none" } : {}) }}>
            <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {KIND_LABEL[p.kind] ?? p.kind}
              <span style={{ color: colors.dim, marginLeft: 8, fontSize: 11.5 }}>pid {p.pid}</span>
            </span>
            <span style={{ width: 80, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
              {fmtBytes(p.memMB * 1024 * 1024)}
            </span>
            <span style={{ width: 56, textAlign: "right", fontVariantNumeric: "tabular-nums", color: colors.dim }}>
              {p.cpu.toFixed(1)}%
            </span>
          </div>
        ))}
      </div>

      <h2 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 12px" }}>Storage</h2>
      <div style={cardStyle}>
        <div style={rowStyle}>
          <span style={{ flex: 1 }}>Engine data (sessions, state, caches)</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {storage ? fmtBytes(storage.engineHomeKB * 1024) : "…"}
          </span>
        </div>
        <div style={rowStyle}>
          <span style={{ flex: 1 }}>Conversations ({convRows.length})</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmtBytes(convTotal)}</span>
        </div>
        <div style={{ ...rowStyle, borderBottom: "none" }}>
          <span style={{ flex: 1 }}>Worktrees ({storage?.worktrees.length ?? 0})</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmtBytes(wtTotalKB * 1024)}</span>
        </div>
      </div>

      <h2 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 4px" }}>Per conversation</h2>
      <div style={{ fontSize: 12.5, color: colors.dim, marginBottom: 12 }}>
        Engine rollout log + this app's transcript cache.
      </div>
      <div style={cardStyle}>
        {shownConvs.map((r, i) => (
          <div
            key={r.id}
            style={{ ...rowStyle, ...(i === shownConvs.length - 1 && convRows.length <= 12 ? { borderBottom: "none" } : {}) }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>
              <span
                style={{
                  display: "block",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  marginBottom: 5,
                }}
              >
                {r.title}
                {r.sub && (
                  <span style={{ color: colors.dim, marginLeft: 8, fontSize: 11.5 }}>{r.sub}</span>
                )}
              </span>
              <span
                style={{
                  display: "block",
                  height: 4,
                  borderRadius: 2,
                  width: `${Math.max(2, (r.bytes / maxConv) * 100)}%`,
                  background: colors.accent,
                  opacity: 0.75,
                }}
              />
            </span>
            <span style={{ width: 80, textAlign: "right", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
              {fmtBytes(r.bytes)}
            </span>
            <button
              onClick={() => setConfirmDelete({ kind: "conversation", id: r.id, label: r.title })}
              title="Delete conversation (engine log + transcript cache)"
              aria-label={`Delete ${r.title}`}
              style={{
                flexShrink: 0,
                display: "flex",
                background: "transparent",
                border: "none",
                color: colors.dim,
                cursor: "pointer",
                padding: "4px 0 4px 10px",
              }}
              onMouseEnter={(ev) => ((ev.currentTarget as HTMLButtonElement).style.color = colors.err)}
              onMouseLeave={(ev) => ((ev.currentTarget as HTMLButtonElement).style.color = colors.dim)}
            >
              <TrashIcon />
            </button>
          </div>
        ))}
        {convRows.length > 12 && (
          <button
            onClick={() => setShowAllConvs((v) => !v)}
            style={{
              width: "100%",
              background: "transparent",
              border: "none",
              color: colors.dim,
              fontSize: 12.5,
              padding: "9px 18px",
              cursor: "pointer",
              fontFamily: "inherit",
              textAlign: "left",
            }}
          >
            {showAllConvs ? "Show fewer" : `Show all ${convRows.length}`}
          </button>
        )}
        {storage && convRows.length === 0 && (
          <div style={{ ...rowStyle, borderBottom: "none", color: colors.dim }}>No conversations yet.</div>
        )}
      </div>

      {storage && storage.worktrees.length > 0 && (
        <>
          <h2 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 12px" }}>Worktrees</h2>
          <div style={cardStyle}>
            {storage.worktrees.map((w, i) => (
              <div
                key={w.dir}
                style={{ ...rowStyle, ...(i === storage.worktrees.length - 1 ? { borderBottom: "none" } : {}) }}
              >
                <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {w.branch}
                  <span style={{ color: colors.dim, marginLeft: 8, fontSize: 11.5 }}>
                    {w.project.split("/").pop()}
                  </span>
                </span>
                <span style={{ fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{fmtBytes(w.kb * 1024)}</span>
                <button
                  onClick={() => setConfirmDelete({ kind: "worktree", dir: w.dir, label: w.branch })}
                  title={`Delete worktree ${w.dir}`}
                  aria-label={`Delete worktree ${w.branch}`}
                  style={{
                    flexShrink: 0,
                    display: "flex",
                    background: "transparent",
                    border: "none",
                    color: colors.dim,
                    cursor: "pointer",
                    padding: "4px 0 4px 10px",
                  }}
                  onMouseEnter={(ev) => ((ev.currentTarget as HTMLButtonElement).style.color = colors.err)}
                  onMouseLeave={(ev) => ((ev.currentTarget as HTMLButtonElement).style.color = colors.dim)}
                >
                  <TrashIcon />
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      {confirmDelete && (
        <div
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setConfirmDelete(null);
          }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)", backdropFilter: "var(--scrim-blur)", WebkitBackdropFilter: "var(--scrim-blur)",
            display: "grid",
            placeItems: "center",
            zIndex: 100,
          }}
        >
          <div
            style={{
              width: 480,
              maxWidth: "calc(100vw - 48px)",
              background: colors.panel,
              border: `1px solid ${colors.border}`,
              borderRadius: 16,
              padding: "22px 24px 20px",
              boxShadow: "0 16px 48px rgba(0,0,0,0.55)",
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 600, color: colors.fg, overflowWrap: "anywhere" }}>
              {confirmDelete.kind === "conversation"
                ? `Delete “${confirmDelete.label}”?`
                : `Delete worktree ${confirmDelete.label}?`}
            </div>
            <div style={{ color: colors.dim, fontSize: 14, lineHeight: 1.55, marginTop: 10 }}>
              {confirmDelete.kind === "conversation"
                ? "This permanently deletes the conversation — its engine history and cached transcript. This can't be undone."
                : "This deletes the worktree's folder from disk, including any uncommitted changes in it. The branch itself stays in the repository."}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 22 }}>
              <button
                onClick={() => setConfirmDelete(null)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: colors.dim,
                  fontSize: 14.5,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  padding: "9px 14px",
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => void runConfirmedDelete()}
                style={{
                  background: "rgba(240, 149, 149, 0.14)",
                  border: "none",
                  borderRadius: 10,
                  color: colors.err,
                  fontSize: 14.5,
                  fontWeight: 500,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  padding: "9px 18px",
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SettingsView({
  theme,
  onChange,
  onBack,
  onSignOut,
  releases,
}: {
  theme: ThemeConfig;
  onChange: (t: ThemeConfig) => void;
  onBack: () => void;
  onSignOut: () => void;
  releases: ChangelogRelease[];
}) {
  const [tab, setTab] = useState<"appearance" | "resources" | "account" | "updates">("appearance");
  const [updPrefs, setUpdPrefs] = useState<{
    autoDownload: boolean;
    version: string;
    lastCheckedAt: number | null;
  } | null>(null);
  useEffect(() => {
    if (tab === "updates" && !updPrefs) void window.unbiased.updatePrefs().then(setUpdPrefs);
  }, [tab, updPrefs]);
  // Notes for the version actually running, not merely the newest we ship —
  // someone on an older build should see what THEY have.
  const runningRelease =
    releases.find((r) => r.version === updPrefs?.version) ?? releases[0];
  function toggleAutoDownload() {
    setUpdPrefs((p) => {
      if (!p) return p;
      const next = { ...p, autoDownload: !p.autoDownload };
      void window.unbiased.setUpdatePrefs({ autoDownload: next.autoDownload });
      return next;
    });
  }
  // Sign-out key handling: default removes the saved key; flipping this
  // keeps ~/.unbiased/credentials.json so the next sign-in is one click.
  const [keepKey, setKeepKey] = useState(() => localStorage.getItem("signoutKeepsKey") !== "false");

  function toggleKeepKey() {
    setKeepKey((k) => {
      localStorage.setItem("signoutKeepsKey", String(!k));
      return !k;
    });
  }
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [account, setAccount] = useState<WhoamiResult | null>(null);

  useEffect(() => {
    if (tab === "account" && !account) void window.unbiased.authValidate().then(setAccount);
  }, [tab, account]);

  const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 20,
    padding: "14px 18px",
    borderBottom: `1px solid ${colors.border}`,
    fontSize: 13.5,
    letterSpacing: "var(--track-body)",
  };
  const textInputStyle: React.CSSProperties = {
    background: "var(--panel-2)",
    color: colors.fg,
    border: `1px solid ${colors.border}`,
    borderRadius: 8,
    padding: "6px 10px",
    fontSize: 13,
    fontFamily: "var(--font-code)",
    // Takes the row's spare width instead of a fixed 260, which truncated the
    // code-font stack mid-string — the one field where the whole value
    // matters, since a missing fallback is invisible until a glyph is.
    flex: 1,
    minWidth: 0,
    maxWidth: 420,
    outline: "none",
  };

  /** Heading above a group of cards. Codex labels each block rather than
   *  relying on the cards alone to imply structure. */
  function Group({ title, children }: { title: string; children: React.ReactNode }) {
    return (
      <section style={{ marginBottom: 30 }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "var(--track-overline)",
            color: colors.dim,
            margin: "0 0 10px 2px",
          }}
        >
          {title}
        </div>
        {children}
      </section>
    );
  }

  function ColorRow({ label, value, set }: { label: string; value: string; set: (v: string) => void }) {
    return (
      <div style={rowStyle}>
        <span>{label}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, justifyContent: "flex-end" }}>
          <input
            type="color"
            value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#000000"}
            onChange={(e) => set(e.target.value)}
            aria-label={`${label} colour`}
            style={{
              width: 26,
              height: 26,
              border: `1px solid ${colors.border}`,
              borderRadius: 7,
              background: "transparent",
              padding: 2,
              cursor: "pointer",
              flexShrink: 0,
            }}
          />
          <input
            value={value}
            onChange={(e) => set(e.target.value)}
            spellCheck={false}
            style={{ ...textInputStyle, flex: "0 0 110px", maxWidth: 110 }}
          />
        </span>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: "flex", minWidth: 0 }}>
      <nav
        style={{
          width: 220,
          flexShrink: 0,
          borderRight: `1px solid ${colors.border}`,
          background: "var(--nav-bg)",
          padding: 14,
        }}
      >
        <button
          onClick={onBack}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: "transparent",
            border: "none",
            color: colors.dim,
            fontSize: 13.5,
            cursor: "pointer",
            padding: "4px 0 16px",
            fontFamily: "inherit",
          }}
        >
          ← Back to app
        </button>
{(
          [
            {
              group: "Personal",
              items: [
                { id: "appearance", label: "Appearance", icon: <ContrastIcon /> },
                { id: "account", label: "Account", icon: <PersonIcon /> },
              ],
            },
            {
              group: "Application",
              items: [
                { id: "updates", label: "Updates", icon: <DownloadIcon /> },
                { id: "resources", label: "Resources", icon: <LaptopIcon /> },
              ],
            },
          ] as const
        ).map((sec) => (
          <div key={sec.group} style={{ marginBottom: 10 }}>
            <SectionLabel>{sec.group}</SectionLabel>
            {sec.items.map((item) => (
              <button
                key={item.id}
                onClick={() => setTab(item.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  width: "100%",
                  textAlign: "left",
                  // Same selected treatment as the main sidebar — neutral
                  // fill, accent in the rail — so "which section am I in"
                  // looks the same everywhere in the app.
                  background: tab === item.id ? "var(--chip)" : "transparent",
                  boxShadow: tab === item.id ? "inset 2px 0 0 0 var(--accent)" : "none",
                  fontWeight: tab === item.id ? 500 : 400,
                  color: tab === item.id ? colors.fg : colors.dim,
                  border: "none",
                  borderRadius: 8,
                  padding: "7px 10px",
                  fontSize: 13.5,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  marginBottom: 2,
                }}
              >
                <span style={{ display: "flex", flexShrink: 0, opacity: tab === item.id ? 1 : 0.75 }}>
                  {item.icon}
                </span>
                {item.label}
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div style={{ flex: 1, overflowY: "auto", padding: "44px 48px 64px" }}>
        {tab === "resources" ? (
          <div style={{ maxWidth: 760, margin: "0 auto" }}>
            <ResourcesView />
          </div>
        ) : tab === "updates" ? (
          <div style={{ maxWidth: 760, margin: "0 auto" }}>
            <h1 style={{ fontSize: 28, fontWeight: 600, letterSpacing: "var(--track-title)", lineHeight: 1.15, margin: "0 0 28px" }}>Updates</h1>

            <Group title="Automatic updates">
            <div
              style={{
                border: `1px solid ${colors.border}`,
                borderRadius: 12,
                background: colors.panel,
                overflow: "hidden",
              }}
            >
              <div style={{ ...rowStyle, borderBottom: "none", alignItems: "flex-start", gap: 14 }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block" }}>Download updates automatically</span>
                  <span style={{ display: "block", fontSize: 12.5, color: colors.dim, marginTop: 3, lineHeight: 1.5 }}>
                    New versions download quietly in the background. Nothing changes until you choose to
                    restart.
                  </span>
                </span>
                <button
                  onClick={toggleAutoDownload}
                  disabled={!updPrefs}
                  role="switch"
                  aria-checked={!!updPrefs?.autoDownload}
                  aria-label="Download updates automatically"
                  style={{
                    width: 38,
                    height: 22,
                    borderRadius: 11,
                    border: "none",
                    background: updPrefs?.autoDownload ? colors.accent : "var(--gutter)",
                    position: "relative",
                    cursor: updPrefs ? "pointer" : "default",
                    flexShrink: 0,
                    padding: 0,
                    marginTop: 1,
                    transition: "background 120ms",
                  }}
                >
                  <span
                    style={{
                      position: "absolute",
                      top: 3,
                      left: 3,
                      width: 16,
                      height: 16,
                      borderRadius: "50%",
                      background: "#fff",
                      // translateX rather than an animated `left`: `left` is a
                      // layout property, so every frame of the knob's travel
                      // costs layout and paint, where a transform is composite
                      // only. Identical 16px of travel (3 → 19).
                      transform: updPrefs?.autoDownload ? "translateX(16px)" : "none",
                      transition: "transform 120ms var(--ease-out)",
                    }}
                  />
                </button>
              </div>
            </div>
            </Group>

            <Group title="This version">
            <div
              style={{
                border: `1px solid ${colors.border}`,
                borderRadius: 12,
                background: colors.panel,
                overflow: "hidden",
                padding: "14px 18px 18px",
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 14, fontWeight: 500 }}>Version {updPrefs?.version ?? "—"}</span>
                <span style={{ color: colors.dim, fontSize: 12.5 }}>
                  {updPrefs?.lastCheckedAt ? `checked ${relTime(updPrefs.lastCheckedAt)}` : "not checked yet"}
                </span>
              </div>
              {runningRelease && (
                <>
                  {runningRelease.version !== updPrefs?.version && (
                    <div style={{ color: colors.dim, fontSize: 12.5, marginTop: 10 }}>
                      Notes for {runningRelease.version}
                    </div>
                  )}
                  <div style={{ marginTop: 4 }}>
                    <ReleaseNotes body={runningRelease.body} />
                  </div>
                </>
              )}
            </div>
            </Group>
          </div>
        ) : tab === "account" ? (
          <div style={{ maxWidth: 760, margin: "0 auto" }}>
            <h1 style={{ fontSize: 28, fontWeight: 600, letterSpacing: "var(--track-title)", lineHeight: 1.15, margin: "0 0 28px" }}>Account</h1>
            <div
              style={{
                border: `1px solid ${colors.border}`,
                borderRadius: 12,
                background: colors.panel,
                overflow: "hidden",
              }}
            >
              {account?.ok ? (
                <>
                  <div style={rowStyle}>
                    <span style={{ color: colors.dim }}>Organization</span>
                    <span>{account.organization.name}</span>
                  </div>
                  <div style={rowStyle}>
                    <span style={{ color: colors.dim }}>Workload</span>
                    <span>{account.workload.name}</span>
                  </div>
                  <div style={rowStyle}>
                    <span style={{ color: colors.dim }}>Key</span>
                    <span style={{ fontFamily: "var(--font-code)", fontSize: 13 }}>{account.keyName}</span>
                  </div>
                  <div style={rowStyle}>
                    <span style={{ color: colors.dim }}>Access</span>
                    <span>{account.accessStatus}</span>
                  </div>
                  <div style={{ ...rowStyle, borderBottom: "none" }}>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: "block", color: colors.dim }}>Keep key on sign out</span>
                      <span style={{ display: "block", fontSize: 12, color: "var(--gutter)", marginTop: 2 }}>
                        Leave the saved key on this machine for one-click sign-in
                      </span>
                    </span>
                    <button
                      onClick={toggleKeepKey}
                      role="switch"
                      aria-checked={keepKey}
                      aria-label="Keep key on sign out"
                      style={{
                        width: 38,
                        height: 22,
                        borderRadius: 11,
                        border: "none",
                        background: keepKey ? colors.accent : "var(--gutter)",
                        position: "relative",
                        cursor: "pointer",
                        flexShrink: 0,
                        padding: 0,
                        transition: "background 120ms",
                      }}
                    >
                      <span
                        style={{
                          position: "absolute",
                          top: 3,
                          left: 3,
                          width: 16,
                          height: 16,
                          borderRadius: "50%",
                          background: "#fff",
                          transform: keepKey ? "translateX(16px)" : "none",
                          transition: "transform 120ms var(--ease-out)",
                        }}
                      />
                    </button>
                  </div>
                </>
              ) : (
                <div style={{ ...rowStyle, borderBottom: "none", color: colors.dim }}>
                  {account && !account.ok ? account.error : "Loading…"}
                </div>
              )}
            </div>
            <button
              onClick={onSignOut}
              style={{
                marginTop: 20,
                background: "transparent",
                border: `1px solid ${colors.err}`,
                color: colors.err,
                borderRadius: 10,
                padding: "9px 18px",
                fontSize: 13.5,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Sign out
            </button>
            <div style={{ fontSize: 12, color: colors.dim, marginTop: 10 }}>
              {keepKey
                ? "Signing out stops the engine. The saved key stays on this machine for the next sign-in."
                : "Signing out stops the engine and removes the saved key from this machine."}
            </div>
          </div>
        ) : (
        <div style={{ maxWidth: 760, margin: "0 auto" }}>
          <h1 style={{ fontSize: 28, fontWeight: 600, letterSpacing: "var(--track-title)", lineHeight: 1.15, margin: "0 0 28px" }}>Appearance</h1>

          <div
            style={{
              border: `1px solid ${colors.border}`,
              borderRadius: 12,
              background: colors.panel,
              overflow: "hidden",
            }}
          >
            <div style={{ ...rowStyle, fontWeight: 500 }}>
              <span>Dark theme</span>
              <button
                onClick={() => onChange(DEFAULT_THEME)}
                style={btnSmallStyle}
              >
                Reset to default
              </button>
            </div>
            <ColorRow label="Accent" value={theme.accent} set={(v) => onChange({ ...theme, accent: v })} />
            <ColorRow label="Background" value={theme.surface} set={(v) => onChange({ ...theme, surface: v })} />
            <ColorRow label="Foreground" value={theme.ink} set={(v) => onChange({ ...theme, ink: v })} />
            <div style={rowStyle}>
              <span>UI font</span>
              <input
                value={theme.fonts.ui}
                onChange={(e) => onChange({ ...theme, fonts: { ...theme.fonts, ui: e.target.value } })}
                spellCheck={false}
                style={textInputStyle}
              />
            </div>
            <div style={rowStyle}>
              <span>Code font</span>
              <input
                value={theme.fonts.code}
                onChange={(e) => onChange({ ...theme, fonts: { ...theme.fonts, code: e.target.value } })}
                spellCheck={false}
                style={textInputStyle}
              />
            </div>
            <div style={{ ...rowStyle, borderBottom: "none" }}>
              <span>Contrast</span>
              <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <input
                  type="range"
                  min={10}
                  max={100}
                  value={theme.contrast}
                  onChange={(e) => onChange({ ...theme, contrast: Number(e.target.value) })}
                  style={{ width: 160, accentColor: theme.accent }}
                />
                <span style={{ fontVariantNumeric: "tabular-nums", width: 28, textAlign: "right" }}>
                  {theme.contrast}
                </span>
              </span>
            </div>
          </div>

          <div
            style={{
              border: `1px solid ${colors.border}`,
              borderRadius: 12,
              background: colors.panel,
              marginTop: 24,
              padding: "14px 18px",
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 8 }}>Import theme</div>
            <div style={{ fontSize: 12.5, color: colors.dim, marginBottom: 10 }}>
              Paste a Codex theme export (<code style={{ fontFamily: "var(--font-code)" }}>codex-theme-v1:…</code>)
              or its raw JSON.
            </div>
            <textarea
              value={importText}
              onChange={(e) => {
                setImportText(e.target.value);
                setImportError(null);
              }}
              rows={3}
              spellCheck={false}
              placeholder='codex-theme-v1:{"theme":{"accent":"#FF563F",…}}'
              style={{
                width: "100%",
                resize: "vertical",
                background: "var(--panel-2)",
                color: colors.fg,
                border: `1px solid ${importError ? colors.err : colors.border}`,
                borderRadius: 8,
                padding: "8px 10px",
                fontSize: 12.5,
                fontFamily: "var(--font-code)",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
              <button
                onClick={() => {
                  const parsed = parseThemeImport(importText);
                  if (!parsed) {
                    setImportError("Could not parse that theme.");
                    return;
                  }
                  onChange(parsed);
                  setImportText("");
                  setImportError(null);
                }}
                disabled={!importText.trim()}
                style={{
                  // The shared primary when it can act; a flat muted chip when
                  // it cannot. The overrides that used to follow this spread
                  // (radius 8, 7x16 padding, 13px) quietly undid the pill the
                  // shared style defines, which is how a "shared" style stops
                  // being shared.
                  ...btnSmallStyle,
                  ...(importText.trim()
                    ? btnPrimaryStyle
                    : { background: "var(--panel-2)", color: colors.dim }),
                  cursor: importText.trim() ? "pointer" : "default",
                }}
              >
                Import
              </button>
              {importError && <span style={{ color: colors.err, fontSize: 12.5 }}>{importError}</span>}
            </div>
          </div>
        </div>
        )}
      </div>
    </div>
  );
}

/** The brand's two-arc mark in its launcher colors. */
function BrandMark({ size = 48 }: { size?: number } = {}) {
  return (
    <svg width={size} height={Math.round(size * (62 / 55.95))} viewBox="0 0 55.9498 62.0001" fill="none" aria-hidden="true">
      <path d="M14.0857 0C14.0857 7.63412 20.3039 13.8227 27.9747 13.8227C35.6454 13.8227 41.8639 7.63413 41.8639 0H55.9493C55.9493 15.3762 43.4246 27.8411 27.9747 27.8411C12.5248 27.8411 5.31346e-05 15.3761 5.31346e-05 0H14.0857Z" fill="#FF7764" />
      <path d="M41.8642 62.0001C41.8642 54.3659 35.6459 48.1774 27.9752 48.1774C20.3044 48.1774 14.0859 54.3659 14.0859 62.0001L0.000534272 62.0001C0.000535623 46.6239 12.5252 34.159 27.9752 34.159C43.4251 34.159 55.9498 46.6239 55.9498 62.0001L41.8642 62.0001Z" fill="#FF563F" />
    </svg>
  );
}

/** Codex-style start page: brand mark, "What should we build in X?", and
 *  suggestion cards that seed the composer. */
function StartPage({
  projectName,
  onPick,
}: {
  projectName: string | null;
  onPick: (text: string) => void;
}) {
  const cards = [
    {
      icon: <TelescopeIcon />,
      color: "#5B9DFF",
      label: "Explore and understand code",
      prompt: "Explore this codebase and explain how it works at a high level.",
    },
    {
      icon: <HammerIcon />,
      color: "#B58CFF",
      label: "Build a new feature, app, or tool",
      prompt: "Help me build a new feature: ",
    },
    {
      icon: <ReviewIcon />,
      color: "#5DCAA5",
      label: "Review code and suggest changes",
      prompt: "Review the current changes and suggest improvements.",
    },
    {
      icon: <BugIcon />,
      color: "#FF8A50",
      label: "Fix issues and failures",
      prompt: "Help me find and fix issues or failing tests.",
    },
  ];
  return (
    <div style={{ textAlign: "center", padding: "0 24px" }}>
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 18 }}>
        <BrandMark size={32} />
      </div>
      <h1 style={{ fontSize: 26, fontWeight: 500, letterSpacing: -0.3, margin: 0, color: colors.fg }}>
        {projectName ? (
          <>
            What should we build in{" "}
            <span
              style={{
                // The logo's lighter coral, not the theme accent.
                color: "#FF7764",
                textDecoration: "underline dotted",
                textUnderlineOffset: 7,
                textDecorationColor: "#FF7764",
              }}
            >
              {projectName}
            </span>
            ?
          </>
        ) : (
          "What should we build?"
        )}
      </h1>
      <div style={{ display: "flex", gap: 12, justifyContent: "center", marginTop: 30, flexWrap: "wrap" }}>
        {cards.map((c) => (
          <button
            key={c.label}
            onClick={() => onPick(c.prompt)}
            style={{
              width: 168,
              textAlign: "left",
              background: "transparent",
              border: `1px solid ${colors.border}`,
              borderRadius: 14,
              padding: "14px 14px 16px",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            <span style={{ color: c.color, display: "flex", marginBottom: 12 }}>{c.icon}</span>
            <div style={{ fontSize: 13.5, color: colors.fg, lineHeight: 1.45 }}>{c.label}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function TelescopeIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m10.065 12.493-6.18 1.318a.934.934 0 0 1-1.108-.702l-.537-2.15a1.07 1.07 0 0 1 .691-1.265l13.504-4.44" />
      <path d="m13.56 11.747 4.332-.924" />
      <path d="m16 21-3.105-6.21" />
      <path d="M16.485 5.94a2 2 0 0 1 1.455-2.425l1.09-.272a1 1 0 0 1 1.212.727l1.515 6.06a1 1 0 0 1-.727 1.213l-1.09.272a2 2 0 0 1-2.425-1.455z" />
      <path d="m6.158 8.633 1.114 4.456" />
      <path d="m8 21 3.105-6.21" />
      <circle cx="12" cy="13" r="2" />
    </svg>
  );
}

function HammerIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9" />
      <path d="m18 15 4-4" />
      <path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5" />
    </svg>
  );
}

function BugIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m8 2 1.88 1.88" />
      <path d="M14.12 3.88 16 2" />
      <path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1" />
      <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6" />
      <path d="M12 20v-9" />
      <path d="M6.53 9C4.6 8.8 3 7.1 3 5" />
      <path d="M6 13H2" />
      <path d="M3 21c0-2.1 1.7-3.9 3.8-4" />
      <path d="M20.97 5c0 2.1-1.6 3.8-3.5 4" />
      <path d="M22 13h-4" />
      <path d="M17.2 17c2.1.1 3.8 1.9 3.8 4" />
    </svg>
  );
}

/** One row of the header's Environment popover. */
function EnvRow({
  icon,
  label,
  right,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  right?: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        background: "transparent",
        border: "none",
        borderRadius: 8,
        padding: "8px 10px",
        fontSize: 13.5,
        color: colors.fg,
        cursor: "pointer",
        textAlign: "left",
        fontFamily: "inherit",
      }}
    >
      <span style={{ color: colors.dim, display: "flex", flexShrink: 0 }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {label}
      </span>
      {right}
    </button>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <span
      style={{
        display: "flex",
        color: colors.dim,
        transform: open ? "none" : "rotate(-90deg)",
        transition: "transform 120ms var(--ease-out)",
        flexShrink: 0,
      }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 9l6 6 6-6" />
      </svg>
    </span>
  );
}

/** Squared ± mark for the Changes row. */
function ChangesIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <rect x="3" y="3" width="18" height="18" rx="4" />
      <path d="M12 7.5v5M9.5 10h5M9.5 15.5h5" />
    </svg>
  );
}

/** Commit dot on a line. */
function CommitIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="12" cy="12" r="3.5" />
      <path d="M2.5 12h6M15.5 12h6" />
    </svg>
  );
}

/** Pull-request glyph: branch merging back. */
function PrIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5v7M13 6h2.5A2.5 2.5 0 0 1 18 8.5v7" />
      <path d="M11 3.5 13 6l-2 2.5" />
    </svg>
  );
}

/** Checklist glyph for the header's Environment button. */
function EnvIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6l1.5 1.5L8 5" />
      <path d="M4 12.5l1.5 1.5L8 11.5" />
      <path d="M4 19l1.5 1.5L8 18" />
      <path d="M11.5 6.5H20M11.5 13H20M11.5 19.5H20" />
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12h15" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  );
}

/** Two arrows folding toward a center line — "compact". */
function CompactIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12h16" />
      <path d="M8 8l4-4 4 4" />
      <path d="M8 16l4 4 4-4" />
    </svg>
  );
}

function ContrastIcon({ size = 15 }: { size?: number } = {}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function PersonIcon({ size = 15 }: { size?: number } = {}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="3.6" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </svg>
  );
}

function DownloadIcon({ size = 15 }: { size?: number } = {}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v11" />
      <path d="m7.5 10 4.5 4.5L16.5 10" />
      <path d="M5 20h14" />
    </svg>
  );
}

function LaptopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <line x1="6" x2="6" y1="3" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

/** Brand wordmark (unbiased-platform public/logos/unbiased-wordmark.svg),
 *  inlined so "biased" tracks the theme foreground; "un" keeps the brand
 *  corals from the source asset. */
function Wordmark({ height = 16 }: { height?: number }) {
  const width = Math.round(height * (314.673 / 50.0576));
  return (
    <svg width={width} height={height} viewBox="0 0 314.673 50.0576" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="unbiased">
      <path d="M12.2295 34.8111C12.2295 36.2942 12.58 37.4937 13.2812 38.4098C14.0264 39.3258 15.0562 39.7847 16.3711 39.7848C17.9052 39.7848 19.3296 39.2822 20.6445 38.2789C21.6136 37.5073 22.6651 36.3679 23.8008 34.8619V12.6285H36.0303V49.2721H24.1299L23.9033 45.4146C22.7391 46.6374 21.5007 47.5971 20.1846 48.2906C17.9491 49.4684 15.604 50.0572 13.1494 50.0572C10.3004 50.0572 7.88943 49.4902 5.91699 48.356C3.98848 47.1782 2.51983 45.5427 1.51172 43.4488C0.503563 41.3549 0 38.8898 0 36.0543V12.6285H12.2295V34.8111Z" fill="#FF7764" />
      <path d="M66.8253 11.8432C69.6743 11.8432 72.0636 12.432 73.9922 13.6098C75.9647 14.744 77.4548 16.3587 78.463 18.4526C79.471 20.5464 79.9756 23.0108 79.9756 25.8462V49.2719H67.7462V27.0893C67.7461 25.6063 67.3731 24.4067 66.628 23.4907C65.9267 22.5747 64.9185 22.1167 63.6036 22.1167C62.0696 22.1167 60.645 22.6401 59.3301 23.687C58.3612 24.4263 57.3095 25.5451 56.1739 27.0424V49.2719H43.9444V12.6284H55.8458L56.0704 16.4848C57.2345 15.2621 58.474 14.3033 59.7901 13.6098C62.0255 12.4321 64.3708 11.8433 66.8253 11.8432Z" fill="#FF563F" />
      <path d="M96.4538 18.0605C97.7249 16.3156 99.3907 14.9626 101.451 14.0029C103.511 12.9998 105.768 12.4981 108.222 12.498C111.466 12.498 114.293 13.3051 116.704 14.9189C119.158 16.4894 121.087 18.6928 122.49 21.5283C123.893 24.3638 124.594 27.614 124.594 31.2783C124.594 34.899 123.893 38.1274 122.49 40.9629C121.087 43.7982 119.158 46.0227 116.704 47.6367C114.293 49.2507 111.466 50.0576 108.222 50.0576C105.724 50.0576 103.423 49.5342 101.319 48.4873C99.2589 47.3967 97.5931 45.9793 96.322 44.2344L96.1247 49.2725H89.8132V1.17773H96.4538V18.0605ZM177.705 12.498C180.948 12.498 183.754 13.0433 186.121 14.1338C188.488 15.1808 190.307 16.7082 191.578 18.7148C192.893 20.7215 193.55 23.1639 193.55 26.043V49.2725H187.239L187.057 43.6396C185.989 45.3653 184.605 46.7642 182.899 47.833C180.532 49.3161 177.618 50.0576 174.155 50.0576C171.788 50.0576 169.706 49.6432 167.909 48.8145C166.112 47.942 164.709 46.7208 163.701 45.1504C162.693 43.5363 162.188 41.66 162.188 39.5225C162.188 35.8149 163.613 32.936 166.462 30.8857C169.355 28.8354 173.388 27.8096 178.56 27.8096H186.976V25.7158C186.976 23.1423 186.121 21.1358 184.412 19.6963C182.746 18.2131 180.444 17.4707 177.508 17.4707C174.659 17.4708 172.336 18.1259 170.539 19.4346C168.742 20.6996 167.755 22.466 167.58 24.7344H161.071C161.29 22.1608 162.123 19.9799 163.569 18.1914C165.016 16.3592 166.944 14.9626 169.355 14.0029C171.766 12.9997 174.549 12.4981 177.705 12.498ZM215.931 12.498C220.446 12.4981 224.062 13.5448 226.78 15.6387C229.541 17.689 231.031 20.5248 231.251 24.1455H225.005C224.873 22.0517 223.996 20.4379 222.375 19.3037C220.797 18.1259 218.649 17.5362 215.931 17.5361C213.389 17.5361 211.439 18.0386 210.08 19.042C208.765 20.0453 208.107 21.3101 208.107 22.8369C208.107 24.0146 208.545 24.9525 209.422 25.6504C210.298 26.3047 211.438 26.8281 212.841 27.2207C214.243 27.5697 215.778 27.8968 217.443 28.2021C219.153 28.4639 220.841 28.8138 222.507 29.25C224.216 29.6862 225.772 30.2969 227.174 31.082C228.577 31.8236 229.694 32.8487 230.527 34.1572C231.404 35.4658 231.842 37.167 231.842 39.2607C231.842 42.6197 230.484 45.2593 227.766 47.1787C225.049 49.0981 221.432 50.0576 216.918 50.0576C213.718 50.0576 210.891 49.5124 208.436 48.4219C206.026 47.2877 204.162 45.7175 202.847 43.7109C201.532 41.6606 200.853 39.2174 200.809 36.3818H207.055C207.055 39.0429 207.954 41.1372 209.751 42.6641C211.548 44.1908 213.915 44.954 216.851 44.9541C219.35 44.9541 221.344 44.4961 222.835 43.5801C224.369 42.6204 225.136 41.3328 225.136 39.7188C225.136 38.4539 224.698 37.4505 223.821 36.709C222.988 35.9238 221.87 35.3132 220.467 34.877C219.065 34.4408 217.509 34.07 215.799 33.7646C214.134 33.4157 212.446 33.0231 210.737 32.5869C209.071 32.1071 207.537 31.5183 206.134 30.8203C204.732 30.0787 203.592 29.0965 202.716 27.875C201.839 26.6536 201.401 25.0615 201.401 23.0986C201.401 21.0483 201.992 19.2374 203.175 17.667C204.359 16.053 206.025 14.7881 208.173 13.8721C210.364 12.956 212.951 12.498 215.931 12.498ZM256.721 12.498C262.551 12.498 266.891 14.1118 269.74 17.3398C272.589 20.5244 273.839 24.9093 273.488 30.4932H245.038C245.026 30.8144 245.018 31.1417 245.018 31.4746C245.018 34.0481 245.456 36.3382 246.333 38.3447C247.253 40.3078 248.569 41.8352 250.278 42.9258C251.987 44.0163 254.048 44.5615 256.459 44.5615C259.308 44.5615 261.675 43.8854 263.559 42.5332C265.488 41.1809 266.672 39.3482 267.11 37.0361H273.751C273.181 41.093 271.362 44.2778 268.294 46.5898C265.225 48.9019 261.28 50.0576 256.459 50.0576C252.733 50.0576 249.511 49.3161 246.794 47.833C244.076 46.3063 241.994 44.1471 240.548 41.3555C239.101 38.52 238.378 35.1389 238.378 31.2129C238.378 27.2868 239.101 23.9277 240.548 21.1357C242.038 18.3438 244.141 16.2059 246.859 14.7227C249.621 13.2395 252.908 12.4981 256.721 12.498ZM314.673 49.2725H308.426L308.229 44.2344C306.958 45.9793 305.27 47.3967 303.166 48.4873C301.106 49.5342 298.805 50.0576 296.262 50.0576C293.063 50.0576 290.236 49.2508 287.781 47.6367C285.326 46.0227 283.397 43.7983 281.995 40.9629C280.636 38.1274 279.957 34.899 279.957 31.2783C279.957 27.614 280.636 24.3638 281.995 21.5283C283.397 18.6928 285.326 16.4894 287.781 14.9189C290.236 13.305 293.063 12.4981 296.262 12.498C298.761 12.498 301.04 12.9996 303.1 14.0029C305.16 14.9626 306.826 16.3156 308.097 18.0605V1.17773H314.673V49.2725ZM146.58 43.9072H159.007V49.2725H126.592V43.9072H139.939V18.6494H131.392V13.2832H146.58V43.9072ZM178.297 32.7178C175.316 32.7178 172.971 33.2848 171.261 34.4189C169.596 35.5531 168.763 37.1453 168.763 39.1953C168.763 40.8966 169.355 42.2278 170.539 43.1875C171.766 44.147 173.41 44.6269 175.469 44.627C178.099 44.627 180.423 43.9291 182.439 42.5332C184.26 41.2608 185.772 39.5786 186.976 37.4883V32.7178H178.297ZM106.776 18.0605C104.453 18.0606 102.371 18.7147 100.53 20.0234C98.6891 21.2885 97.3304 23.0768 96.4538 25.3887V37.1016C97.3305 39.37 98.689 41.1809 100.53 42.5332C102.371 43.8418 104.453 44.4961 106.776 44.4961C109.011 44.4961 110.962 43.929 112.628 42.7949C114.293 41.6607 115.586 40.1115 116.507 38.1484C117.427 36.1418 117.887 33.852 117.887 31.2783C117.887 28.6609 117.427 26.3703 116.507 24.4072C115.586 22.4007 114.293 20.8523 112.628 19.7617C110.962 18.6275 109.012 18.0605 106.776 18.0605ZM297.709 18.0605C295.517 18.0606 293.588 18.6275 291.923 19.7617C290.257 20.8523 288.942 22.4008 287.978 24.4072C287.058 26.3703 286.597 28.6609 286.597 31.2783C286.597 33.8519 287.058 36.1419 287.978 38.1484C288.942 40.1114 290.257 41.6607 291.923 42.7949C293.588 43.9291 295.517 44.4961 297.709 44.4961C300.076 44.4961 302.18 43.8419 304.021 42.5332C305.862 41.1809 307.221 39.37 308.097 37.1016V25.3887C307.221 23.0768 305.862 21.2885 304.021 20.0234C302.18 18.7147 300.076 18.0605 297.709 18.0605ZM256.721 17.9297C252.952 17.9297 250.059 19.1072 248.043 21.4629C247.077 22.5915 246.345 23.9462 245.841 25.5254L266.716 25.585C266.54 23.2731 265.532 21.4193 263.691 20.0234C261.85 18.6275 259.527 17.9297 256.721 17.9297ZM146.909 7.13281H139.479V0H146.909V7.13281Z" fill="var(--fg)" />
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function HandIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2" />
      <path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2" />
      <path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
    </svg>
  );
}

function ShieldCheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function ShieldAlertIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </svg>
  );
}

/** Release notes shown in the What's-new modal. Newest first; the top
 *  entry's version doubles as the unread marker (localStorage
 *  "changelogSeen"), so add new releases at the head. */
type ChangelogRelease = {
  version: string;
  /** ISO string from GitHub, or the free-text date written in CHANGELOG.md. */
  date: string | null;
  /** Markdown. Rendered as-is, so a release note needs no code change. */
  body: string;
};

/** `## <version> — <date>` starts a release; everything until the next one is
 *  its body. Deliberately forgiving: a malformed heading yields one fewer
 *  entry rather than throwing away the whole log. */
function parseChangelogMd(md: string): ChangelogRelease[] {
  const out: ChangelogRelease[] = [];
  let cur: ChangelogRelease | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (cur) out.push({ ...cur, body: buf.join("\n").trim() });
    buf = [];
  };
  for (const line of md.split("\n")) {
    const m = /^##\s+(.+?)\s+—\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      cur = { version: m[1].trim(), date: m[2].trim(), body: "" };
      continue;
    }
    if (cur) buf.push(line);
  }
  flush();
  return out;
}

/** GitHub gives an ISO timestamp; CHANGELOG.md gives prose someone wrote.
 *  Both land in the same field, and the fetched one wins, so an unformatted
 *  render shows "2026-08-21T17:41:30Z" as the heading. Parse what parses,
 *  pass through what does not. */
function releaseDateLabel(date: string | null): string {
  if (!date) return "";
  const t = Date.parse(date);
  if (Number.isNaN(t)) return date; // already human-written
  return new Date(t).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** Release notes are markdown now, so a new entry needs no code change. Plain
 *  remark-gfm only — no rehypeRaw. These come off the network, and the rule
 *  the chat renderer follows applies here too. */
// Module-level for stable identity: an inline object would hand Markdown a
// fresh component map every render and remount the whole notes subtree — the
// same hazard buildMdComponents documents. Stateless, so a const suffices.
const RELEASE_NOTE_COMPONENTS = {
  // Default markdown gives a ul the browser's 40px indent, which is what
  // overflowed the modal. Match the transcript's tighter indent.
  ul: (p: { children?: React.ReactNode }) => <ul style={{ margin: "6px 0", paddingLeft: 20 }}>{p.children}</ul>,
  ol: (p: { children?: React.ReactNode }) => <ol style={{ margin: "6px 0", paddingLeft: 20 }}>{p.children}</ol>,
  // A wide code block scrolls itself rather than the whole modal — notes are
  // markdown off the network, so someday one will have code.
  pre: (p: { children?: React.ReactNode }) => (
    <pre style={{ overflowX: "auto", maxWidth: "100%", background: "var(--code-bg)", borderRadius: 8, padding: "10px 12px" }}>
      {p.children}
    </pre>
  ),
};

function ReleaseNotes({ body }: { body: string }) {
  return (
    <div style={{ fontSize: 13.5, lineHeight: 1.55, color: "var(--fg-msg)", maxWidth: "100%", overflowWrap: "break-word" }}>
      <Markdown remarkPlugins={REMARK_PLUGINS} components={RELEASE_NOTE_COMPONENTS}>
        {body}
      </Markdown>
    </div>
  );
}

/** What ships in this build. Superseded by the releases repo when reachable. */
const BUNDLED_CHANGELOG: ChangelogRelease[] = parseChangelogMd(changelogMd);


function BellIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function ChangelogModal({
  releases,
  onClose,
}: {
  releases: ChangelogRelease[];
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", backdropFilter: "var(--scrim-blur)", WebkitBackdropFilter: "var(--scrim-blur)", display: "grid", placeItems: "center", zIndex: 100 }}
    >
      <div
        style={{
          width: 620,
          maxWidth: "calc(100vw - 48px)",
          maxHeight: "min(720px, calc(100vh - 96px))",
          display: "flex",
          flexDirection: "column",
          background: colors.panel,
          border: `1px solid ${colors.border}`,
          borderRadius: 16,
          boxShadow: "0 16px 48px rgba(0,0,0,0.55)",
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", padding: "20px 24px 6px", flexShrink: 0 }}>
          <div style={{ fontSize: 20, fontWeight: 650, color: colors.fg }}>What’s new</div>
          <span style={{ flex: 1 }} />
          <button
            onClick={onClose}
            title="Close"
            style={{
              width: 30,
              height: 30,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "transparent",
              border: `1px solid ${colors.border}`,
              borderRadius: 9,
              color: colors.dim,
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            ×
          </button>
        </div>
        {/* overflowX explicit: with only overflowY set, CSS computes the x
            axis from visible to auto, so ANY child a few px too wide grows a
            horizontal scrollbar — markdown's default 40px list indent did
            exactly that once the notes became rendered markdown. */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "6px 24px 22px" }}>
          {releases.map((rel, i) => (
            <div key={rel.version}>
              {i > 0 && <div style={{ height: 1, background: colors.border, margin: "22px 0" }} />}
              <div style={{ display: "flex", alignItems: "center", margin: "10px 0 2px" }}>
                <div style={{ fontSize: 16.5, fontWeight: 600, color: colors.fg }}>
                  {releaseDateLabel(rel.date)}
                </div>
                <span style={{ flex: 1 }} />
                <span
                  style={{
                    fontFamily: "var(--font-code)",
                    fontSize: 12,
                    color: colors.dim,
                    background: "var(--panel-2)",
                    border: `1px solid ${colors.border}`,
                    borderRadius: 7,
                    padding: "2px 8px",
                  }}
                >
                  {rel.version}
                </span>
              </div>
              <ReleaseNotes body={rel.body} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function GearIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}

/**
 * The boundary under a header — a soft edge rather than a rule.
 *
 * A 1px line at --gutter (#4c4c4c against this surface) is the brightest
 * horizontal element on the screen, and it was drawing more attention than the
 * content it was separating. This is the scroll-edge treatment instead: a
 * translucent hairline that fades out at both ends, over a short downward wash
 * that sits on the first few pixels of content. The eye reads a boundary
 * without a hard rule being drawn anywhere.
 *
 * Overflows below its header on purpose, so the wash falls across the content
 * rather than across the bar; the header therefore needs a stacking context of
 * its own, or the next sibling paints over it. Inert to the pointer.
 */
function HeaderEdge() {
  const hairline = "color-mix(in srgb, var(--fg) 9%, transparent)";
  return (
    <span
      aria-hidden="true"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: -14,
        height: 14,
        pointerEvents: "none",
        backgroundImage: [
          `linear-gradient(to right, transparent, ${hairline} 8%, ${hairline} 92%, transparent)`,
          "linear-gradient(to bottom, rgba(0, 0, 0, 0.30), rgba(0, 0, 0, 0))",
        ].join(", "),
        backgroundSize: "100% 1px, 100% 100%",
        backgroundRepeat: "no-repeat, no-repeat",
        backgroundPosition: "top left, top left",
      }}
    />
  );
}

// --chip, not an accent wash: every other surface in this chrome is a neutral
// grey mixed from surface+ink, so an accent tint at 12% resolves to #2e1917 —
// a warm maroon that is the only hue in the sidebar. The accent belongs in the
// rail, where a saturated 2px marker is exactly what says "selected"; the fill
// only needs to lift the row off the background, which is --chip's whole job.
function SidebarAction({
  onClick,
  disabled,
  icon,
  active,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  icon: React.ReactNode;
  /** Rows that lead somewhere you can still be — Scheduled — light up while
   *  you are there, using the same rail as a selected chat. The plain actions
   *  (New chat, Open project) never pass it: they do a thing and return. */
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        background: active ? "var(--chip)" : "transparent",
        boxShadow: active ? "inset 2px 0 0 0 var(--accent)" : "none",
        fontWeight: active ? 500 : 400,
        color: disabled ? colors.dim : active ? colors.fg : "var(--fg-soft)",
        border: "none",
        borderRadius: 8,
        padding: "8px 8px",
        // Left at 14. An earlier pass took the whole sidebar to 13.5 to
        // unify it; unified it did, but the sidebar went quiet with it.
        // Hierarchy is carried by weight and the active rail instead.
        fontSize: 14,
        letterSpacing: "var(--track-body)",
        cursor: disabled ? "default" : "pointer",
        textAlign: "left",
        fontFamily: "inherit",
      }}
    >
      {icon}
      {children}
    </button>
  );
}

function IconButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      style={{
        background: "transparent",
        border: "none",
        color: colors.dim,
        cursor: "pointer",
        padding: 4,
        display: "flex",
        alignItems: "center",
      }}
    >
      {children}
    </button>
  );
}

/** The final response's action row: copy, plus the settled time revealed
 *  when the pointer is anywhere over the row (Codex behavior). */
function AssistantActions({ text, at }: { text: string; at?: number }) {
  const [hover, setHover] = useState(false);
  return (
    <span
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ display: "inline-flex", alignItems: "center", gap: 10 }}
    >
      <CopyButton text={text} />
      {at !== undefined && (
        <span
          style={{
            color: colors.dim,
            fontSize: 12.5,
            opacity: hover ? 1 : 0,
            transition: "opacity 120ms var(--ease-out)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
        </span>
      )}
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      title="Copy reply"
      aria-label="Copy reply"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        background: "transparent",
        border: "none",
        color: copied ? colors.ok : colors.dim,
        fontSize: 12,
        cursor: "pointer",
        padding: "4px 0 0",
        fontFamily: "inherit",
      }}
    >
      {copied ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

function SectionLabel({
  children,
  collapsed,
  onToggle,
}: {
  children: React.ReactNode;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  // An overline, not another row. At 13.5/500 these labels carried the same
  // visual weight as the project and chat rows beneath them, so the sidebar
  // read as one flat list with no hierarchy. Small, uppercase and tracked-out
  // is the standard treatment precisely because it reads as a *category*
  // rather than a destination — and the wide tracking is what keeps 10.5px
  // uppercase legible.
  const base: React.CSSProperties = {
    color: colors.dim,
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "var(--track-overline)",
    padding: "18px 8px 6px",
  };
  if (!onToggle) return <div style={base}>{children}</div>;
  return (
    <button
      onClick={onToggle}
      aria-expanded={!collapsed}
      style={{
        ...base,
        display: "flex",
        alignItems: "center",
        gap: 6,
        width: "100%",
        background: "transparent",
        border: "none",
        textAlign: "left",
        cursor: "pointer",
        fontFamily: "inherit",
      }}
    >
      {children}
      <span
        style={{
          display: "inline-block",
          fontSize: 11,
          transform: collapsed ? "none" : "rotate(90deg)",
          transition: "transform 120ms var(--ease-out)",
        }}
      >
        ›
      </span>
    </button>
  );
}

/** Material Symbols edit_square — the new-chat glyph. */
function NewChatIcon({ size = 15 }: { size?: number } = {}) {
  return (
    <svg width={size} height={size} viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h357l-80 80H200v560h560v-278l80-80v358q0 33-23.5 56.5T760-120H200Zm280-360ZM360-360v-170l367-367q12-12 27-18t30-6q16 0 30.5 6t26.5 18l56 57q11 12 17 26.5t6 29.5q0 15-5.5 29.5T897-728L530-360H360Zm481-424-56-56 56 56ZM440-440h56l232-232-28-28-29-28-231 231v57Zm260-260-29-28 29 28 28 28-28-28Z" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function PanelIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </svg>
  );
}

function ChatPlusIcon({ size = 14, strokeWidth = 2 }: { size?: number; strokeWidth?: number } = {}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.5-.76L3 21l1.76-6A8.5 8.5 0 1 1 21 11.5Z" />
      <path d="M12 8v6" />
      <path d="M9 11h6" />
    </svg>
  );
}

function SideChatIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M14 4v16" />
    </svg>
  );
}

/** Floating × on an attachment card's top-right corner. */
function RemoveBadge({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{
        position: "absolute",
        top: -6,
        right: -6,
        width: 18,
        height: 18,
        borderRadius: 9,
        background: "var(--panel-2)",
        border: `1px solid ${colors.border}`,
        color: colors.fg,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
      }}
    >
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
        <path d="M18 6 6 18" />
        <path d="M6 6l12 12" />
      </svg>
    </button>
  );
}

function FileIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function FolderOutlineIcon({ size = 18 }: { size?: number } = {}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.2 3.9A2 2 0 0 0 7.5 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

function GlobeIcon({ size = 15 }: { size?: number } = {}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </svg>
  );
}

function FoldersIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 17a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3.9a2 2 0 0 1-1.69-.9l-.81-1.2a2 2 0 0 0-1.67-.9H8a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2Z" />
      <path d="M2 8v11a2 2 0 0 0 2 2h14" />
    </svg>
  );
}

function LightbulbIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
      <path d="M9 18h6" />
      <path d="M10 22h4" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function ReviewIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="4" />
      <path d="M12 7v4" />
      <path d="M10 9h4" />
      <path d="M9 15h6" />
    </svg>
  );
}

function TerminalIcon({ size = 15 }: { size?: number } = {}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="4" />
      <path d="m7.5 9 3 3-3 3" />
      <path d="M13 15h3.5" />
    </svg>
  );
}


/** A big launcher row in the empty side panel: icon, label, right hint. */
function LauncherRow({
  icon,
  label,
  hint,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        width: "100%",
        background: hover && !disabled ? "var(--panel-2)" : colors.panel,
        border: `1px solid ${colors.border}`,
        borderRadius: 12,
        padding: "14px 16px",
        fontSize: 14.5,
        color: disabled ? colors.dim : colors.fg,
        cursor: disabled ? "default" : "pointer",
        textAlign: "left",
        fontFamily: "inherit",
      }}
    >
      <span style={{ color: colors.dim, display: "flex", flexShrink: 0 }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {hint && <span style={{ color: colors.dim, fontSize: 12 }}>{hint}</span>}
    </button>
  );
}

/** A row in the + button's popup: icon, label, optional dim description. */
/** "Opens somewhere" — the quietest possible affordance, so a row that leads
 *  to a panel is distinguishable from one that acts in place. */
/** The chevron a select gets once the native one is turned off. Same stroke
 *  weight and size as MenuChevron — this is the app's chevron pointing down,
 *  not a second chevron vocabulary. */
function FieldChevron() {
  return (
    <span
      style={{ color: colors.dim, display: "flex", position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}
      aria-hidden="true"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m6 9 6 6 6-6" />
      </svg>
    </span>
  );
}


/** A select whose popup the app actually owns.
 *
 *  A native <select> is themeable everywhere except the one place that matters
 *  most: the open list is drawn by the OS, in the system font on a system blue
 *  highlight, and no CSS reaches it. Inside a dark themed panel that popup is
 *  the only thing on screen that does not belong to the app.
 *
 *  So the trigger stays a styled box and the list becomes ours, in the same
 *  vocabulary as the app's other menus (panel surface, 14 radius, 8 padding,
 *  the 0.45 shadow). Keyboard behaviour is rebuilt rather than inherited,
 *  because that is the part a custom select usually loses: arrows move,
 *  Home/End jump, Enter and Space commit, Escape cancels, and the trigger
 *  keeps focus throughout so the tab order is unchanged. */
function FieldSelect({
  id,
  value,
  options,
  onChange,
  triggerStyle,
}: {
  id: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  triggerStyle: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value));
  const current = options[selectedIndex];

  useEffect(() => {
    if (!open) return;
    setActive(selectedIndex);
    function onDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
    // selectedIndex is read once on open on purpose: re-syncing it while the
    // list is up would yank the highlight back under the user's arrow keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  function commit(i: number) {
    const opt = options[i];
    if (opt) onChange(opt.value);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      // Down/Up/Enter/Space all open a closed select, matching the native one.
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); return; }
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); commit(active); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(options.length - 1, i + 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); return; }
    if (e.key === "Home") { e.preventDefault(); setActive(0); return; }
    if (e.key === "End") { e.preventDefault(); setActive(options.length - 1); return; }
  }

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        id={id}
        type="button"
        className="u-field"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-activedescendant={open ? `${id}-opt-${active}` : undefined}
        data-nopress
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
        style={{ ...triggerStyle, textAlign: "left", cursor: "pointer", display: "block" }}
      >
        {current?.label ?? ""}
      </button>
      <FieldChevron />
      {open && (
        <div
          ref={listRef}
          role="listbox"
          data-popover
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            right: 0,
            maxHeight: 260,
            overflowY: "auto",
            background: colors.panel,
            border: `1px solid ${colors.border}`,
            borderRadius: 14,
            padding: 8,
            zIndex: 40,
            boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
            // Grows out of the trigger rather than appearing from nothing:
            // origin at the top edge, ease-out, inside the 150-250ms band a
            // select needs to still read as instant.
            transformOrigin: "top center",
            animation: "unbiased-field-pop 150ms var(--ease-out)",
          }}
        >
          {options.map((opt, i) => {
            const isSelected = opt.value === value;
            return (
              <div
                key={opt.value}
                id={`${id}-opt-${i}`}
                data-idx={i}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setActive(i)}
                onClick={() => commit(i)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 10px",
                  borderRadius: 8,
                  cursor: "pointer",
                  fontSize: 13.5,
                  letterSpacing: "var(--track-body)",
                  // The highlight follows the keyboard AND the pointer, so
                  // there is never a second, competing "current" row.
                  background: i === active ? "var(--chip)" : "transparent",
                  color: isSelected ? colors.accent : colors.fg,
                }}
              >
                <span style={{ width: 14, display: "flex", flexShrink: 0, opacity: isSelected ? 1 : 0 }} aria-hidden="true">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                </span>
                <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {opt.label}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The time field, with the app's own picker panel.
 *
 *  Deliberately NOT a full replacement: the <input type="time"> stays, so
 *  typing a time, the segment behaviour and the field's own keyboard handling
 *  are untouched. Only Chrome's picker panel is swapped — it renders white
 *  with a system-blue selection and is unreachable from CSS, which inside a
 *  dark themed form is the one element that visibly is not ours.
 *
 *  Minutes are listed in full rather than in five-minute steps. Coarser
 *  columns would look tidier and would quietly remove the ability to schedule
 *  anything at 09:07. */
function FieldTime({
  id,
  value,
  onChange,
  style,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  style: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const [hh, mm] = (value || "09:00").split(":").map((n) => Number(n) || 0);
  const isPm = hh >= 12;
  const hour12 = hh % 12 === 0 ? 12 : hh % 12;

  function emit(h12: number, minute: number, pm: boolean) {
    const h24 = pm ? (h12 === 12 ? 12 : h12 + 12) : h12 === 12 ? 0 : h12;
    onChange(`${String(h24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
  }

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    // Land each column on its current value instead of at the top, so the
    // panel opens showing where you already are.
    panelRef.current?.querySelectorAll<HTMLElement>("[data-sel=\"1\"]").forEach((el) => el.scrollIntoView({ block: "center" }));
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const col: React.CSSProperties = {
    maxHeight: 208,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 2,
    padding: 4,
    flex: 1,
    minWidth: 0,
  };
  function cell(selected: boolean): React.CSSProperties {
    return {
      padding: "6px 8px",
      borderRadius: 8,
      cursor: "pointer",
      fontSize: 13.5,
      textAlign: "center",
      fontVariantNumeric: "tabular-nums",
      background: selected ? colors.accent : "transparent",
      color: selected ? "var(--accent-fg)" : colors.fg,
      flexShrink: 0,
    };
  }

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <input
        id={id}
        className="u-field"
        type="time"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...style, paddingRight: 34 }}
      />
      {/* The clock is a real button now that the native one is gone. */}
      <button
        type="button"
        aria-label="Choose a time"
        aria-expanded={open}
        data-nopress
        onClick={() => setOpen((o) => !o)}
        style={{
          position: "absolute",
          right: 6,
          top: "50%",
          transform: "translateY(-50%)",
          display: "flex",
          alignItems: "center",
          background: "transparent",
          border: "none",
          borderRadius: 8,
          padding: 6,
          color: open ? colors.accent : colors.dim,
          cursor: "pointer",
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      </button>
      {open && (
        <div
          ref={panelRef}
          data-popover
          role="dialog"
          aria-label="Choose a time"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            display: "flex",
            gap: 4,
            width: 232,
            background: colors.panel,
            border: `1px solid ${colors.border}`,
            borderRadius: 14,
            padding: 4,
            zIndex: 40,
            boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
            transformOrigin: "top left",
            animation: "unbiased-field-pop 150ms var(--ease-out)",
          }}
        >
          <div style={col}>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
              <div key={h} data-sel={h === hour12 ? "1" : "0"} onClick={() => emit(h, mm, isPm)} style={cell(h === hour12)}>
                {String(h).padStart(2, "0")}
              </div>
            ))}
          </div>
          <div style={col}>
            {Array.from({ length: 60 }, (_, i) => i).map((m) => (
              <div key={m} data-sel={m === mm ? "1" : "0"} onClick={() => emit(hour12, m, isPm)} style={cell(m === mm)}>
                {String(m).padStart(2, "0")}
              </div>
            ))}
          </div>
          <div style={{ ...col, flex: "0 0 58px", overflowY: "visible" }}>
            {[false, true].map((pm) => (
              <div key={String(pm)} data-sel={pm === isPm ? "1" : "0"} onClick={() => emit(hour12, mm, pm)} style={cell(pm === isPm)}>
                {pm ? "PM" : "AM"}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MenuChevron() {
  return (
    <span style={{ color: colors.dim, display: "flex" }} aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m9 18 6-6-6-6" />
      </svg>
    </span>
  );
}

/** Current state for a row that toggles rather than navigates. Says what IS,
 *  not what clicking will do — the description already covers the action, and
 *  a label that flips between "on" and "off" is the classic ambiguous toggle. */
function StatePill({ on }: { on: boolean }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "var(--track-overline)",
        textTransform: "uppercase",
        padding: "3px 8px",
        borderRadius: 999,
        color: on ? "var(--accent-fg)" : colors.dim,
        background: on ? colors.accent : "var(--chip)",
      }}
    >
      {on ? "On" : "Off"}
    </span>
  );
}

function MenuItem({
  icon,
  label,
  desc,
  disabled,
  trailing,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  desc?: string;
  disabled?: boolean;
  /** Right-edge slot: a state chip, or a chevron for rows that open a panel.
   *  At full width the right edge is otherwise dead space, and "does this go
   *  somewhere or toggle something?" is exactly what it should answer. */
  trailing?: React.ReactNode;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      // A menu row is a full-width target, so the global press-scale would
      // read as the menu itself moving. The hover fill is the feedback here.
      data-nopress
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        background: hover && !disabled ? "var(--chip)" : "transparent",
        border: "none",
        borderRadius: 8,
        padding: "7px 10px",
        fontSize: 13.5,
        letterSpacing: "var(--track-body)",
        color: disabled ? colors.dim : colors.fg,
        cursor: disabled ? "default" : "pointer",
        textAlign: "left",
        fontFamily: "inherit",
        transition: "background 120ms ease",
      }}
    >
      {/* --fg-soft, not --dim: the icon names the row as much as the label
          does, and at --dim it was the faintest thing in it. */}
      <span
        style={{
          color: disabled ? colors.dim : "var(--fg-soft)",
          display: "flex",
          justifyContent: "center",
          width: 18,
          flexShrink: 0,
        }}
      >
        {icon}
      </span>
      {/* Fixed column. Ragged labels give the descriptions a ragged left
          edge too, which is what reads as clutter at this width. */}
      <span style={{ whiteSpace: "nowrap", minWidth: 148, flexShrink: 0 }}>{label}</span>
      {desc && (
        <span
          style={{
            flex: 1,
            minWidth: 0,
            color: colors.dim,
            fontSize: 12.5,
            letterSpacing: "var(--track-meta)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {desc}
        </span>
      )}
      {trailing && (
        <span style={{ display: "flex", alignItems: "center", flexShrink: 0, marginLeft: 12 }}>
          {trailing}
        </span>
      )}
    </button>
  );
}

function CheckIcon({ size = 14 }: { size?: number } = {}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function AnnotationIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18" />
      <path d="M6 6l12 12" />
    </svg>
  );
}

/** Connectors. A plug, drawn at the same 16px/1.7 stroke as the rest of the
 *  sidebar set so it sits level with New chat and Scheduled. */
function PlugIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 2v6" />
      <path d="M15 2v6" />
      <path d="M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6V8Z" />
      <path d="M12 17v5" />
    </svg>
  );
}

function ClockIcon({ size = 15 }: { size?: number } = {}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </svg>
  );
}

function FolderPlusIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.2 3.9A2 2 0 0 0 7.5 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
      <path d="M12 10v6" />
      <path d="M9 13h6" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: colors.accent, flexShrink: 0 }}>
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.2 3.9A2 2 0 0 0 7.5 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
    </svg>
  );
}

function ArchiveIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <rect x="2" y="4" width="20" height="5" rx="1" />
      <path d="M4 9v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9" />
      <path d="M10 13h4" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

function ThreadRow({
  thread,
  active,
  hovered,
  running,
  indent,
  onHover,
  onOpen,
  menuOpen,
  onMenu,
}: {
  thread: ThreadSummary;
  active: boolean;
  hovered: boolean;
  running?: boolean;
  indent?: boolean;
  onHover: (id: string | null) => void;
  onOpen: (id: string) => Promise<void>;
  menuOpen?: boolean;
  onMenu: (x: number, y: number) => void;
}) {
  return (
    <div
      onMouseEnter={() => onHover(thread.id)}
      onMouseLeave={() => onHover(null)}
      style={{
        display: "flex",
        alignItems: "center",
        // The active row was a flat --chip fill, the same treatment hover and
        // open popovers use — so "which chat am I in" competed with "what is
        // my cursor over". An accent rail plus a tinted fill says *selected*
        // in a way no neutral shade can, and the 2px inset keeps the text
        // baseline aligned with the inactive rows above and below it.
        background: active ? "var(--chip)" : "transparent",
        boxShadow: active ? "inset 2px 0 0 0 var(--accent)" : "none",
        borderRadius: 8,
        marginBottom: 1,
        paddingLeft: indent ? 25 : 0,
      }}
    >
      <button
        onClick={() => void onOpen(thread.id)}
        title={thread.title}
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          gap: 7,
          background: "transparent",
          color: active ? colors.fg : "var(--fg-soft)",
          border: "none",
          padding: "8px 4px 8px 8px",
          // Back at 14; the active state is carried by weight and the accent
          // rail rather than by shrinking every inactive row.
          fontSize: 14,
          fontWeight: active ? 500 : 400,
          letterSpacing: "var(--track-body)",
          textAlign: "left",
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        <span
          style={{
            minWidth: 0,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {thread.title}
        </span>
        {running && (
          <span
            aria-label="Turn running"
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "var(--accent)",
              flexShrink: 0,
              animation: "unbiased-pulse 1.2s ease-in-out infinite",
            }}
          />
        )}
      </button>
      {(hovered || menuOpen) && (
        <button
          data-threadmenu
          onClick={(e) => {
            const r = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
            onMenu(r.right, r.bottom + 6);
          }}
          title="Conversation options"
          aria-label="Conversation options"
          aria-expanded={menuOpen}
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            background: "transparent",
            color: colors.dim,
            border: "none",
            padding: "6px 8px",
            cursor: "pointer",
            lineHeight: 1,
          }}
        >
          <EllipsisIcon />
        </button>
      )}
    </div>
  );
}

function QueueIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M4 6h13" />
      <path d="M4 11h9" />
      <path d="M4 16h6" />
      <path d="m14 14 3 3-3 3" />
    </svg>
  );
}

function SteerIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="m15 5 5 5-5 5" />
      <path d="M4 18v-4a4 4 0 0 1 4-4h12" />
    </svg>
  );
}

function EllipsisIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </svg>
  );
}

/** A message waiting its turn, shown above the composer: Steer (run it
 *  next, interrupting the current turn), delete, and a ⋯ menu. */
function QueuedRow({
  q,
  onSteer,
  onDelete,
  onEdit,
  onOpenSideChat,
}: {
  q: QueuedMsg;
  onSteer: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onOpenSideChat?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        background: colors.panel,
        border: `1px solid ${colors.border}`,
        borderRadius: 14,
        padding: "9px 10px 9px 14px",
      }}
    >
      <span style={{ color: colors.dim, display: "flex" }}>
        <QueueIcon />
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          fontSize: 14,
          color: colors.fg,
        }}
        title={q.text}
      >
        {q.text.split("\n")[0]}
      </span>
      <button
        onClick={onSteer}
        title="Interrupt the current turn and run this next"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          background: "transparent",
          border: "none",
          color: colors.dim,
          fontSize: 13.5,
          cursor: "pointer",
          fontFamily: "inherit",
          padding: "4px 6px",
          flexShrink: 0,
        }}
      >
        <SteerIcon />
        Steer
      </button>
      <button
        onClick={onDelete}
        title="Remove from queue"
        aria-label="Remove from queue"
        style={{
          display: "flex",
          background: "transparent",
          border: "none",
          color: colors.dim,
          cursor: "pointer",
          padding: 4,
          flexShrink: 0,
        }}
      >
        <TrashIcon />
      </button>
      <span ref={menuRef} style={{ position: "relative", display: "flex", flexShrink: 0 }}>
        <button
          onClick={() => setMenuOpen((o) => !o)}
          aria-label="More options"
          aria-expanded={menuOpen}
          style={{
            display: "flex",
            background: menuOpen ? "var(--chip)" : "transparent",
            border: "none",
            borderRadius: 8,
            color: colors.dim,
            cursor: "pointer",
            padding: 5,
          }}
        >
          <EllipsisIcon />
        </button>
        {menuOpen && (
          <div
            style={{
              position: "absolute",
              top: "calc(100% + 6px)",
              right: 0,
              minWidth: 210,
              background: colors.panel,
              border: `1px solid ${colors.border}`,
              borderRadius: 12,
              padding: 6,
              zIndex: 25,
              boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
            }}
          >
            <MenuItem
              icon={<PencilIcon />}
              label="Edit message"
              onClick={() => {
                setMenuOpen(false);
                onEdit();
              }}
            />
            {onOpenSideChat && (
              <MenuItem
                icon={<ChatPlusIcon />}
                label="Open in side chat"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenSideChat();
                }}
              />
            )}
          </div>
        )}
      </span>
    </div>
  );
}

/** Codex-style Permissions card: title derived from what's being asked,
 *  Deny (Esc) and a split Allow button — once (Enter) or, via the
 *  chevron, for the whole conversation (acceptForSession). */
// Every mounted prompt installs its own document-level key handler, so with
// two cards awaiting a decision one Enter approved BOTH — in the surface the
// entire consent model rests on. Tracked here so the key acts only when a
// single card is pending; with more than one, which card Enter means is
// genuinely ambiguous and guessing approves a command nobody read.
const mountedPrompts = new Set<object>();

function PermissionsPrompt({
  approval,
  onDecide,
}: {
  approval: {
    reason: string | null;
    kind?: "command" | "fileChange" | "mcpTool";
    grantRoot?: string | null;
    message?: string | null;
  };
  onDecide: (d: ApprovalDecision) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLSpanElement>(null);
  // The listener is installed once, so it would otherwise answer with the
  // first render's onDecide forever.
  const onDecideRef = useRef(onDecide);
  useEffect(() => {
    onDecideRef.current = onDecide;
  });

  useEffect(() => {
    const token = {};
    mountedPrompts.add(token);
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      // Never steal Enter/Escape from the composer or other inputs.
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      // Two cards pending means two listeners; acting on either would decide
      // both. Require a click instead — see mountedPrompts above.
      if (mountedPrompts.size !== 1) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onDecideRef.current("decline");
      } else if (e.key === "Enter") {
        e.preventDefault();
        onDecideRef.current("accept");
      }
    }
    function onDown(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      mountedPrompts.delete(token);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rootName = approval.grantRoot?.split("/").filter(Boolean).pop();
  const title =
    // An MCP tool call arrives with codex's own wording, which names the
    // server and the tool. Showing it verbatim keeps the card truthful when
    // the engine changes its phrasing, and avoids inventing a sentence that
    // cannot mention the tool (the request carries no tool field).
    approval.kind === "mcpTool" ? (
      <>{approval.message ?? "Allow Pareto to run this MCP tool?"}</>
    ) : approval.kind === "fileChange" ? (
      rootName ? (
        <>
          Allow Pareto to edit the contents of{" "}
          <span style={{ color: colors.accent, display: "inline-flex", alignItems: "center", gap: 4 }}>
            <FolderOutlineIcon size={13} />
            {rootName}
          </span>
          ?
        </>
      ) : (
        <>Allow Pareto to apply these file changes?</>
      )
    ) : (
      <>Allow Pareto to run this command?</>
    );

  return (
    <div style={{ marginTop: 12, fontFamily: "var(--font-ui)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: colors.dim, fontSize: 12.5 }}>
        <HandIcon />
        Permissions
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color: colors.fg, marginTop: 8 }}>{title}</div>
      {approval.reason && (
        // pre-wrap because a reason can now be a details block (the scheduled
        // task card lists cadence, directory and the verbatim prompt) rather
        // than always being one sentence.
        <div style={{ color: colors.dim, fontSize: 13, marginTop: 4, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
          {approval.reason}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10, marginTop: 14 }}>
        <button
          onClick={() => onDecide("decline")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: "var(--chip)",
            color: colors.fg,
            border: "none",
            borderRadius: 999,
            padding: "8px 14px",
            fontSize: 13.5,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          Deny
          <span
            style={{
              background: "var(--panel-2)",
              color: colors.dim,
              borderRadius: 6,
              padding: "1px 7px",
              fontSize: 11,
            }}
          >
            Esc
          </span>
        </button>
        <span ref={menuRef} style={{ position: "relative", display: "flex" }}>
          <button
            onClick={() => onDecide("accept")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: colors.fg,
              color: "var(--bg)",
              border: "none",
              borderRadius: "999px 0 0 999px",
              padding: "8px 10px 8px 16px",
              fontSize: 13.5,
              fontWeight: 500,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Allow once
            <span style={{ opacity: 0.55, fontSize: 12 }}>⏎</span>
          </button>
          <button
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="More allow options"
            aria-expanded={menuOpen}
            style={{
              display: "flex",
              alignItems: "center",
              background: colors.fg,
              color: "var(--bg)",
              border: "none",
              borderLeft: "1px solid var(--gutter)",
              borderRadius: "0 999px 999px 0",
              padding: "8px 10px 8px 8px",
              cursor: "pointer",
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          {menuOpen && (
            <div
              style={{
                position: "absolute",
                bottom: "calc(100% + 8px)",
                right: 0,
                minWidth: 230,
                background: colors.panel,
                border: `1px solid ${colors.border}`,
                borderRadius: 12,
                padding: 6,
                zIndex: 20,
                boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
              }}
            >
              {(
                [
                  { label: "Allow once", d: "accept" },
                  { label: "Allow this conversation", d: "acceptForSession" },
                ] as { label: string; d: ApprovalDecision }[]
              ).map((opt) => (
                <button
                  key={opt.d}
                  onClick={() => {
                    setMenuOpen(false);
                    onDecide(opt.d);
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    background: "transparent",
                    border: "none",
                    borderRadius: 8,
                    padding: "9px 12px",
                    fontSize: 13.5,
                    color: colors.fg,
                    cursor: "pointer",
                    textAlign: "left",
                    fontFamily: "inherit",
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </span>
      </div>
    </div>
  );
}

function ChatFooter({ status, busy }: { status: EngineStatus; busy: boolean }) {
  return (
    <footer
      style={{
        padding: "10px 14px",
        borderTop: `1px solid ${colors.border}`,
        fontSize: 11.5,
        color: colors.dim,
        display: "flex",
        gap: 7,
        alignItems: "center",
        fontVariantNumeric: "tabular-nums",
        flexShrink: 0,
        whiteSpace: "nowrap",
        overflow: "hidden",
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: 4,
          flexShrink: 0,
          background:
            status.state === "connected" ? colors.ok : status.state === "starting" ? colors.accent : colors.err,
        }}
      />
      {status.state === "connected" && (
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
          connected · pareto · engine {status.engineVersion}
          {busy ? " · thinking…" : ""}
        </span>
      )}
      {status.state === "starting" && <span>starting engine…</span>}
      {status.state === "exited" && (
        <span style={{ color: colors.err, overflow: "hidden", textOverflow: "ellipsis" }} title={status.detail}>
          {status.detail}
        </span>
      )}
    </footer>
  );
}

/** Set by App; read by StepsGroup, which sits outside the component tree that
 *  owns the side panel. A module ref beats threading a prop through six
 *  layers for one label. */
const openAgentMirrorRef: { current: (() => void) | null } = { current: null };
/** Same indirection for the close side: ChatPane ends the turn, App owns the
 *  panel. */
const closeAgentMirrorRef: { current: (() => void) | null } = { current: null };

/** A step driven by the agent browser. Keyed on the tool name rather than the
 *  human label, which is localised prose and changes. */
function isBrowserStep(e: CommandEntry): boolean {
  const c = e.command ?? "";
  return c.startsWith("browser_") || c.startsWith("Browse the web") || c.startsWith("Use a signed-in browser session");
}

function StepsGroup({
  items,
  statusLabel,
  decide,
}: {
  items: CommandEntry[];
  statusLabel: (e: CommandEntry) => { text: string; color: string };
  decide: (itemId: string, requestId: string, decision: ApprovalDecision) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [openItems, setOpenItems] = useState<Set<string>>(new Set());
  const needsApproval = items.some(
    (e) => e.status === "awaitingApproval" && e.approval && !e.approval.decision && !e.approval.expired,
  );

  const toggleItem = (itemId: string) =>
    setOpenItems((s) => {
      const next = new Set(s);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  const running = items.some((e) => e.status === "inProgress");
  const failed = items.some((e) => e.status === "failed" || (e.exitCode ?? 0) !== 0);
  // A hidden approval would hang the turn on a question nobody can see.
  const expanded = open || needsApproval;

  // Browser work says so, and says it about a thing the user can go look at.
  const browsing = items.some(isBrowserStep);
  const summary = needsApproval
    ? { text: "Needs your approval", color: colors.fg, verb: null as string | null }
    : running
      ? { text: browsing ? "Using" : "Working…", color: colors.amber, verb: browsing ? "Using" : null }
      : browsing
        ? { text: "Used", color: failed ? colors.err : colors.dim, verb: "Used" }
        : {
            text: `Worked · ${items.length} step${items.length === 1 ? "" : "s"}${failed ? " · issues" : ""}`,
            color: failed ? colors.err : colors.dim,
            verb: null,
          };

  return (
    <div style={{ margin: "14px 0" }}>
      {/* A row, not one button: the browser's name is its own control, and a
          button inside a button is invalid markup. */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={expanded}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "transparent",
            border: "none",
            color: summary.color,
            fontSize: 13.5,
            cursor: "pointer",
            padding: "2px 0",
            fontFamily: "var(--font-ui)",
          }}
        >
          {running && !needsApproval ? <ShimmerText text={summary.text} fontSize={13.5} /> : summary.text}
        </button>
        {summary.verb && (
          <button
            onClick={() => openAgentMirrorRef.current?.()}
            title="Show the agent browser in the side panel"
            style={{
              background: "transparent",
              border: "none",
              padding: "2px 0",
              color: colors.accent,
              fontSize: 13.5,
              cursor: "pointer",
              fontFamily: "var(--font-ui)",
              textDecoration: "none",
            }}
          >
            {/* Inline emoji + name, the same shape sub-agent rows use. Kept
                inside the button so the icon is part of the click target, and
                marked decorative — the adjacent word already names it. */}
            <span aria-hidden="true" style={{ fontSize: 13, marginRight: 5 }}>
              🌐
            </span>
            Agent Browser
          </button>
        )}
        <button
          onClick={() => setOpen((o) => !o)}
          aria-label={expanded ? "Hide steps" : "Show steps"}
          style={{
            background: "transparent",
            border: "none",
            padding: 0,
            color: summary.color,
            cursor: "pointer",
            display: "inline-block",
            transform: expanded ? "rotate(90deg)" : "none",
            transition: "transform 120ms var(--ease-out)",
            fontSize: 11,
            marginTop: 1,
          }}
        >
          ›
        </button>
      </div>
      {expanded &&
        items.map((e) => {
          const label = statusLabel(e);
          const hasOutput = Boolean(e.output);
          const itemOpen = openItems.has(e.itemId);
          return (
            <div
              key={e.itemId}
              style={{
                margin: "8px 0",
                padding: "10px 14px",
                borderRadius: 12,
                border: `1px solid ${
                  e.status === "awaitingApproval" && !e.approval?.expired ? colors.amber : colors.border
                }`,
                background: "var(--code-bg)",
                fontSize: 12.5,
                fontFamily: "var(--font-code)",
              }}
            >
              <div
                onClick={hasOutput ? () => toggleItem(e.itemId) : undefined}
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "baseline",
                  cursor: hasOutput ? "pointer" : "default",
                }}
              >
                <span
                  style={{
                    color: hasOutput ? colors.dim : "transparent",
                    flexShrink: 0,
                    fontSize: 9,
                    display: "inline-block",
                    transform: itemOpen ? "rotate(90deg)" : "none",
                    transition: "transform 120ms var(--ease-out)",
                  }}
                >
                  ▶
                </span>
                <span style={{ color: label.color, flexShrink: 0 }}>{label.text}</span>
                <span style={{ whiteSpace: "pre-wrap", color: colors.fg, minWidth: 0, overflowWrap: "anywhere" }}>
                  {e.command}
                </span>
              </div>
              {e.status === "awaitingApproval" && e.approval && !e.approval.decision && (
                e.approval.expired ? (
                  <div style={{ marginTop: 8, fontSize: 12.5, color: colors.dim, lineHeight: 1.5 }}>
                    This request is no longer active — the turn behind it ended, usually because the
                    app was closed. Ask again to run it.
                  </div>
                ) : (
                  <PermissionsPrompt
                    approval={e.approval}
                    onDecide={(d) => void decide(e.itemId, e.approval!.requestId, d)}
                  />
                )
              )}
              {e.output && itemOpen && (
                <pre
                  style={{
                    margin: "8px 0 0",
                    color: colors.dim,
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                    maxHeight: 200,
                    overflowY: "auto",
                  }}
                >
                  {e.output.length > 4000 ? e.output.slice(0, 4000) + "\n… (truncated)" : e.output}
                </pre>
              )}
            </div>
          );
        })}
    </div>
  );
}
