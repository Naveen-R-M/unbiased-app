import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; interrupted?: boolean }
  | {
      kind: "command";
      itemId: string;
      command: string;
      status: string; // inProgress | completed | failed | declined | awaitingApproval
      exitCode?: number;
      output?: string;
      approval?: { requestId: string; reason: string | null; decision?: "accept" | "decline" };
    };

type PaneId = "main" | "side";
type ThreadSummary = { id: string; title: string; createdAt?: string };
// A transcript excerpt staged for the next send, with an optional comment.
// The live Range (when still valid) keeps the excerpt tinted in the DOM.
type Annotation = { text: string; comment?: string; range?: Range };
// kind: "image" sends as a localImage input item (model sees the pixels);
// everything else rides as a mention (engine pulls in the file's text).
// thumb is a small data-URL preview for the composer card.
type Attachment = { name: string; path: string; kind?: "image" | "folder" | "file"; thumb?: string };
type DirEntry = { name: string; dir: boolean };
type RefHit = { path: string; rel: string; line: number; text: string };
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
type SidebarData = {
  projects: { name: string; path: string; threads: ThreadSummary[] }[];
  recents: ThreadSummary[];
};

declare global {
  interface Window {
    unbiased: {
      getEngineStatus: () => Promise<EngineStatus>;
      onEngineStatus: (cb: (status: EngineStatus) => void) => () => void;
      sendMessage: (
        paneId: PaneId,
        text: string,
        attachments?: Attachment[],
      ) => Promise<{ turnId: string | null; threadId: string; created: boolean }>;
      chooseAttachments: () => Promise<{ attachments: Attachment[] }>;
      clipboardHasImage: () => Promise<boolean>;
      clipboardImage: () => Promise<{ attachment: Attachment | null }>;
      interrupt: (paneId: PaneId) => Promise<{ interrupted: boolean }>;
      onTurnStarted: (cb: (p: { paneId: PaneId; turnId: string | null }) => void) => () => void;
      onDelta: (cb: (p: { paneId: PaneId; delta: string }) => void) => () => void;
      onTurnCompleted: (cb: (p: { paneId: PaneId; status: string }) => void) => () => void;
      decideApproval: (requestId: string, decision: "accept" | "decline") => Promise<{ ok: boolean }>;
      onApprovalRequest: (
        cb: (p: {
          paneId: PaneId;
          requestId: string;
          itemId: string | null;
          command: string;
          cwd: string | null;
          reason: string | null;
        }) => void,
      ) => () => void;
      onCommand: (
        cb: (p: { paneId: PaneId; phase: "started" | "completed"; item: CommandItem }) => void,
      ) => () => void;
      listThreads: () => Promise<SidebarData>;
      openThread: (id: string) => Promise<{ id: string; entries: Entry[] }>;
      detachThread: (cwd?: string) => Promise<{ ok: boolean }>;
      deleteThread: (id: string) => Promise<{ ok: boolean }>;
      resetSideChat: () => Promise<{ ok: boolean }>;
      chooseProject: () => Promise<{ path: string | null; name: string | null }>;
      readFile: (path: string) => Promise<{ fullPath: string; relPath?: string; content?: string; error?: string }>;
      readImage: (path: string) => Promise<{ dataUrl?: string; error?: string }>;
      listDir: (dir?: string) => Promise<{ dir: string; entries: DirEntry[]; error?: string }>;
      searchRefs: (word: string) => Promise<{ results: RefHit[]; truncated?: boolean; error?: string }>;
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
    "--user-bubble": m(0.13),
    "--dim": mixHex(t.surface, t.ink, 0.52),
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

/** Drop a trailing empty assistant placeholder. */
function withoutTrailingPlaceholder(es: Entry[]): Entry[] {
  const last = es[es.length - 1];
  if (last?.kind === "assistant" && last.text === "" && !last.interrupted) return es.slice(0, -1);
  return es;
}

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
  const [status, setStatus] = useState<EngineStatus>({ state: "starting" });

  function applyTheme(next: ThemeConfig) {
    setTheme(next);
    saveTheme(next);
  }
  const [sidebar, setSidebar] = useState<SidebarData>({ projects: [], recents: [] });
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [activeProject, setActiveProject] = useState<{ name: string; path: string } | null>(null);
  const [hoveredThreadId, setHoveredThreadId] = useState<string | null>(null);
  const [hoveredProject, setHoveredProject] = useState<string | null>(null);
  const [mainBusy, setMainBusy] = useState(false);
  const [mainReset, setMainReset] = useState<{ entries: Entry[]; nonce: number }>({ entries: [], nonce: 0 });
  // sideOpen = the whole right panel is visible; sideChatEnabled = the chat
  // tab exists in it. Kept separate so opening a file/image preview doesn't
  // drag the side chat along with it.
  const [sideOpen, setSideOpen] = useState(() => localStorage.getItem("sideOpen") === "true");
  const [sideChatEnabled, setSideChatEnabledState] = useState(() => {
    const stored = localStorage.getItem("sideChatEnabled");
    return stored !== null ? stored === "true" : localStorage.getItem("sideOpen") === "true";
  });
  const [sideContext, setSideContext] = useState<string | null>(null);
  const [sideNonce, setSideNonce] = useState(0);

  function setSideOpenPersisted(open: boolean) {
    localStorage.setItem("sideOpen", String(open));
    setSideOpen(open);
  }

  function setSideChatEnabled(v: boolean) {
    localStorage.setItem("sideChatEnabled", String(v));
    setSideChatEnabledState(v);
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
    setSidebar(await window.unbiased.listThreads());
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
  function resetSideView() {
    setSideContext(null);
    setSideNonce((n) => n + 1);
    setOpenFile(null);
    setFilesOpen(false); // the tree browsed the previous conversation's cwd
    setTreeFile(null);
    setPanelMode("chat");
    // A panel that was only showing file views has nothing left.
    if (!sideChatEnabled) setSideOpenPersisted(false);
  }

  async function newChat(project?: { name: string; path: string }) {
    if (mainBusy) return;
    await window.unbiased.detachThread(project?.path);
    setActiveProject(project ?? null);
    setActiveThreadId(null);
    setMainReset((r) => ({ entries: [], nonce: r.nonce + 1 }));
    resetSideView();
  }

  async function openProjectDialog() {
    if (mainBusy) return;
    const { path, name } = await window.unbiased.chooseProject();
    if (!path || !name) return; // cancelled
    setActiveProject({ name, path });
    setActiveThreadId(null);
    setMainReset((r) => ({ entries: [], nonce: r.nonce + 1 }));
    resetSideView();
    void refreshThreads(); // the project shows in the sidebar immediately
  }

  async function openThread(id: string) {
    if (mainBusy || id === activeThreadId) return;
    const { entries: history } = await window.unbiased.openThread(id);
    setActiveProject(null);
    setActiveThreadId(id);
    setMainReset((r) => ({ entries: history, nonce: r.nonce + 1 }));
    resetSideView();
  }

  async function deleteThread(id: string) {
    if (mainBusy) return;
    await window.unbiased.deleteThread(id);
    if (id === activeThreadId) {
      setActiveThreadId(null);
      setMainReset((r) => ({ entries: [], nonce: r.nonce + 1 }));
      resetSideView();
    }
    void refreshThreads();
  }

  const [openFile, setOpenFile] = useState<OpenFileInfo | null>(null);
  // "launcher" = the panel is open with nothing selected yet — it shows
  // big rows asking which surface to open (Codex's empty side panel).
  const [panelMode, setPanelMode] = useState<"chat" | "file" | "files" | "launcher">("chat");
  const [filesOpen, setFilesOpen] = useState(false);
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

  function openSideChatTab() {
    setSidePlusOpen(false);
    setSideChatEnabled(true);
    setPanelMode("chat");
  }

  function openFilesTab() {
    setSidePlusOpen(false);
    setFilesOpen(true);
    setPanelMode("files");
  }

  // The header's panel toggle: open to whatever the panel last showed, or
  // the launcher when there's nothing yet.
  function toggleSidePanel() {
    if (sideOpen) {
      setSideOpenPersisted(false);
      return;
    }
    setSideOpenPersisted(true);
    if (sideChatEnabled) setPanelMode("chat");
    else if (openFile) setPanelMode("file");
    else if (filesOpen) setPanelMode("files");
    else setPanelMode("launcher");
  }

  function closeFilesTab() {
    setFilesOpen(false);
    if (panelMode !== "files") return;
    if (openFile) setPanelMode("file");
    else if (sideChatEnabled) setPanelMode("chat");
    else setSideOpenPersisted(false);
  }

  // File previews don't persist across launches — a panel restored open
  // with no chat tab would be an empty shell.
  useEffect(() => {
    if (sideOpen && !sideChatEnabled) setSideOpenPersisted(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function askInSideChat(text: string) {
    setSideContext(text);
    setSideChatEnabled(true);
    setPanelMode("chat");
    setSideOpenPersisted(true);
  }

  async function openImagePreview(a: { name: string; path: string }) {
    const result = await window.unbiased.readImage(a.path);
    setOpenFile({
      name: a.name,
      relPath: a.name,
      fullPath: a.path,
      imageSrc: result.dataUrl,
      error: result.error,
    });
    setPanelMode("file");
    setSideOpenPersisted(true);
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
    setOpenFile(await loadFileInfo(pathText, line));
    setPanelMode("file");
    setSideOpenPersisted(true);
  }

  // The Files view's own selection — shown beside the tree, so browsing
  // never hides the tree the way the standalone file tab does.
  const [treeFile, setTreeFile] = useState<OpenFileInfo | null>(null);

  async function openFileInTree(pathText: string, line?: number) {
    setTreeFile(await loadFileInfo(pathText, line));
  }

  // Closing HIDES the side chat — its conversation survives and reopening
  // restores it; only a main-conversation switch resets the thread.
  // An open file preview keeps the panel itself alive.
  function closeSideChat() {
    setSideChatEnabled(false);
    if (openFile) setPanelMode("file");
    else setSideOpenPersisted(false);
  }

  function toggleSideChat() {
    if (sideChatEnabled) {
      closeSideChat();
    } else {
      setSideChatEnabled(true);
      setPanelMode("chat");
      setSideOpenPersisted(true);
    }
  }

  const connected = status.state === "connected";
  // Files (workspace tree) only makes sense inside a project — a plain
  // Recents chat lives in the home directory.
  const inProject =
    activeProject !== null ||
    sidebar.projects.some((p) => p.threads.some((t) => t.id === activeThreadId));
  const mainTitle = (() => {
    if (activeThreadId) {
      const all = [...sidebar.projects.flatMap((p) => p.threads), ...sidebar.recents];
      return all.find((t) => t.id === activeThreadId)?.title ?? "Conversation";
    }
    return activeProject ? `New chat · ${activeProject.name}` : "New chat";
  })();

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
        <SettingsView theme={theme} onChange={applyTheme} onBack={() => setShowSettings(false)} />
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
          background: "var(--nav-bg)",
        }}
      >
        <div style={{ padding: "14px 14px 6px" }}>
          <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: -0.3, marginBottom: 14 }}>
            <span style={{ color: colors.accent }}>un</span>biased
          </div>
          <SidebarAction onClick={() => void newChat()} disabled={mainBusy} icon={<PencilIcon />}>
            New chat
          </SidebarAction>
          <SidebarAction onClick={() => void openProjectDialog()} disabled={mainBusy} icon={<FolderPlusIcon />}>
            Open project…
          </SidebarAction>
          <SidebarAction onClick={toggleSideChat} disabled={false} icon={<SideChatIcon />}>
            {sideChatEnabled ? "Close side chat" : "Side chat"}
          </SidebarAction>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "0 8px 12px" }}>
          {sidebar.projects.length === 0 && sidebar.recents.length === 0 && (
            <div style={{ color: colors.dim, fontSize: 12, padding: "8px 8px" }}>No conversations yet</div>
          )}

          {sidebar.projects.length > 0 && <SectionLabel>Projects</SectionLabel>}
          {sidebar.projects.map((p) => (
            <div key={p.path} style={{ marginBottom: 8 }}>
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
                  background: activeProject?.path === p.path ? colors.panel : "transparent",
                  borderRadius: 8,
                  padding: "7px 8px 5px",
                  fontSize: 14,
                  color: colors.fg,
                  boxSizing: "border-box",
                }}
              >
                <FolderIcon />
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
                {hoveredProject === p.path && !mainBusy && (
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
                      flexShrink: 0,
                    }}
                  >
                    <PencilIcon />
                  </button>
                )}
              </div>
              {p.threads.map((t) => (
                <ThreadRow
                  key={t.id}
                  thread={t}
                  active={t.id === activeThreadId}
                  hovered={hoveredThreadId === t.id}
                  busy={mainBusy}
                  indent
                  onHover={setHoveredThreadId}
                  onOpen={openThread}
                  onDelete={deleteThread}
                />
              ))}
            </div>
          ))}

          {sidebar.recents.length > 0 && <SectionLabel>Recents</SectionLabel>}
          {sidebar.recents.map((t) => (
            <ThreadRow
              key={t.id}
              thread={t}
              active={t.id === activeThreadId}
              hovered={hoveredThreadId === t.id}
              busy={mainBusy}
              onHover={setHoveredThreadId}
              onOpen={openThread}
              onDelete={deleteThread}
            />
          ))}
        </div>
        <div style={{ padding: "4px 14px 2px", flexShrink: 0 }}>
          <SidebarAction onClick={() => setShowSettings(true)} disabled={false} icon={<GearIcon />}>
            Settings
          </SidebarAction>
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
            borderBottom: `1px solid ${colors.border}`,
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
          <IconButton title={sideOpen ? "Close side panel" : "Open side panel"} onClick={toggleSidePanel}>
            <SideChatIcon />
          </IconButton>
        </header>
        <ChatPane
          paneId="main"
          connected={connected}
          reset={mainReset}
          contextLabel={`${activeProject ? `${activeProject.name} · ` : ""}pareto · read-only`}
          emptyState={
            <div style={{ textAlign: "center" }}>
              <h1 style={{ fontSize: 42, fontWeight: 600, letterSpacing: -1, margin: 0 }}>
                <span style={{ color: colors.accent }}>un</span>biased
              </h1>
              <p style={{ color: colors.dim, marginTop: 8 }}>
                {!connected ? (
                  "Waiting for the engine…"
                ) : activeProject ? (
                  <>
                    New chat in <span style={{ color: colors.fg }}>{activeProject.name}</span>
                  </>
                ) : (
                  "Ask Pareto anything."
                )}
              </p>
            </div>
          }
          onBusyChange={setMainBusy}
          onTurnLanded={refreshThreads}
          onAskSideChat={askInSideChat}
          onOpenFile={(p) => void openFileInPanel(p)}
          onPreviewImage={(a) => void openImagePreview(a)}
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
              borderBottom: `1px solid ${colors.border}`,
              display: "flex",
              alignItems: "center",
              gap: 6,
              flexShrink: 0,
            }}
          >
            {sideChatEnabled && (
              <button
                onClick={() => setPanelMode("chat")}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  background: panelMode === "chat" ? colors.panel : "transparent",
                  color: panelMode === "chat" ? colors.fg : colors.dim,
                  border: "none",
                  borderRadius: 8,
                  padding: "6px 12px",
                  fontSize: 13,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                <ChatPlusIcon />
                Side chat
                <span
                  role="button"
                  aria-label="Close side chat"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    closeSideChat();
                  }}
                  style={{ display: "flex", color: colors.dim, marginLeft: 2 }}
                >
                  <CloseIcon />
                </span>
              </button>
            )}
            {openFile && (
              <button
                onClick={() => setPanelMode("file")}
                title={openFile.fullPath}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  background: panelMode === "file" ? colors.panel : "transparent",
                  color: panelMode === "file" ? colors.fg : colors.dim,
                  border: "none",
                  borderRadius: 8,
                  padding: "6px 12px",
                  fontSize: 13,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  minWidth: 0,
                  maxWidth: 220,
                }}
              >
                <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {openFile.name}
                </span>
                <span
                  role="button"
                  aria-label="Close file"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    setOpenFile(null);
                    // No chat tab behind it → nothing left in the panel.
                    if (sideChatEnabled) setPanelMode("chat");
                    else setSideOpenPersisted(false);
                  }}
                  style={{ display: "flex", color: colors.dim }}
                >
                  <CloseIcon />
                </span>
              </button>
            )}
            {filesOpen && (
              <button
                onClick={() => setPanelMode("files")}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  background: panelMode === "files" ? colors.panel : "transparent",
                  color: panelMode === "files" ? colors.fg : colors.dim,
                  border: "none",
                  borderRadius: 8,
                  padding: "6px 12px",
                  fontSize: 13,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                <FolderOutlineIcon size={13} />
                Files
                <span
                  role="button"
                  aria-label="Close files"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    closeFilesTab();
                  }}
                  style={{ display: "flex", color: colors.dim, marginLeft: 2 }}
                >
                  <CloseIcon />
                </span>
              </button>
            )}
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
                  <MenuItem icon={<ReviewIcon />} label="Review" desc="Soon" disabled onClick={() => {}} />
                  <MenuItem icon={<TerminalIcon />} label="Terminal" desc="Soon" disabled onClick={() => {}} />
                  {inProject && (
                    <MenuItem icon={<FolderOutlineIcon size={15} />} label="Files" onClick={openFilesTab} />
                  )}
                  <MenuItem icon={<ChatPlusIcon />} label="Side chat" onClick={openSideChatTab} />
                </div>
              )}
            </span>
            <span style={{ flex: 1 }} />
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
              <LauncherRow icon={<ChatPlusIcon />} label="Side chat" onClick={openSideChatTab} />
              {inProject && (
                <LauncherRow icon={<FolderOutlineIcon size={15} />} label="Files" onClick={openFilesTab} />
              )}
              <LauncherRow icon={<TerminalIcon />} label="Terminal" hint="Soon" disabled />
              <LauncherRow icon={<ReviewIcon />} label="Review" hint="Soon" disabled />
            </div>
          )}
          {openFile && panelMode === "file" && (
            <FileViewer file={openFile} onOpenFile={(p, l) => void openFileInPanel(p, l)} />
          )}
          {filesOpen && panelMode === "files" && (
            <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: "flex",
                  flexDirection: "column",
                  borderRight: `1px solid ${colors.border}`,
                }}
              >
                {treeFile ? (
                  <FileViewer file={treeFile} onOpenFile={(p, l) => void openFileInTree(p, l)} />
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
                <FileTreePane onOpenFile={(p) => void openFileInTree(p)} />
              </div>
            </div>
          )}
          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: panelMode === "chat" ? "flex" : "none",
              flexDirection: "column",
            }}
          >
          <ChatPane
            key={sideNonce}
            paneId="side"
            connected={connected}
            reset={{ entries: [], nonce: 0 }}
            contextLabel="pareto · temporary"
            contextChip={sideContext}
            onContextClear={() => setSideContext(null)}
            onPreviewImage={(a) => void openImagePreview(a)}
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
        </div>
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

/** Codex-style file view: breadcrumb, line numbers, Prism highlighting.
 *  With onOpenFile, each crumb opens a dropdown of its parent directory
 *  (siblings, the crumb pre-expanded) for quick navigation. */
function FileViewer({
  file,
  onOpenFile,
}: {
  file: OpenFileInfo;
  onOpenFile?: (path: string, line?: number) => void;
}) {
  const content = file.content ?? "";
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

  useEffect(() => {
    setCrumbMenu(null);
    setRefs(null);
  }, [file.fullPath]);

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
    if (!onOpenFile || !(e.metaKey || e.ctrlKey)) return;
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
  contextLabel,
  contextChip,
  onContextClear,
  emptyState,
  onBusyChange,
  onTurnLanded,
  onAskSideChat,
  onOpenFile,
  onPreviewImage,
}: {
  paneId: PaneId;
  connected: boolean;
  reset: { entries: Entry[]; nonce: number };
  contextLabel: string;
  contextChip?: string | null;
  onContextClear?: () => void;
  emptyState: React.ReactNode;
  onBusyChange?: (busy: boolean) => void;
  onTurnLanded?: () => void;
  onAskSideChat?: (text: string) => void;
  onOpenFile?: (path: string) => void;
  onPreviewImage?: (a: Attachment) => void;
}) {
  const [entries, setEntries] = useState<Entry[]>(reset.entries);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
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
    setAnnotations((list) => [...list, { text: contextChip }]);
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
  // x = the selection's horizontal midpoint (anchors the button pill);
  // right = its bounding-box right edge (anchors the comment box beside
  // the numbered badge); y = its top.
  const [selection, setSelection] = useState<{ text: string; x: number; y: number; right: number } | null>(null);
  const savedRangeRef = useRef<Range | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);

  // These props get a fresh identity on every parent render. The markdown
  // component map below must stay referentially stable — React reads a new
  // component-function identity as a different type and remounts the whole
  // subtree, which detaches the text nodes an active selection points at.
  // Routing the callbacks through refs keeps the map's deps empty.
  const onAskSideChatRef = useRef(onAskSideChat);
  onAskSideChatRef.current = onAskSideChat;
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;

  function setBusy(b: boolean) {
    setBusyState(b);
    onBusyChange?.(b);
  }

  useEffect(() => {
    setEntries(reset.entries);
    setBusy(false);
    // Staged annotations belong to the conversation they came from.
    setAnnotations([]);
    setPendingComment(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reset.nonce]);

  // Pareto completes the whole response before its first byte arrives
  // (~3-5s of silence), so the wait needs to look attended, not frozen.
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsed((Date.now() - startedAt) / 1000), 100);
    return () => clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    const offs = [
      window.unbiased.onDelta((p) => {
        if (p.paneId !== paneId) return;
        setEntries((es) => {
          const last = es[es.length - 1];
          if (!last || last.kind !== "assistant") return [...es, { kind: "assistant", text: p.delta }];
          return [...es.slice(0, -1), { ...last, text: last.text + p.delta }];
        });
      }),
      window.unbiased.onTurnCompleted((p) => {
        if (p.paneId !== paneId) return;
        setBusy(false);
        onTurnLanded?.();
        setEntries((es) => {
          let next = es;
          if (p.status === "interrupted") {
            const last = next[next.length - 1];
            if (last?.kind === "assistant" && last.text !== "") {
              next = [...next.slice(0, -1), { ...last, interrupted: true }];
            }
          }
          return withoutTrailingPlaceholder(next);
        });
      }),
      window.unbiased.onApprovalRequest((p) => {
        if (p.paneId !== paneId) return;
        setEntries((es) => {
          const cleaned = withoutTrailingPlaceholder(es);
          const approval = { requestId: p.requestId, reason: p.reason };
          const idx = cleaned.findIndex((e) => e.kind === "command" && e.itemId === p.itemId);
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
              command: p.command,
              status: "awaitingApproval",
              approval,
            },
          ];
        });
      }),
      window.unbiased.onCommand((p) => {
        if (p.paneId !== paneId) return;
        const item = p.item;
        setEntries((es) => {
          const cleaned = withoutTrailingPlaceholder(es);
          const itemId = item.id ?? "unknown";
          const idx = cleaned.findIndex((e) => e.kind === "command" && e.itemId === itemId);
          if (idx === -1) {
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
          }
          const existing = cleaned[idx] as CommandEntry;
          const updated: Entry = {
            ...existing,
            command: item.command ?? existing.command,
            status: item.status ?? existing.status,
            exitCode: item.exitCode ?? existing.exitCode,
            output: item.aggregatedOutput ?? item.output ?? existing.output,
          };
          return [...cleaned.slice(0, idx), updated, ...cleaned.slice(idx + 1)];
        });
      }),
    ];
    return () => offs.forEach((off) => off());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [entries]);

  const lastEntry = entries[entries.length - 1];
  const showThinking = busy && !(lastEntry?.kind === "assistant" && lastEntry.text !== "");
  const canSend = connected && (draft.trim() !== "" || annotations.length > 0);

  async function submit() {
    const text = draft.trim();
    // Annotations alone are a sendable message — the excerpts plus their
    // comments carry the intent even without accompanying prose.
    if ((!text && annotations.length === 0) || busy || !connected) return;
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
    setBusy(true);
    const suffix = [
      anns.length > 0 ? `(${anns.length} annotation${anns.length === 1 ? "" : "s"})` : "",
      sentAttachments.length > 0 ? `📎 ${sentAttachments.map((a) => a.name).join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    setEntries((es) => [...es, { kind: "user", text: [text, suffix].filter(Boolean).join("\n\n") }]);
    try {
      await window.unbiased.sendMessage(paneId, wire, sentAttachments);
    } catch (err) {
      setBusy(false);
      setEntries((es) => [...es, { kind: "assistant", text: `Something went wrong: ${String(err)}` }]);
    }
  }

  async function decide(itemId: string, requestId: string, decision: "accept" | "decline") {
    setEntries((es) =>
      es.map((e) =>
        e.kind === "command" && e.itemId === itemId && e.approval
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
    if (e.status === "awaitingApproval") return { text: "▸ needs approval", color: colors.amber };
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
      { text: selection.text, comment: comment || undefined, range: savedRangeRef.current?.cloneRange() },
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

  const mdComponents = useMemo(
    () => ({
      code: (props: { className?: string; children?: React.ReactNode }) => {
        if (props.className) {
          // Block code: the surrounding <pre> (CodeBlock) owns the chrome.
          return <code style={{ fontFamily: "inherit", fontSize: "inherit" }}>{props.children}</code>;
        }
        const text = extractText(props.children);
        const isPath = Boolean(onOpenFileRef.current) && looksLikeFilePath(text);
        const clickable = isPath || Boolean(onAskSideChatRef.current);
        return (
          <code
            onClick={
              isPath
                ? () => onOpenFileRef.current!(text)
                : clickable
                  ? () => onAskSideChatRef.current!(text)
                  : undefined
            }
            title={isPath ? "Open file" : clickable ? "Open in side chat" : undefined}
            style={{
              fontFamily: "var(--font-code)",
              fontSize: "0.84em",
              background: "var(--chip)",
              color: "var(--fg)",
              padding: "2px 6px",
              borderRadius: 6,
              cursor: clickable ? "pointer" : "inherit",
            }}
          >
            {props.children}
          </code>
        );
      },
      pre: (props: { children?: React.ReactNode }) => (
        <CodeBlock onOpenCode={onAskSideChatRef.current ? (t) => onAskSideChatRef.current!(t) : undefined}>
          {props.children}
        </CodeBlock>
      ),
      p: (props: { children?: React.ReactNode }) => <p style={{ margin: "10px 0" }}>{props.children}</p>,
      ul: (props: { children?: React.ReactNode }) => (
        <ul style={{ margin: "10px 0", paddingLeft: 24 }}>{props.children}</ul>
      ),
      ol: (props: { children?: React.ReactNode }) => (
        <ol style={{ margin: "10px 0", paddingLeft: 24 }}>{props.children}</ol>
      ),
      li: (props: { children?: React.ReactNode }) => <li style={{ margin: "4px 0" }}>{props.children}</li>,
    }),
    [],
  );

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
            background: "var(--chip)",
            border: `1px solid ${colors.border}`,
            borderRadius: 8,
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
                  padding: "8px 4px 8px 12px",
                  fontFamily: "inherit",
                }}
              />
              <button
                onClick={confirmAnnotation}
                title="Add annotation"
                aria-label="Add annotation"
                style={{ ...pillButtonStyle, display: "flex", alignItems: "center", padding: "7px 10px" }}
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
        <div ref={contentRef} style={{ maxWidth: 720, margin: "0 auto", padding: "0 24px", position: "relative" }}>
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
          {toDisplayBlocks(entries).map((block) => {
            if (block.kind === "steps") {
              return (
                <StepsGroup key={`s${block.key}`} items={block.items} statusLabel={statusLabel} decide={decide} />
              );
            }
            const e = block.entry;
            if (e.kind === "user") {
              return (
                <div key={block.key} style={{ display: "flex", justifyContent: "flex-end", margin: "10px 0" }}>
                  <div
                    style={{
                      maxWidth: "85%",
                      padding: "10px 14px",
                      borderRadius: 12,
                      background: "var(--user-bubble)",
                      whiteSpace: "pre-wrap",
                      lineHeight: 1.55,
                      fontSize: 14,
                    }}
                  >
                    {e.text}
                  </div>
                </div>
              );
            }
            if (e.kind === "assistant") {
              return (
                <div key={block.key} style={{ margin: "16px 0", lineHeight: 1.75, fontSize: 15.5 }}>
                  <Markdown remarkPlugins={REMARK_PLUGINS} components={mdComponents}>
                    {e.text}
                  </Markdown>
                  {e.interrupted && <div style={{ color: colors.dim, fontSize: 12, marginTop: 4 }}>— stopped</div>}
                  {e.text && <CopyButton text={e.text} />}
                </div>
              );
            }
            return null;
          })}
          {showThinking && (
            <div style={{ display: "flex", justifyContent: "flex-start", margin: "10px 0" }}>
              <div
                style={{
                  padding: "10px 14px",
                  borderRadius: 12,
                  background: colors.panel,
                  border: `1px solid ${colors.border}`,
                  fontSize: 14,
                  color: colors.dim,
                }}
              >
                thinking… {elapsed.toFixed(1)}s
              </div>
            </div>
          )}
        </div>
      </div>

      <div style={{ padding: "8px 16px 16px" }}>
        <div
          style={{
            position: "relative",
            maxWidth: 720,
            margin: "0 auto",
            background: colors.panel,
            border: `1px solid ${colors.border}`,
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
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            onPaste={(e) => {
              // A pasted image becomes an attachment; text pastes as usual.
              const items = Array.from(e.clipboardData?.items ?? []);
              if (!items.some((it) => it.type.startsWith("image/"))) return;
              e.preventDefault();
              void attachClipboardImage();
            }}
            placeholder={connected ? "Do anything" : "Engine starting…"}
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
            <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span ref={plusRef} style={{ position: "relative", display: "flex" }}>
                <button
                  onClick={() => (plusOpen ? setPlusOpen(false) : void openPlusMenu())}
                  disabled={!connected}
                  title="Add"
                  aria-label="Add"
                  aria-expanded={plusOpen}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 14,
                    background: plusOpen ? "var(--panel-2)" : "var(--chip)",
                    color: connected ? colors.fg : colors.dim,
                    border: `1px solid ${colors.border}`,
                    cursor: connected ? "pointer" : "default",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 15,
                    lineHeight: 1,
                  }}
                >
                  +
                </button>
              </span>
              <span style={{ color: colors.dim, fontSize: 12.5 }}>{contextLabel}</span>
            </span>
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
              <button
                onClick={() => void submit()}
                disabled={!canSend}
                title="Send"
                aria-label="Send"
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 16,
                  background: canSend ? colors.accent : "var(--panel-2)",
                  color: canSend ? "var(--accent-fg)" : colors.dim,
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
            )}
          </div>
        </div>
      </div>
    </div>
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
function CodeBlock({ children, onOpenCode }: { children?: React.ReactNode; onOpenCode?: (text: string) => void }) {
  const [copied, setCopied] = useState(false);
  const child = Array.isArray(children) ? children[0] : children;
  const className: string =
    (typeof child === "object" && child && "props" in child
      ? ((child as { props: { className?: string } }).props.className ?? "")
      : "") || "";
  const lang = /language-([\w-]+)/.exec(className)?.[1]?.toLowerCase() ?? "";
  const label = LANGUAGE_NAMES[lang] ?? (lang ? lang.toUpperCase() : "Plain text");
  const text = extractText(children).replace(/\n$/, "");

  return (
    <div
      onClick={
        onOpenCode
          ? () => {
              // A drag-select inside the block is reading, not clicking.
              if (window.getSelection()?.isCollapsed) onOpenCode(text);
            }
          : undefined
      }
      title={onOpenCode ? "Open in side chat" : undefined}
      style={{
        background: "var(--code-bg)",
        border: `1px solid ${colors.border}`,
        borderRadius: 10,
        margin: "12px 0",
        overflow: "hidden",
        cursor: onOpenCode ? "pointer" : "default",
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
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </button>
      </div>
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

function SettingsView({
  theme,
  onChange,
  onBack,
}: {
  theme: ThemeConfig;
  onChange: (t: ThemeConfig) => void;
  onBack: () => void;
}) {
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);

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
        <div
          style={{
            background: colors.panel,
            color: colors.fg,
            borderRadius: 8,
            padding: "8px 10px",
            fontSize: 13.5,
          }}
        >
          Appearance
        </div>
      </nav>

      <div style={{ flex: 1, overflowY: "auto", padding: "40px 48px" }}>
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
      </div>
    </div>
  );
}

function PaperclipIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
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
        color: disabled ? colors.dim : colors.fg,
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
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="9" y="9" width="13" height="13" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
      {copied ? "copied" : ""}
    </button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ color: colors.dim, fontSize: 12, fontWeight: 500, padding: "10px 8px 4px" }}>{children}</div>
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

function TerminalIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: colors.amber, flexShrink: 0 }}>
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.2 3.9A2 2 0 0 0 7.5 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
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
  busy,
  indent,
  onHover,
  onOpen,
  onDelete,
}: {
  thread: ThreadSummary;
  active: boolean;
  hovered: boolean;
  busy: boolean;
  indent?: boolean;
  onHover: (id: string | null) => void;
  onOpen: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  return (
    <div
      onMouseEnter={() => onHover(thread.id)}
      onMouseLeave={() => onHover(null)}
      style={{
        display: "flex",
        alignItems: "center",
        background: active ? colors.panel : "transparent",
        borderRadius: 8,
        marginBottom: 1,
        paddingLeft: indent ? 25 : 0,
      }}
    >
      <button
        onClick={() => void onOpen(thread.id)}
        disabled={busy}
        title={thread.title}
        style={{
          flex: 1,
          minWidth: 0,
          background: "transparent",
          color: active ? colors.fg : colors.dim,
          border: "none",
          padding: "7px 4px 7px 8px",
          fontSize: 13,
          textAlign: "left",
          cursor: busy ? "default" : "pointer",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          fontFamily: "inherit",
        }}
      >
        {thread.title}
      </button>
      {hovered && !busy && (
        <button
          onClick={() => void onDelete(thread.id)}
          title="Delete conversation"
          aria-label="Delete conversation"
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
          onMouseEnter={(ev) => ((ev.currentTarget as HTMLButtonElement).style.color = colors.err)}
          onMouseLeave={(ev) => ((ev.currentTarget as HTMLButtonElement).style.color = colors.dim)}
        >
          <TrashIcon />
        </button>
      )}
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
  decide: (itemId: string, requestId: string, decision: "accept" | "decline") => Promise<void>;
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
    ? { text: "Needs your approval", color: colors.amber }
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
        {summary.text}
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
                <span style={{ whiteSpace: "pre-wrap", color: colors.fg }}>{e.command}</span>
              </div>
              {e.approval?.reason && (
                <div style={{ color: colors.dim, marginTop: 6, fontFamily: "inherit" }}>{e.approval.reason}</div>
              )}
              {e.status === "awaitingApproval" && e.approval && !e.approval.decision && (
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <button
                    onClick={() => void decide(e.itemId, e.approval!.requestId, "accept")}
                    style={{
                      background: colors.ok,
                      color: "#04342C",
                      border: "none",
                      borderRadius: 8,
                      padding: "6px 16px",
                      fontSize: 13,
                      cursor: "pointer",
                      fontFamily: "var(--font-ui)",
                    }}
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => void decide(e.itemId, e.approval!.requestId, "decline")}
                    style={{
                      background: "transparent",
                      color: colors.err,
                      border: `1px solid ${colors.err}`,
                      borderRadius: 8,
                      padding: "6px 16px",
                      fontSize: 13,
                      cursor: "pointer",
                      fontFamily: "var(--font-ui)",
                    }}
                  >
                    Decline
                  </button>
                </div>
              )}
              {e.output && itemOpen && (
                <pre
                  style={{
                    margin: "8px 0 0",
                    color: colors.dim,
                    whiteSpace: "pre-wrap",
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
