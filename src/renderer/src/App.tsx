import { useEffect, useState } from "react";

type EngineStatus =
  | { state: "starting" }
  | { state: "connected"; userAgent: string; engineVersion: string; codexHome: string }
  | { state: "exited"; code: number | null; detail: string };

declare global {
  interface Window {
    unbiased: {
      getEngineStatus: () => Promise<EngineStatus>;
      onEngineStatus: (cb: (status: EngineStatus) => void) => () => void;
    };
  }
}

const colors = {
  bg: "#16161a",
  fg: "#e8e6e3",
  dim: "#8a8886",
  accent: "#FF7764",
  ok: "#5DCAA5",
  err: "#F09595",
};

export function App() {
  const [status, setStatus] = useState<EngineStatus>({ state: "starting" });

  useEffect(() => {
    window.unbiased.getEngineStatus().then(setStatus);
    return window.unbiased.onEngineStatus(setStatus);
  }, []);

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
      <main style={{ flex: 1, display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center" }}>
          <h1 style={{ fontSize: 42, fontWeight: 600, letterSpacing: -1, margin: 0 }}>
            <span style={{ color: colors.accent }}>un</span>biased
          </h1>
          <p style={{ color: colors.dim, marginTop: 8 }}>
            {status.state === "connected"
              ? "The engine is up. Chat lands here next."
              : status.state === "starting"
                ? "Starting the engine…"
                : "The engine is not running."}
          </p>
        </div>
      </main>

      <footer
        style={{
          padding: "10px 16px",
          borderTop: "1px solid #2a2a2e",
          fontSize: 13,
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
              status.state === "connected"
                ? colors.ok
                : status.state === "starting"
                  ? colors.accent
                  : colors.err,
          }}
        />
        {status.state === "connected" && (
          <span>
            connected · pareto · engine {status.engineVersion} ·{" "}
            <span title={status.codexHome}>{status.codexHome.replace(/^\/Users\/[^/]+/, "~")}</span>
          </span>
        )}
        {status.state === "starting" && <span>starting engine…</span>}
        {status.state === "exited" && <span style={{ color: colors.err }}>{status.detail}</span>}
      </footer>
    </div>
  );
}
