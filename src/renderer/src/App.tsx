import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

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

type ThreadSummary = { id: string; title: string; createdAt?: string };
type SidebarData = {
  projects: { name: string; path: string; threads: ThreadSummary[] }[];
  recents: ThreadSummary[];
};

declare global {
  interface Window {
    unbiased: {
      getEngineStatus: () => Promise<EngineStatus>;
      onEngineStatus: (cb: (status: EngineStatus) => void) => () => void;
      sendMessage: (text: string) => Promise<{ turnId: string | null; threadId: string; created: boolean }>;
      interrupt: () => Promise<{ interrupted: boolean }>;
      onTurnStarted: (cb: (p: { turnId: string | null }) => void) => () => void;
      onDelta: (cb: (p: { delta: string }) => void) => () => void;
      onTurnCompleted: (cb: (p: { status: string }) => void) => () => void;
      decideApproval: (requestId: string, decision: "accept" | "decline") => Promise<{ ok: boolean }>;
      onApprovalRequest: (
        cb: (p: {
          requestId: string;
          itemId: string | null;
          command: string;
          cwd: string | null;
          reason: string | null;
        }) => void,
      ) => () => void;
      onCommand: (cb: (p: { phase: "started" | "completed"; item: CommandItem }) => void) => () => void;
      listThreads: () => Promise<SidebarData>;
      openThread: (id: string) => Promise<{ id: string; entries: Entry[] }>;
      detachThread: (cwd?: string) => Promise<{ ok: boolean }>;
      deleteThread: (id: string) => Promise<{ ok: boolean }>;
      chooseProject: () => Promise<{ path: string | null; name: string | null }>;
    };
  }
}

const colors = {
  bg: "#16161a",
  panel: "#1e1e23",
  border: "#2a2a2e",
  fg: "#e8e6e3",
  dim: "#8a8886",
  accent: "#FF7764",
  ok: "#5DCAA5",
  err: "#F09595",
  amber: "#FAC775",
};

/** Drop a trailing empty assistant placeholder (it exists only so deltas have
 *  somewhere to land; once a command card or turn end arrives, an empty one
 *  is just noise). */
function withoutTrailingPlaceholder(es: Entry[]): Entry[] {
  const last = es[es.length - 1];
  if (last?.kind === "assistant" && last.text === "" && !last.interrupted) return es.slice(0, -1);
  return es;
}

type CommandEntry = Extract<Entry, { kind: "command" }>;
type DisplayBlock = { kind: "entry"; entry: Entry; key: number } | { kind: "steps"; items: CommandEntry[]; key: number };

/** Consecutive command entries collapse into one steps group — the agent's
 *  work reads as a single disclosure, the way the answer reads as one bubble. */
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
  const [status, setStatus] = useState<EngineStatus>({ state: "starting" });
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [sidebar, setSidebar] = useState<SidebarData>({ projects: [], recents: [] });
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [hoveredThreadId, setHoveredThreadId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  async function refreshThreads() {
    setSidebar(await window.unbiased.listThreads());
  }

  const [activeProject, setActiveProject] = useState<{ name: string; path: string } | null>(null);

  async function newChat(project?: { name: string; path: string }) {
    if (busy) return;
    await window.unbiased.detachThread(project?.path);
    setActiveProject(project ?? null);
    setActiveThreadId(null);
    setEntries([]);
  }

  async function openProjectDialog() {
    if (busy) return;
    const { path, name } = await window.unbiased.chooseProject();
    if (!path || !name) return; // cancelled
    setActiveProject({ name, path });
    setActiveThreadId(null);
    setEntries([]);
    void refreshThreads(); // the project shows in the sidebar immediately
  }

  async function openThread(id: string) {
    if (busy || id === activeThreadId) return;
    const { entries: history } = await window.unbiased.openThread(id);
    setActiveProject(null);
    setActiveThreadId(id);
    setEntries(history);
  }

  async function deleteThread(id: string) {
    if (busy) return;
    await window.unbiased.deleteThread(id);
    if (id === activeThreadId) {
      setActiveThreadId(null);
      setEntries([]);
    }
    void refreshThreads();
  }

  // Pareto today completes the whole response before its first byte arrives
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
    window.unbiased.getEngineStatus().then((s) => {
      setStatus(s);
      if (s.state === "connected") void refreshThreads();
    });
    const offs = [
      window.unbiased.onEngineStatus((s: EngineStatus) => {
        setStatus(s);
        if (s.state === "connected") void refreshThreads();
      }),
      window.unbiased.onDelta(({ delta }) => {
        setEntries((es) => {
          const last = es[es.length - 1];
          if (!last || last.kind !== "assistant") return [...es, { kind: "assistant", text: delta }];
          return [...es.slice(0, -1), { ...last, text: last.text + delta }];
        });
      }),
      window.unbiased.onTurnCompleted(({ status: turnStatus }) => {
        setBusy(false);
        void refreshThreads(); // previews/titles update after a turn lands
        setEntries((es) => {
          let next = es;
          if (turnStatus === "interrupted") {
            const last = next[next.length - 1];
            if (last?.kind === "assistant" && last.text !== "") {
              next = [...next.slice(0, -1), { ...last, interrupted: true }];
            }
          }
          return withoutTrailingPlaceholder(next);
        });
      }),
      window.unbiased.onApprovalRequest((p) => {
        setEntries((es) => {
          const cleaned = withoutTrailingPlaceholder(es);
          const approval = { requestId: p.requestId, reason: p.reason };
          const idx = cleaned.findIndex((e) => e.kind === "command" && e.itemId === p.itemId);
          if (idx !== -1) {
            const cmd = cleaned[idx] as Extract<Entry, { kind: "command" }>;
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
      window.unbiased.onCommand(({ phase, item }) => {
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
                status: item.status ?? (phase === "started" ? "inProgress" : "completed"),
                exitCode: item.exitCode,
                output: item.aggregatedOutput ?? item.output,
              },
            ];
          }
          const existing = cleaned[idx] as Extract<Entry, { kind: "command" }>;
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
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [entries]);

  const connected = status.state === "connected";
  const lastEntry = entries[entries.length - 1];
  const showThinking = busy && !(lastEntry?.kind === "assistant" && lastEntry.text !== "");

  async function submit() {
    const text = draft.trim();
    if (!text || busy || !connected) return;
    setDraft("");
    setBusy(true);
    setEntries((es) => [...es, { kind: "user", text }]);
    try {
      const result = await window.unbiased.sendMessage(text);
      if (result.created) {
        setActiveThreadId(result.threadId);
        void refreshThreads();
      }
    } catch (err) {
      setBusy(false);
      setEntries((es) => [...es, { kind: "assistant", text: `Something went wrong: ${String(err)}` }]);
    }
  }

  async function decide(itemId: string, requestId: string, decision: "accept" | "decline") {
    setEntries((es) =>
      es.map((e) =>
        e.kind === "command" && e.itemId === itemId && e.approval
          ? { ...e, approval: { ...e.approval, decision }, status: decision === "decline" ? "declined" : "inProgress" }
          : e,
      ),
    );
    await window.unbiased.decideApproval(requestId, decision);
  }

  const statusLabel = (e: Extract<Entry, { kind: "command" }>) => {
    if (e.status === "awaitingApproval") return { text: "▸ needs approval", color: colors.amber };
    if (e.status === "inProgress") return { text: "▸ running", color: colors.amber };
    if (e.status === "declined") return { text: "▸ declined", color: colors.dim };
    if (e.status === "failed" || (e.exitCode ?? 0) !== 0) return { text: `▸ exit ${e.exitCode ?? "?"}`, color: colors.err };
    return { text: "▸ done", color: colors.ok };
  };

  const mdComponents = {
    code: (props: { className?: string; children?: React.ReactNode }) => (
      <code
        style={{
          fontFamily: "ui-monospace, SFMono-Regular, monospace",
          fontSize: 12.5,
          background: "#141417",
          padding: props.className ? undefined : "1px 5px",
          borderRadius: 4,
          display: props.className ? "block" : "inline",
          overflowX: props.className ? "auto" : undefined,
        }}
      >
        {props.children}
      </code>
    ),
    pre: (props: { children?: React.ReactNode }) => (
      <pre
        style={{
          background: "#141417",
          border: `1px solid ${colors.border}`,
          borderRadius: 8,
          padding: "10px 12px",
          overflowX: "auto",
          margin: "8px 0",
        }}
      >
        {props.children}
      </pre>
    ),
    p: (props: { children?: React.ReactNode }) => <p style={{ margin: "6px 0" }}>{props.children}</p>,
    ul: (props: { children?: React.ReactNode }) => (
      <ul style={{ margin: "6px 0", paddingLeft: 22 }}>{props.children}</ul>
    ),
    ol: (props: { children?: React.ReactNode }) => (
      <ol style={{ margin: "6px 0", paddingLeft: 22 }}>{props.children}</ol>
    ),
  };

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        background: colors.bg,
        color: colors.fg,
        fontFamily: "-apple-system, system-ui, sans-serif",
      }}
    >
      <nav
        style={{
          width: 248,
          flexShrink: 0,
          borderRight: `1px solid ${colors.border}`,
          display: "flex",
          flexDirection: "column",
          background: "#131317",
        }}
      >
        <div style={{ padding: "14px 14px 6px" }}>
          <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: -0.3, marginBottom: 14 }}>
            <span style={{ color: colors.accent }}>un</span>biased
          </div>
          <button
            onClick={() => void newChat()}
            disabled={busy}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              width: "100%",
              background: "transparent",
              color: busy ? colors.dim : colors.fg,
              border: "none",
              borderRadius: 8,
              padding: "8px 8px",
              fontSize: 14,
              cursor: busy ? "default" : "pointer",
              textAlign: "left",
              fontFamily: "inherit",
            }}
          >
            <PencilIcon />
            New chat
          </button>
          <button
            onClick={() => void openProjectDialog()}
            disabled={busy}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              width: "100%",
              background: "transparent",
              color: busy ? colors.dim : colors.fg,
              border: "none",
              borderRadius: 8,
              padding: "8px 8px",
              fontSize: 14,
              cursor: busy ? "default" : "pointer",
              textAlign: "left",
              fontFamily: "inherit",
            }}
          >
            <FolderPlusIcon />
            Open project…
          </button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "0 8px 12px" }}>
          {sidebar.projects.length === 0 && sidebar.recents.length === 0 && (
            <div style={{ color: colors.dim, fontSize: 12, padding: "8px 8px" }}>No conversations yet</div>
          )}

          {sidebar.projects.length > 0 && <SectionLabel>Projects</SectionLabel>}
          {sidebar.projects.map((p) => (
            <div key={p.path} style={{ marginBottom: 8 }}>
              <button
                onClick={() => void newChat({ name: p.name, path: p.path })}
                disabled={busy}
                title={`New chat in ${p.path}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  background: activeProject?.path === p.path ? colors.panel : "transparent",
                  border: "none",
                  borderRadius: 8,
                  padding: "7px 8px 5px",
                  fontSize: 14,
                  color: colors.fg,
                  cursor: busy ? "default" : "pointer",
                  textAlign: "left",
                  fontFamily: "inherit",
                }}
              >
                <FolderIcon />
                <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
              </button>
              {p.threads.map((t) => (
                <ThreadRow
                  key={t.id}
                  thread={t}
                  active={t.id === activeThreadId}
                  hovered={hoveredThreadId === t.id}
                  busy={busy}
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
              busy={busy}
              onHover={setHoveredThreadId}
              onOpen={openThread}
              onDelete={deleteThread}
            />
          ))}
        </div>
      </nav>

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
      <header
        style={{
          padding: "12px 24px",
          borderBottom: `1px solid ${colors.border}`,
          fontSize: 14,
          fontWeight: 500,
          color: colors.fg,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          flexShrink: 0,
        }}
      >
        {(() => {
          if (activeThreadId) {
            const all = [...sidebar.projects.flatMap((p) => p.threads), ...sidebar.recents];
            return all.find((t) => t.id === activeThreadId)?.title ?? "Conversation";
          }
          return activeProject ? `New chat · ${activeProject.name}` : "New chat";
        })()}
      </header>
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "24px 0" }}>
        {entries.length === 0 && (
          <div style={{ height: "100%", display: "grid", placeItems: "center" }}>
            <div style={{ textAlign: "center" }}>
              <h1 style={{ fontSize: 42, fontWeight: 600, letterSpacing: -1, margin: 0 }}>
                <span style={{ color: colors.accent }}>un</span>biased
              </h1>
              <p style={{ color: colors.dim, marginTop: 8 }}>
                {!connected
                  ? "Waiting for the engine…"
                  : activeProject
                    ? (
                        <>
                          New chat in <span style={{ color: colors.fg }}>{activeProject.name}</span>
                        </>
                      )
                    : "Ask Pareto anything."}
              </p>
            </div>
          </div>
        )}
        <div style={{ maxWidth: 720, margin: "0 auto", padding: "0 24px" }}>
          {toDisplayBlocks(entries).map((block) => {
            if (block.kind === "steps") {
              return (
                <StepsGroup
                  key={`s${block.key}`}
                  items={block.items}
                  statusLabel={statusLabel}
                  decide={decide}
                />
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
                      background: "#33322f",
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
                <div key={block.key} style={{ margin: "14px 0", lineHeight: 1.7, fontSize: 15 }}>
                  <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                    {e.text}
                  </Markdown>
                  {e.interrupted && (
                    <div style={{ color: colors.dim, fontSize: 12, marginTop: 4 }}>— stopped</div>
                  )}
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

      <div style={{ padding: "8px 24px 18px" }}>
        <div
          style={{
            maxWidth: 720,
            margin: "0 auto",
            background: colors.panel,
            border: `1px solid ${colors.border}`,
            borderRadius: 16,
            padding: "12px 14px 10px",
          }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
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
            <span style={{ color: colors.dim, fontSize: 12.5 }}>
              {activeProject ? `${activeProject.name} · ` : ""}pareto · read-only
            </span>
            {busy ? (
              <button
                onClick={() => void window.unbiased.interrupt()}
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
                disabled={!connected || !draft.trim()}
                title="Send"
                aria-label="Send"
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 16,
                  background: connected && draft.trim() ? colors.accent : "#2a2a2e",
                  color: connected && draft.trim() ? "#3b1008" : colors.dim,
                  border: "none",
                  cursor: connected && draft.trim() ? "pointer" : "default",
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

      <ChatFooter status={status} busy={busy} elapsed={elapsed} />
      </div>
    </div>
  );
}

function ChatFooter({ status, busy, elapsed }: { status: EngineStatus; busy: boolean; elapsed: number }) {
  return (
    <footer
      style={{
        padding: "8px 16px",
        borderTop: `1px solid ${colors.border}`,
        fontSize: 12,
        color: colors.dim,
        display: "flex",
        gap: 8,
        alignItems: "center",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          background:
            status.state === "connected" ? colors.ok : status.state === "starting" ? colors.accent : colors.err,
        }}
      />
      {status.state === "connected" && (
        <span>
          connected · pareto · engine {status.engineVersion}
          {busy ? ` · thinking… ${elapsed.toFixed(0)}s` : ""}
        </span>
      )}
      {status.state === "starting" && <span>starting engine…</span>}
      {status.state === "exited" && <span style={{ color: colors.err }}>{status.detail}</span>}
    </footer>
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
          fontFamily: "-apple-system, system-ui, sans-serif",
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
                background: "#141417",
                fontSize: 12.5,
                fontFamily: "ui-monospace, SFMono-Regular, monospace",
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
                      fontFamily: "-apple-system, system-ui, sans-serif",
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
                      fontFamily: "-apple-system, system-ui, sans-serif",
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
