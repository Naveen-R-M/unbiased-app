import { useEffect, useRef, useState } from "react";

type EngineStatus =
  | { state: "starting" }
  | { state: "connected"; userAgent: string; engineVersion: string; codexHome: string }
  | { state: "exited"; code: number | null; detail: string };

type Message = { role: "user" | "assistant"; text: string; interrupted?: boolean };

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
};

export function App() {
  const [status, setStatus] = useState<EngineStatus>({ state: "starting" });
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.unbiased.getEngineStatus().then(setStatus);
    const offStatus = window.unbiased.onEngineStatus(setStatus);
    const offDelta = window.unbiased.onDelta(({ delta }) => {
      setMessages((ms) => {
        const last = ms[ms.length - 1];
        if (!last || last.role !== "assistant") return [...ms, { role: "assistant", text: delta }];
        return [...ms.slice(0, -1), { ...last, text: last.text + delta }];
      });
    });
    const offDone = window.unbiased.onTurnCompleted(({ status: turnStatus }) => {
      setBusy(false);
      if (turnStatus === "interrupted") {
        setMessages((ms) => {
          const last = ms[ms.length - 1];
          if (last?.role === "assistant") {
            return [...ms.slice(0, -1), { ...last, interrupted: true }];
          }
          return ms;
        });
      }
    });
    return () => {
      offStatus();
      offDelta();
      offDone();
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const connected = status.state === "connected";

  async function submit() {
    const text = draft.trim();
    if (!text || busy || !connected) return;
    setDraft("");
    setBusy(true);
    setMessages((ms) => [...ms, { role: "user", text }, { role: "assistant", text: "" }]);
    try {
      await window.unbiased.sendMessage(text);
    } catch (err) {
      setBusy(false);
      setMessages((ms) => [
        ...ms.slice(0, -1),
        { role: "assistant", text: `Something went wrong: ${String(err)}` },
      ]);
    }
  }

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
        {messages.length === 0 && (
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
          {messages.map((m, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                justifyContent: m.role === "user" ? "flex-end" : "flex-start",
                margin: "10px 0",
              }}
            >
              <div
                style={{
                  maxWidth: "85%",
                  padding: "10px 14px",
                  borderRadius: 12,
                  background: m.role === "user" ? "#33322f" : colors.panel,
                  border: m.role === "assistant" ? `1px solid ${colors.border}` : "none",
                  whiteSpace: "pre-wrap",
                  lineHeight: 1.55,
                  fontSize: 14,
                }}
              >
                {m.text || (busy && i === messages.length - 1 ? "…" : "")}
                {m.interrupted && (
                  <div style={{ color: colors.dim, fontSize: 12, marginTop: 6 }}>— stopped</div>
                )}
              </div>
            </div>
          ))}
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
            {busy ? " · thinking…" : ""}
          </span>
        )}
        {status.state === "starting" && <span>starting engine…</span>}
        {status.state === "exited" && <span style={{ color: colors.err }}>{status.detail}</span>}
      </footer>
    </div>
  );
}
