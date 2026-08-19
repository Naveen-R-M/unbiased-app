import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
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
        requestId: string;
        reason: string | null;
        kind?: "command" | "fileChange";
        grantRoot?: string | null;
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
type SidebarData = {
  projects: ProjectInfo[];
  recents: ThreadSummary[];
  running?: string[];
};

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

// An approval request replayed when a backgrounded conversation reopens
// (same payload as the live chat:approval-request event, minus paneId).
type HeldApproval = {
  requestId: string;
  kind?: "command" | "fileChange";
  itemId: string | null;
  command: string;
  cwd: string | null;
  reason: string | null;
  grantRoot?: string | null;
  // Present when the request came from a sub-agent's thread (multi-agent) —
  // the card renders in the parent's pane, tagged with the agent's name.
  agentName?: string;
};

// A spawned sub-agent (multi-agent v2): its own engine thread, grouped
// under the parent conversation. name = the model-chosen task name.
type SubAgent = { threadId: string; name: string; path: string; status: string };

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
      authStatus: () => Promise<{ hasKey: boolean; source: "env" | "file" | null }>;
      authValidate: (key?: string) => Promise<WhoamiResult>;
      authLogin: (key?: string) => Promise<WhoamiResult>;
      authLogout: (removeKey?: boolean) => Promise<{ ok: boolean; envKeyRemains: boolean }>;
      sendMessage: (
        paneId: PaneId,
        text: string,
        attachments?: Attachment[],
      ) => Promise<{ turnId: string | null; threadId: string; created: boolean }>;
      chooseAttachments: () => Promise<{ attachments: Attachment[] }>;
      clipboardHasImage: () => Promise<boolean>;
      clipboardImage: () => Promise<{ attachment: Attachment | null }>;
      interrupt: (paneId: PaneId) => Promise<{ interrupted: boolean }>;
      compact: (paneId: PaneId) => Promise<{ ok: boolean; error?: string }>;
      onTurnStarted: (cb: (p: { paneId: PaneId; turnId: string | null }) => void) => () => void;
      onDelta: (cb: (p: { paneId: PaneId; delta: string }) => void) => () => void;
      onTurnCompleted: (
        cb: (p: { paneId: PaneId; status: string; error?: string | null }) => void,
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
      decideApproval: (requestId: string, decision: ApprovalDecision) => Promise<{ ok: boolean }>;
      onApprovalCanceled: (cb: (p: { paneId: PaneId; requestId: string }) => void) => () => void;
      onApprovalRequest: (
        cb: (p: {
          paneId: PaneId;
          requestId: string;
          kind?: "command" | "fileChange";
          itemId: string | null;
          command: string;
          cwd: string | null;
          reason: string | null;
          grantRoot?: string | null;
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

/** Derive every chrome shade from surface + ink + contrast, Codex-style. */
function themeVars(t: ThemeConfig): Record<string, string> {
  const k = Math.max(t.contrast, 5) / 50;
  const m = (x: number) => mixHex(t.surface, t.ink, Math.min(x * k, 1));
  const accentRgb = hexToRgb(t.accent) ?? [255, 86, 63];
  const accentLuma = (0.299 * accentRgb[0] + 0.587 * accentRgb[1] + 0.114 * accentRgb[2]) / 255;
  return {
    "--bg": t.surface,
    "--fg": t.ink,
    "--accent": t.accent,
    "--accent-fg": accentLuma > 0.6 ? "#111111" : "#ffffff",
    "--nav-bg": mixHex(t.surface, "#000000", 0.14),
    "--code-bg": mixHex(t.surface, "#000000", 0.3),
    "--code-fg": mixHex(t.ink, t.surface, 0.14),
    "--panel": m(0.05),
    "--panel-2": m(0.09),
    "--chip": m(0.09),
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
  const [showSettings, setShowSettings] = useState(false);
  const [showChangelog, setShowChangelog] = useState(false);
  // Unread until the user has opened the log at its current top version.
  const [changelogUnread, setChangelogUnread] = useState(
    () => localStorage.getItem("changelogSeen") !== CHANGELOG[0].version,
  );
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
      window.unbiased.onUpdateStaged(() => {
        // Downloaded and verified — now it's the user's call when to restart.
        setUpdateProgress(null);
        setUpdateStaged(true);
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
      // A finished background turn may retitle/reorder its thread.
      if (!p.running) void refreshThreads();
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
      resetSideView();
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
        resetSideView();
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
      panelMode,
      sideOpen,
    });
  }

  /** Restore a conversation's saved side panel; false = nothing to restore. */
  function restoreSideView(id: string): boolean {
    const snap = sidePanelSnapshots.current.get(id);
    if (!snap) return false;
    const hasTabs =
      snap.openAgents.length > 0 || snap.openFiles.length > 0 || snap.filesTabs.length > 0 || snap.reviewOpen;
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
    // A stale active key (e.g. a dropped terminal) falls back to the most
    // recent surviving tab via the strip's own effect.
    setPanelMode(snap.panelMode);
    setSideOpenPersisted(snap.sideOpen);
    return true;
  }

  function resetSideView() {
    setSideContexts({});
    setSideNonce((n) => n + 1);
    setOpenFiles([]);
    setOpenAgents([]); // the agents belonged to the previous conversation
    setSubAgentsList([]);
    setFilesTabs([]); // the trees browsed the previous conversation's cwd
    setTreeFiles({});
    setTerminalTabs([]); // the shells ran in the previous conversation's cwd
    setReviewOpen(false); // the diff reviewed the previous conversation's cwd
    // The browser isn't cwd-bound — the page you're reading survives.
    setPanelMode(
      browserTabs.length > 0
        ? `browser:${browserTabs[browserTabs.length - 1]}`
        : sideChats.length > 0
          ? sideChats[sideChats.length - 1]
          : "launcher",
    );
    if (sideChats.length === 0 && browserTabs.length === 0) setSideOpenPersisted(false);
  }

  // Switching away from a running conversation is fine — its turn keeps
  // going in the engine and the sidebar shows it as active. Only genuinely
  // destructive actions still wait.
  async function newChat(project?: { name: string; path: string }) {
    snapshotSideView();
    await window.unbiased.detachThread(project?.path);
    setActiveProject(project ?? null);
    setActiveThreadId(null);
    setMainStarted(false);
    setMainReset((r) => ({ entries: [], nonce: r.nonce + 1 }));
    resetSideView();
  }

  async function openProjectDialog() {
    const { path, name } = await window.unbiased.chooseProject();
    if (!path || !name) return; // cancelled
    snapshotSideView();
    setActiveProject({ name, path });
    setActiveThreadId(null);
    setMainStarted(false);
    setMainReset((r) => ({ entries: [], nonce: r.nonce + 1 }));
    resetSideView();
    void refreshThreads(); // the project shows in the sidebar immediately
  }

  const openSeqRef = useRef(0);
  async function openThread(id: string) {
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
    const cachedRichness = (cached.entries ?? []).reduce(
      (n, e) => n + (e.kind === "work" ? Math.max(e.entries.length, 1) : 1),
      0,
    );
    let entries = cached.entries && cachedRichness >= history.length ? cached.entries : history;
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
      resetSideView();
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
      if (p.paneId === "main") setSubAgentsList(p.agents);
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
  const [browserTabs, setBrowserTabs] = useState<number[]>([]);
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
  useEffect(() => {
    if (!sideOpen || panelMode === "launcher") return;
    if (tabKeys.includes(panelMode)) return;
    if (tabOrder.length > 0) setPanelMode(tabOrder[tabOrder.length - 1]);
    else setSideOpenPersisted(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sideOpen, panelMode, sideChats, openFiles, filesTabs, reviewOpen, browserTabs, terminalTabs, openAgents]);

  /** Close any tab by its key — one dispatcher instead of per-kind closers. */
  function closeTab(key: string): void {
    if (key.startsWith("side:")) closeSideChat(key);
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
    if (filesTabs.length >= MAX_TABS_PER_KIND) {
      setPanelMode(`files:${filesTabs[filesTabs.length - 1]}`);
      setSideOpenPersisted(true);
      return;
    }
    const id = tabIdRef.current++;
    setFilesTabs((ts) => [...ts, id]);
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
  // Files (workspace tree) only makes sense inside a project — a plain
  // Recents chat lives in the home directory.
  const activeSidebarProject = sidebar.projects.find((p) =>
    p.threads.some((t) => t.id === activeThreadId),
  );
  const activeProjectName = activeProject?.name ?? activeSidebarProject?.name ?? null;
  const activeProjectPath = activeProject?.path ?? activeSidebarProject?.path ?? null;
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
      const all = [...sidebar.projects.flatMap((p) => p.threads), ...sidebar.recents];
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
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "0 8px 12px" }}>
          {sidebar.projects.length === 0 && sidebar.recents.length === 0 && (
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
          sidebar.projects.map((p) => (
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
                  background: activeProject?.path === p.path ? "var(--chip)" : "transparent",
                  borderRadius: 8,
                  padding: "8px 8px 6px",
                  fontSize: 14.5,
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
                  <span data-projmenu style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
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
                  active={t.id === activeThreadId}
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

          {sidebar.recents.length > 0 && (
            <SectionLabel collapsed={recentsCollapsed} onToggle={toggleRecentsSection}>
              Recents
            </SectionLabel>
          )}
          {!recentsCollapsed &&
          sidebar.recents.map((t) => (
            <ThreadRow
              key={t.id}
              thread={t}
              active={t.id === activeThreadId}
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
              localStorage.setItem("changelogSeen", CHANGELOG[0].version);
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
        <header
          style={{
            padding: "10px 16px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexShrink: 0,
          }}
        >
          <IconButton title={navOpen ? "Hide sidebar" : "Show sidebar"} onClick={toggleNav}>
            <PanelIcon />
          </IconButton>
          <span
            style={{
              fontSize: 14,
              fontWeight: 500,
              color: colors.fg,
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
          onBusyChange={(b) => {
            setMainBusy(b);
            if (b) setMainStarted(true);
          }}
          onTurnLanded={refreshThreads}
          onAskSideChat={askInSideChat}
          onOpenFile={(p) => void openFileInPanel(p)}
          onPreviewImage={(a) => void openImagePreview(a)}
          onOpenLink={openInBrowser}
          accessMode={accessMode}
          onAccessModeChange={changeAccessMode}
        />
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
            emptyState={
              <div style={{ textAlign: "center", padding: "0 24px" }}>
                <div style={{ color: colors.dim, display: "flex", justifyContent: "center", marginBottom: 10 }}>
                  <ChatPlusIcon size={34} strokeWidth={1.5} />
                </div>
                <p style={{ fontSize: 16, fontWeight: 500, margin: 0 }}>Side chat</p>
                <p style={{ color: colors.dim, marginTop: 6, fontSize: 13 }}>
                  Shares this conversation’s context. Temporary — it resets when
                  you switch conversations and disappears when you close the app.
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
            background: "rgba(0,0,0,0.55)",
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
            background: "rgba(0,0,0,0.55)",
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
            background: "rgba(0,0,0,0.55)",
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
            <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 19, fontWeight: 600, color: colors.fg }}>
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
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "grid", placeItems: "center", zIndex: 100 }}
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
      {showChangelog && <ChangelogModal onClose={() => setShowChangelog(false)} />}
      {renameDialog && (
        <div
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setRenameDialog(null);
          }}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "grid", placeItems: "center", zIndex: 100 }}
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
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "grid", placeItems: "center", zIndex: 100 }}
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
            background: "rgba(0,0,0,0.55)",
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
          <button key={full} onClick={() => void toggleDir(full)} style={rowStyle}>
            {guides(depth)}
            <span
              style={{
                color: colors.dim,
                fontSize: 12,
                display: "inline-block",
                width: 10,
                flexShrink: 0,
                transform: open ? "rotate(90deg)" : "none",
                transition: "transform 120ms",
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
          <button key={full} onClick={() => onOpenFile(full)} style={rowStyle}>
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
                        transition: "transform 120ms",
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
          width: "100%",
          background: "transparent",
          border: "none",
          padding: "0 0 6px",
          color: colors.dim,
          fontSize: 13.5,
          cursor: "pointer",
          fontFamily: "inherit",
          borderBottom: `1px solid ${colors.border}`,
        }}
      >
        {duration !== null ? `Worked for ${formatDuration(duration)}` : "Worked"}
        <span
          style={{
            display: "inline-block",
            transform: open ? "rotate(90deg)" : "none",
            transition: "transform 120ms",
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
  const LABELS: Record<string, { row: string; detail: string }> = {
    started: { row: "Created an agent", detail: "Created" },
    interacted: { row: "Messaged an agent", detail: "Messaged" },
    interrupted: { row: "Interrupted an agent", detail: "Interrupted" },
    completed: { row: "Closed an agent", detail: "Closed" },
    failed: { row: "An agent failed", detail: "Failed:" },
  };
  const label = LABELS[entry.event] ?? { row: `Agent ${entry.event}`, detail: entry.event };
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
        {label.row}
        <span
          style={{
            display: "inline-block",
            transform: open ? "rotate(90deg)" : "none",
            transition: "transform 120ms",
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
                {entry.agentThreadId ? `${agentEmoji(entry.agentThreadId)} ` : ""}
                {entry.name}
              </button>
            ) : (
              <span style={{ color: "var(--fg-soft)" }}>{entry.name}</span>
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
    a: (props: { href?: string; children?: React.ReactNode }) => (
      <a
        href={props.href}
        onClick={(e) => {
          e.preventDefault();
          const href = props.href ?? "";
          if (/^https?:/.test(href)) openLink?.(href);
        }}
        style={{ color: "var(--accent)", cursor: "pointer" }}
        title="Open in browser tab"
      >
        {props.children}
      </a>
    ),
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
          style={{ color: "var(--accent)", cursor: "pointer" }}
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
}: {
  paneId: PaneId;
  connected: boolean;
  reset: {
    entries: Entry[];
    nonce: number;
    // Present when the conversation was reopened mid-turn.
    resume?: { running: boolean; approvals: HeldApproval[] } | null;
  };
  contextChip?: string | { text: string; comment?: string; tag?: string; thumb?: string } | null;
  onContextClear?: () => void;
  emptyState: React.ReactNode;
  onBusyChange?: (busy: boolean) => void;
  onTurnLanded?: () => void;
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
}) {
  const [entries, setEntries] = useState<Entry[]>(reset.entries);
  const [draft, setDraft] = useState("");
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
  const [clipHasImage, setClipHasImage] = useState(false);
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

  async function openPlusMenu() {
    setClipHasImage(await window.unbiased.clipboardHasImage());
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

  // Attach an approval request to its command card (or make one). Shared
  // by the live event and the replay of requests held while backgrounded.
  function applyApproval(p: HeldApproval): void {
    setEntries((es) => {
      const cleaned = withoutTrailingPlaceholder(es);
      const approval = { requestId: p.requestId, reason: p.reason, kind: p.kind, grantRoot: p.grantRoot };
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
    turnStartIndexRef.current = reset.resume?.running ? reset.entries.length : null;
    turnStartedAtRef.current = null;
    for (const held of reset.resume?.approvals ?? []) applyApproval(held);
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
      i >= turnScopeStart && e.kind === "command" && e.status === "awaitingApproval" && e.approval && !e.approval.decision,
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
    await window.unbiased.decideApproval(requestId, decision);
  }

  const statusLabel = (e: CommandEntry) => {
    if (e.status === "awaitingApproval") return { text: "▸ needs approval", color: colors.dim };
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
  useEffect(() => {
    if (typeof Highlight === "undefined") return;
    if (pendingComment !== null && savedRangeRef.current) {
      CSS.highlights.set(`pending-${paneId}`, new Highlight(savedRangeRef.current));
    } else {
      CSS.highlights.delete(`pending-${paneId}`);
    }
    return () => void CSS.highlights.delete(`pending-${paneId}`);
  }, [pendingComment, paneId]);

  // Confirmed annotations keep their tint until the message sends. A range
  // dies silently if its DOM re-renders; the captured text is unaffected.
  useEffect(() => {
    if (typeof Highlight === "undefined") return;
    const ranges = annotations.map((a) => a.range).filter((r): r is Range => Boolean(r));
    if (ranges.length > 0) CSS.highlights.set(`annotations-${paneId}`, new Highlight(...ranges));
    else CSS.highlights.delete(`annotations-${paneId}`);
    return () => void CSS.highlights.delete(`annotations-${paneId}`);
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

  const renderBlock = (block: DisplayBlock, isLast = false): React.ReactNode => {
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
                maxWidth: "85%",
                padding: "10px 14px",
                borderRadius: 12,
                background: colors.panel,
                whiteSpace: "pre-wrap",
                lineHeight: 1.55,
                fontSize: 14,
              }}
            >
              {e.text}
            </div>
          )}
          {e.text && <CopyButton text={e.text} />}
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
      return (
        <div key={block.key} style={{ margin: "16px 0", lineHeight: 1.7, fontSize: 15.5, color: "var(--fg-msg)" }}>
          <Markdown remarkPlugins={REMARK_PLUGINS} components={mdComponents}>
            {e.text}
          </Markdown>
          {e.interrupted && <div style={{ color: colors.dim, fontSize: 12, marginTop: 4 }}>— stopped</div>}
          {/* One action row, on the settled final response — intermediate
              narration (and anything inside a work group) goes without. */}
          {e.text && isLast && !busy && <AssistantActions text={e.text} at={e.at} />}
        </div>
      );
    }
    if (e.kind === "work") {
      return (
        <WorkedGroup key={`w${block.key}`} duration={e.duration}>
          {toDisplayBlocks(e.entries).map((b) => renderBlock(b))}
        </WorkedGroup>
      );
    }
    return null;
  };

  return (
    <div ref={paneRef} style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}>
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
              style={{
                position: "absolute",
                bottom: "calc(100% + 8px)",
                left: 0,
                right: 0,
                // Same surface as the composer box — Codex renders both at
                // one elevation, not the popup a step lighter.
                background: colors.panel,
                border: `1px solid ${colors.border}`,
                borderRadius: 16,
                padding: "8px 8px 8px",
                zIndex: 20,
                boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
              }}
            >
              <div style={{ color: colors.dim, fontSize: 13, padding: "4px 10px 6px" }}>Add</div>
              <MenuItem icon={<PaperclipIcon />} label="Files and folders" onClick={() => void addAttachments()} />
              <MenuItem
                icon={<ImageIcon />}
                label="Image from clipboard"
                desc={clipHasImage ? undefined : "Nothing copied"}
                disabled={!clipHasImage}
                onClick={() => void attachClipboardImage()}
              />
              <MenuItem
                icon={<LightbulbIcon />}
                label="Plan mode"
                desc={planMode ? "Turn plan mode off" : "Turn plan mode on"}
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
              // A pasted image becomes an attachment; text pastes as usual.
              const items = Array.from(e.clipboardData?.items ?? []);
              if (!items.some((it) => it.type.startsWith("image/"))) return;
              e.preventDefault();
              void attachClipboardImage();
            }}
            placeholder={!connected ? "Engine starting…" : entries.length > 0 ? chatPlaceholder : "Do anything"}
            disabled={!connected}
            rows={2}
            style={{
              width: "100%",
              resize: "none",
              background: "transparent",
              color: colors.fg,
              border: "none",
              fontSize: 14.5,
              fontFamily: "inherit",
              outline: "none",
              display: "block",
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
                      strokeDasharray={`${(ctxUsage.percent / 100) * 40.8} 40.8`}
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
                          width: `${ctxUsage.percent}%`,
                          height: "100%",
                          borderRadius: 2,
                          background: ctxUsage.percent > 90 ? colors.err : ctxUsage.percent > 70 ? colors.amber : colors.accent,
                        }}
                      />
                    </div>
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
                      onClick={async () => {
                        // Stays "compacting" until the engine emits the
                        // contextCompaction item (onCompaction clears it); the
                        // start RPC resolving only means it kicked off.
                        setCompacting(true);
                        setUsageOpen(false);
                        const r = await window.unbiased.compact(paneId);
                        if (!r.ok) setCompacting(false);
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

function CodeBlock({ children }: { children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const child = Array.isArray(children) ? children[0] : children;
  const className: string =
    (typeof child === "object" && child && "props" in child
      ? ((child as { props: { className?: string } }).props.className ?? "")
      : "") || "";
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
}

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
              width: `${progress.percent}%`,
              background: colors.accent,
              opacity: 0.16,
              transition: "width 200ms",
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

/** The sign-in screen: paste a key, or continue with a found one. Validates
 *  against the platform's whoami (free, no model call) before letting the
 *  engine start. */
function LoginView({ onSignedIn }: { onSignedIn: () => void }) {
  const [phase, setPhase] = useState<"loading" | "found" | "manual">("loading");
  const [source, setSource] = useState<"env" | "file" | null>(null);
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
            Connect your Pareto API key to start.
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
              Use a different key
            </button>
          </>
        )}

        {phase === "manual" && (
          <>
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
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, margin: "0 0 24px" }}>Resources</h1>

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
            background: "rgba(0,0,0,0.55)",
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
}: {
  theme: ThemeConfig;
  onChange: (t: ThemeConfig) => void;
  onBack: () => void;
  onSignOut: () => void;
}) {
  const [tab, setTab] = useState<"appearance" | "resources" | "account">("appearance");
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
    padding: "14px 18px",
    borderBottom: `1px solid ${colors.border}`,
    fontSize: 14,
  };
  const textInputStyle: React.CSSProperties = {
    background: "var(--panel-2)",
    color: colors.fg,
    border: `1px solid ${colors.border}`,
    borderRadius: 8,
    padding: "6px 10px",
    fontSize: 13,
    fontFamily: "var(--font-code)",
    width: 260,
    outline: "none",
  };

  function ColorRow({ label, value, set }: { label: string; value: string; set: (v: string) => void }) {
    return (
      <div style={rowStyle}>
        <span>{label}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="color"
            value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#000000"}
            onChange={(e) => set(e.target.value)}
            style={{ width: 26, height: 26, border: "none", background: "transparent", padding: 0, cursor: "pointer" }}
          />
          <input
            value={value}
            onChange={(e) => set(e.target.value)}
            spellCheck={false}
            style={{ ...textInputStyle, width: 110 }}
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
        <SectionLabel>Personal</SectionLabel>
        {(
          [
            { id: "appearance", label: "Appearance" },
            { id: "resources", label: "Resources" },
            { id: "account", label: "Account" },
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            onClick={() => setTab(item.id)}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              background: tab === item.id ? colors.panel : "transparent",
              color: tab === item.id ? colors.fg : colors.dim,
              border: "none",
              borderRadius: 8,
              padding: "8px 10px",
              fontSize: 13.5,
              cursor: "pointer",
              fontFamily: "inherit",
              marginBottom: 2,
            }}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div style={{ flex: 1, overflowY: "auto", padding: "40px 48px" }}>
        {tab === "resources" ? (
          <ResourcesView />
        ) : tab === "account" ? (
          <div style={{ maxWidth: 640, margin: "0 auto" }}>
            <h1 style={{ fontSize: 22, fontWeight: 600, margin: "0 0 24px" }}>Account</h1>
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
                          left: keepKey ? 19 : 3,
                          width: 16,
                          height: 16,
                          borderRadius: "50%",
                          background: "#fff",
                          transition: "left 120ms",
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
        <div style={{ maxWidth: 640, margin: "0 auto" }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: "0 0 24px" }}>Appearance</h1>

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
                style={{
                  background: "transparent",
                  border: `1px solid ${colors.border}`,
                  color: colors.dim,
                  borderRadius: 8,
                  padding: "5px 12px",
                  fontSize: 12.5,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
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
                  background: importText.trim() ? colors.accent : "var(--panel-2)",
                  color: importText.trim() ? "var(--accent-fg)" : colors.dim,
                  border: "none",
                  borderRadius: 8,
                  padding: "7px 16px",
                  fontSize: 13,
                  cursor: importText.trim() ? "pointer" : "default",
                  fontFamily: "inherit",
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
        transition: "transform 120ms",
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
  date: string;
  sections: { title: string; items: string[] }[];
};
const CHANGELOG: ChangelogRelease[] = [
  {
    version: "1.2.1",
    date: "August 19, 2026",
    sections: [
      {
        title: "Fixed",
        items: [
          "Security: text the assistant typed into a page could be misread as a command-line option by the browser tool, including one that changes which program it launches. Text is now entered directly into the page and never reaches that parser.",
          "Browser steps in the transcript show as running while they are still going, instead of jumping straight to done.",
        ],
      },
    ],
  },
  {
    version: "1.2.0",
    date: "August 19, 2026",
    sections: [
      {
        title: "New",
        items: [
          "The assistant can browse the web. Ask it to look something up and it searches, reads pages, clicks through, and can take screenshots — reporting what it actually saw rather than what it remembers. Requires the agent-browser tool to be installed.",
          "Signed-in browsing: when a task needs your own accounts (your email, a dashboard, an admin panel), the assistant asks permission and the app opens a browser window for it. Sign in there once and it stays available for later requests.",
          "Every side-panel surface now opens in multiple tabs — up to five each of sub-agent conversations, side chats, browsers, terminals, file trees, and file viewers.",
          "The side panel remembers itself per conversation: leave a chat and come back to find the same tabs, with the one you were reading still in front.",
          "Creating a project now uses the full project editor — name, icon and color, and as many source folders as you want.",
          "This “What’s new” log, reachable from the bell beside Settings, with a dot when there is something you have not read.",
        ],
      },
      {
        title: "Fixed",
        items: [
          "Deleting a conversation or worktree from Settings → Resources now asks first, and spells out exactly what gets removed.",
          "Sub-agent conversations in Settings → Resources are named (nickname, task, and the conversation that spawned them) instead of showing a raw id.",
          "Chats outside a project now run in a dedicated ~/Unbiased folder. Previously they ran in your home directory, which let a personal Codex CLI config leak into the app and break turns with a tool error.",
          "Diagrams and other code blocks without a language tag render as proper blocks instead of ragged inline text.",
          "The stored API key is kept on sign-out by default, so signing back in is one click. The toggle is in Settings.",
          "Interrupting a chat now also stops its sub-agents, and permission cards that no longer apply are retired instead of sitting there live.",
          "A permission card raised by the app itself no longer stays stuck on “running” after you answer it.",
          "The update banner shows its status inline with a face — glum while an update waits, cheerful once it is ready to relaunch.",
        ],
      },
    ],
  },
  {
    version: "1.1.0",
    date: "August 18, 2026",
    sections: [
      {
        title: "New",
        items: [
          "Sub-agents: the assistant can spawn parallel agents to split up a task. Each gets a nickname, shows up in the environment popover, and leaves lifecycle rows in the chat (“Created an agent”, “Messaged an agent”, “Closed an agent”).",
          "Click a sub-agent’s name to open the agent-to-agent conversation in the side panel, rendered with the same formatting as the main chat.",
          "A turn’s intermediate work now folds under a “Worked for …” header when it finishes, Codex-style.",
          "Projects: create one from the + button in the sidebar, give it an icon and a color, and attach multiple folders with a primary.",
          "Rename conversations, move them into projects, and delete conversations and worktrees from Settings → Resources.",
          "The composer rotates through fresh placeholder prompts in existing chats.",
          "New setting to keep the stored API key when signing out.",
        ],
      },
      {
        title: "Fixed",
        items: [
          "Code blocks are syntax-highlighted, and every copy button flashes a tick to confirm the copy.",
          "Thinking and waiting status shimmer, and durations read as whole seconds.",
          "A sub-agent’s permission request lands in the main chat naming the agent, and interrupting a chat now also stops its sub-agents and retires stale Allow/Deny cards.",
          "Corrections sent to a busy sub-agent appear in its conversation immediately instead of after it finishes.",
          "Long commands wrap inside their cards instead of stretching the chat.",
          "Message timestamps appear when hovering the actions row.",
        ],
      },
    ],
  },
  {
    version: "1.0.6",
    date: "August 17, 2026",
    sections: [
      {
        title: "New",
        items: ["The usage popover shows real credits and spend from your account."],
      },
      {
        title: "Fixed",
        items: ["New releases are noticed right away instead of waiting for the six-hour check."],
      },
    ],
  },
  {
    version: "1.0.1 – 1.0.5",
    date: "August 17, 2026",
    sections: [
      {
        title: "New",
        items: [
          "In-app update banner with self-installing updates — downloads in the background, relaunches on demand.",
          "The mascot joined the update banner.",
        ],
      },
      {
        title: "Fixed",
        items: ["Installer reliability: staged installs and a macOS mount-point fix."],
      },
    ],
  },
  {
    version: "1.0.0",
    date: "August 17, 2026",
    sections: [
      {
        title: "New",
        items: [
          "Initial release: chat with Pareto, worktrees, plan mode, the Review pane, an integrated terminal, an embedded browser with annotations, a real file viewer, and themes.",
        ],
      },
    ],
  },
];

function BellIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function ChangelogModal({ onClose }: { onClose: () => void }) {
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
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "grid", placeItems: "center", zIndex: 100 }}
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
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "6px 24px 22px" }}>
          {CHANGELOG.map((rel, i) => (
            <div key={rel.version}>
              {i > 0 && <div style={{ height: 1, background: colors.border, margin: "22px 0" }} />}
              <div style={{ display: "flex", alignItems: "center", margin: "10px 0 2px" }}>
                <div style={{ fontSize: 16.5, fontWeight: 600, color: colors.fg }}>{rel.date}</div>
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
              {rel.sections.map((sec) => (
                <div key={sec.title}>
                  <div style={{ color: colors.dim, fontSize: 11.5, letterSpacing: 1.1, textTransform: "uppercase", margin: "16px 0 2px" }}>
                    {sec.title}
                  </div>
                  <ul style={{ margin: "6px 0 0", paddingLeft: 22 }}>
                    {sec.items.map((it, j) => (
                      <li key={j} style={{ margin: "8px 0", fontSize: 13.5, lineHeight: 1.55, color: "var(--fg-msg)" }}>
                        {it}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
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

function SidebarAction({
  onClick,
  disabled,
  icon,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  icon: React.ReactNode;
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
        background: "transparent",
        color: disabled ? colors.dim : "var(--fg-soft)",
        border: "none",
        borderRadius: 8,
        padding: "8px 8px",
        fontSize: 14,
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
            transition: "opacity 120ms",
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
  const base: React.CSSProperties = {
    color: colors.dim,
    fontSize: 13.5,
    fontWeight: 500,
    padding: "14px 8px 6px",
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
          transition: "transform 120ms",
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

function ImageIcon({ size = 15 }: { size?: number } = {}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
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
function MenuItem({
  icon,
  label,
  desc,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  desc?: string;
  disabled?: boolean;
  onClick: () => void;
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
        gap: 10,
        width: "100%",
        background: hover && !disabled ? "var(--chip)" : "transparent",
        border: "none",
        borderRadius: 8,
        padding: "8px 10px",
        fontSize: 13.5,
        color: disabled ? colors.dim : colors.fg,
        cursor: disabled ? "default" : "pointer",
        textAlign: "left",
        fontFamily: "inherit",
      }}
    >
      <span style={{ color: colors.dim, display: "flex", flexShrink: 0 }}>{icon}</span>
      <span style={{ whiteSpace: "nowrap" }}>{label}</span>
      {desc && (
        <span
          style={{
            color: colors.dim,
            fontSize: 12.5,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {desc}
        </span>
      )}
    </button>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
        background: active ? "var(--chip)" : "transparent",
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
          fontSize: 14,
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
function PermissionsPrompt({
  approval,
  onDecide,
}: {
  approval: { reason: string | null; kind?: "command" | "fileChange"; grantRoot?: string | null };
  onDecide: (d: ApprovalDecision) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      // Never steal Enter/Escape from the composer or other inputs.
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onDecide("decline");
      } else if (e.key === "Enter") {
        e.preventDefault();
        onDecide("accept");
      }
    }
    function onDown(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rootName = approval.grantRoot?.split("/").filter(Boolean).pop();
  const title =
    approval.kind === "fileChange" ? (
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
      {approval.reason && <div style={{ color: colors.dim, fontSize: 13, marginTop: 4 }}>{approval.reason}</div>}
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
  const needsApproval = items.some((e) => e.status === "awaitingApproval" && e.approval && !e.approval.decision);

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

  const summary = needsApproval
    ? { text: "Needs your approval", color: colors.fg }
    : running
      ? { text: "Working…", color: colors.amber }
      : {
          text: `Worked · ${items.length} step${items.length === 1 ? "" : "s"}${failed ? " · issues" : ""}`,
          color: failed ? colors.err : colors.dim,
        };

  return (
    <div style={{ margin: "14px 0" }}>
      <button
        onClick={() => setOpen((o) => !o)}
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
        <span
          style={{
            display: "inline-block",
            transform: expanded ? "rotate(90deg)" : "none",
            transition: "transform 120ms",
            fontSize: 11,
            marginTop: 1,
          }}
        >
          ›
        </span>
      </button>
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
                border: `1px solid ${e.status === "awaitingApproval" ? colors.amber : colors.border}`,
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
                    transition: "transform 120ms",
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
                <PermissionsPrompt
                  approval={e.approval}
                  onDecide={(d) => void decide(e.itemId, e.approval!.requestId, d)}
                />
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
