import { useEffect, useRef, useState } from "react";

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
      kind: "approval";
      requestId: string;
      command: string;
      reason: string | null;
      decision?: "accept" | "decline";
    }
  | { kind: "command"; itemId: string; command: string; status: string; exitCode?: number; output?: string };

declare global {
  interface Window {
    unbiased: {
      getEngineStatus: () => Promise<EngineStatus>;
      onEngineStatus: (cb: (status: EngineStatus) => void) => () => void;
      sendMessage: (text: string) => Promise<{ turnId: string | null }>;
      interrupt: () => Promise<{ interrupted: boolean }>;
      onTurnStarted: (cb: (p: { turnId: string | null }) => void) => () => void;
      onDelta: (cb: (p: { delta: string }) => void) => () => void;
      onTurnCompleted: (cb: (p: { status: string }) => void) => () => void;
      decideApproval: (requestId: string, decision: "accept" | "decline") => Promise<{ ok: boolean }>;
      onApprovalRequest: (
        cb: (p: { requestId: string; command: string; cwd: string | null; reason: string | null }) => void,
      ) => () => void;
      onCommand: (cb: (p: { phase: "started" | "completed"; item: CommandItem }) => void) => () => void;
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

export function App() {
  const [status, setStatus] = useState<EngineStatus>({ state: "starting" });
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

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
    window.unbiased.getEngineStatus().then(setStatus);
    const offs = [
      window.unbiased.onEngineStatus(setStatus),
      window.unbiased.onDelta(({ delta }) => {
        setEntries((es) => {
          const last = es[es.length - 1];
          if (!last || last.kind !== "assistant") return [...es, { kind: "assistant", text: delta }];
          return [...es.slice(0, -1), { ...last, text: last.text + delta }];
        });
      }),
      window.unbiased.onTurnCompleted(({ status: turnStatus }) => {
        setBusy(false);
        if (turnStatus === "interrupted") {
          setEntries((es) => {
            const last = es[es.length - 1];
            if (last?.kind === "assistant") return [...es.slice(0, -1), { ...last, interrupted: true }];
            return es;
          });
        }
      }),
      window.unbiased.onApprovalRequest((p) => {
        setEntries((es) => [
          ...es,
          { kind: "approval", requestId: p.requestId, command: p.command, reason: p.reason },
        ]);
      }),
      window.unbiased.onCommand(({ phase, item }) => {
        setEntries((es) => {
          const itemId = item.id ?? "unknown";
          const next: Entry = {
            kind: "command",
            itemId,
            command: item.command ?? "(command)",
            status: item.status ?? (phase === "started" ? "inProgress" : "completed"),
            exitCode: item.exitCode,
            output: item.aggregatedOutput ?? item.output,
          };
          const idx = es.findIndex((e) => e.kind === "command" && e.itemId === itemId);
          if (idx === -1) return [...es, next];
          return [...es.slice(0, idx), next, ...es.slice(idx + 1)];
        });
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [entries]);

  const connected = status.state === "connected";

  async function submit() {
    const text = draft.trim();
    if (!text || busy || !connected) return;
    setDraft("");
    setBusy(true);
    setEntries((es) => [...es, { kind: "user", text }, { kind: "assistant", text: "" }]);
    try {
      await window.unbiased.sendMessage(text);
    } catch (err) {
      setBusy(false);
      setEntries((es) => [
        ...es.slice(0, -1),
        { kind: "assistant", text: `Something went wrong: ${String(err)}` },
      ]);
    }
  }

  async function decide(requestId: string, decision: "accept" | "decline") {
    setEntries((es) =>
      es.map((e) => (e.kind === "approval" && e.requestId === requestId ? { ...e, decision } : e)),
    );
    await window.unbiased.decideApproval(requestId, decision);
  }

  const commandStatusColor = (s: string, exitCode?: number) =>
    s === "declined" ? colors.dim : s === "failed" || (exitCode ?? 0) !== 0 ? colors.err : s === "inProgress" ? colors.amber : colors.ok;

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: colors.bg,
        color: colors.fg,
        fontFamily: "-apple-system, system-ui, sans-serif",
      }}
    >
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "24px 0" }}>
        {entries.length === 0 && (
          <div style={{ height: "100%", display: "grid", placeItems: "center" }}>
            <div style={{ textAlign: "center" }}>
              <h1 style={{ fontSize: 42, fontWeight: 600, letterSpacing: -1, margin: 0 }}>
                <span style={{ color: colors.accent }}>un</span>biased
              </h1>
              <p style={{ color: colors.dim, marginTop: 8 }}>
                {connected ? "Ask Pareto anything." : "Waiting for the engine…"}
              </p>
            </div>
          </div>
        )}
        <div style={{ maxWidth: 720, margin: "0 auto", padding: "0 24px" }}>
          {entries.map((e, i) => {
            if (e.kind === "user" || e.kind === "assistant") {
              return (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    justifyContent: e.kind === "user" ? "flex-end" : "flex-start",
                    margin: "10px 0",
                  }}
                >
                  <div
                    style={{
                      maxWidth: "85%",
                      padding: "10px 14px",
                      borderRadius: 12,
                      background: e.kind === "user" ? "#33322f" : colors.panel,
                      border: e.kind === "assistant" ? `1px solid ${colors.border}` : "none",
                      whiteSpace: "pre-wrap",
                      lineHeight: 1.55,
                      fontSize: 14,
                    }}
                  >
                    {e.text ||
                      (busy && i === entries.length - 1 && e.kind === "assistant" ? (
                        <span style={{ color: colors.dim }}>thinking… {elapsed.toFixed(1)}s</span>
                      ) : (
                        ""
                      ))}
                    {e.kind === "assistant" && e.interrupted && (
                      <div style={{ color: colors.dim, fontSize: 12, marginTop: 6 }}>— stopped</div>
                    )}
                  </div>
                </div>
              );
            }
            if (e.kind === "approval") {
              return (
                <div
                  key={i}
                  style={{
                    margin: "10px 0",
                    padding: "12px 14px",
                    borderRadius: 12,
                    border: `1px solid ${e.decision ? colors.border : colors.amber}`,
                    background: colors.panel,
                    fontSize: 13,
                  }}
                >
                  <div style={{ color: e.decision ? colors.dim : colors.amber, marginBottom: 8 }}>
                    {e.decision ? `Command ${e.decision === "accept" ? "approved" : "declined"}` : "Pareto wants to run a command"}
                  </div>
                  <code
                    style={{
                      display: "block",
                      fontFamily: "ui-monospace, SFMono-Regular, monospace",
                      fontSize: 12.5,
                      color: colors.fg,
                      whiteSpace: "pre-wrap",
                      marginBottom: e.reason || !e.decision ? 10 : 0,
                    }}
                  >
                    {e.command}
                  </code>
                  {e.reason && <div style={{ color: colors.dim, marginBottom: 10 }}>{e.reason}</div>}
                  {!e.decision && (
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        onClick={() => void decide(e.requestId, "accept")}
                        style={{
                          background: colors.ok,
                          color: "#04342C",
                          border: "none",
                          borderRadius: 8,
                          padding: "6px 16px",
                          fontSize: 13,
                          cursor: "pointer",
                        }}
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => void decide(e.requestId, "decline")}
                        style={{
                          background: "transparent",
                          color: colors.err,
                          border: `1px solid ${colors.err}`,
                          borderRadius: 8,
                          padding: "6px 16px",
                          fontSize: 13,
                          cursor: "pointer",
                        }}
                      >
                        Decline
                      </button>
                    </div>
                  )}
                </div>
              );
            }
            // command
            return (
              <div
                key={i}
                style={{
                  margin: "10px 0",
                  padding: "10px 14px",
                  borderRadius: 12,
                  border: `1px solid ${colors.border}`,
                  background: "#141417",
                  fontSize: 12.5,
                  fontFamily: "ui-monospace, SFMono-Regular, monospace",
                }}
              >
                <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                  <span style={{ color: commandStatusColor(e.status, e.exitCode) }}>
                    {e.status === "inProgress" ? "▸ running" : e.status === "declined" ? "▸ declined" : (e.exitCode ?? 0) === 0 && e.status !== "failed" ? "▸ done" : `▸ exit ${e.exitCode}`}
                  </span>
                  <span style={{ whiteSpace: "pre-wrap", color: colors.fg }}>{e.command}</span>
                </div>
                {e.output && (
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
      </div>

      <div style={{ padding: "12px 24px 16px", borderTop: `1px solid ${colors.border}` }}>
        <div style={{ maxWidth: 720, margin: "0 auto", display: "flex", gap: 8 }}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder={connected ? "Message Pareto — Enter to send, Shift+Enter for newline" : "Engine starting…"}
            disabled={!connected}
            rows={2}
            style={{
              flex: 1,
              resize: "none",
              background: colors.panel,
              color: colors.fg,
              border: `1px solid ${colors.border}`,
              borderRadius: 10,
              padding: "10px 12px",
              fontSize: 14,
              fontFamily: "inherit",
              outline: "none",
            }}
          />
          {busy ? (
            <button
              onClick={() => void window.unbiased.interrupt()}
              style={{
                background: "transparent",
                color: colors.err,
                border: `1px solid ${colors.err}`,
                borderRadius: 10,
                padding: "0 18px",
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              Stop
            </button>
          ) : (
            <button
              onClick={() => void submit()}
              disabled={!connected || !draft.trim()}
              style={{
                background: connected && draft.trim() ? colors.accent : colors.panel,
                color: connected && draft.trim() ? "#3b1008" : colors.dim,
                border: "none",
                borderRadius: 10,
                padding: "0 18px",
                fontSize: 14,
                cursor: connected && draft.trim() ? "pointer" : "default",
              }}
            >
              Send
            </button>
          )}
        </div>
      </div>

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
    </div>
  );
}
