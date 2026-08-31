/**
 * A secret-injecting OAuth proxy for MCP connectors whose provider demands a
 * client_secret at token exchange (Google), running against an engine whose
 * OAuth flow loses the secret between authorize and exchange (measured:
 * Google answered "client_secret is missing" to a flow whose plugin config
 * carried one — the engine's stored flow state has no field for it).
 *
 * The shape: the connector's plugin points at this proxy instead of the real
 * server. MCP traffic passes straight through. OAuth discovery is rewritten
 * so the AUTHORIZE step still goes to the real provider in the user's real
 * browser, but the TOKEN endpoint lands here — where the secret is added and
 * the request forwarded. Refresh grants take the same path, so long-lived
 * sign-ins keep working.
 *
 * One port per connector, fixed: every derived value downstream (the token
 * store key, the loopback callback hash) is keyed on the server URL, so the
 * URL must never change across restarts.
 *
 * Pure Node, no Electron: upstream config is injected so the whole thing is
 * testable against a fake provider (npm test).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type SecretConnector = {
  name: string;
  /** The REAL MCP server, e.g. https://gmailmcp.googleapis.com/mcp/v1 */
  upstreamUrl: string;
  clientId: string;
  clientSecret: string;
};

/**
 * Fixed ports, one per known secret connector. Duplicated in the engine
 * (internal/engine/mcp.go), which writes plugin files pointing at them — the
 * two tables must agree or the plugin dials a port nobody is listening on.
 */
export const SECRET_PROXY_PORTS: Record<string, number> = {
  gmail: 45991,
  "google-calendar": 45992,
  "google-drive": 45993,
};

/** A stable fallback port for any future secret connector outside the table:
 *  45900–45979, derived from the name. Collisions surface at bind time. */
export function secretProxyPort(name: string): number {
  const fixed = SECRET_PROXY_PORTS[name];
  if (fixed) return fixed;
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 45900 + (h % 80);
}

type Deps = {
  fetch?: typeof fetch;
  log?: (msg: string) => void;
  /** Override the listening port. Production always takes the fixed table —
   *  this exists so tests bind an ephemeral port (0) instead of fighting a
   *  running app for 45991. */
  port?: number;
};

type Discovered = {
  tokenEndpoint: string;
  asMetadata: Record<string, unknown>;
  prm: Record<string, unknown> | null;
};

async function fetchJson(f: typeof fetch, url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await f(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Upstream discovery, cached per proxy: the real PRM, the real AS metadata,
 *  and above all the real token endpoint the injector forwards to. */
async function discoverUpstream(f: typeof fetch, upstreamUrl: string): Promise<Discovered | null> {
  const u = new URL(upstreamUrl);
  const prm =
    (await fetchJson(f, `${u.origin}/.well-known/oauth-protected-resource${u.pathname}`)) ??
    (await fetchJson(f, `${u.origin}/.well-known/oauth-protected-resource`));
  const servers = Array.isArray(prm?.authorization_servers) ? (prm!.authorization_servers as unknown[]) : [];
  const issuer = typeof servers[0] === "string" ? (servers[0] as string) : u.origin;
  const iss = new URL(issuer);
  const meta =
    (await fetchJson(f, `${iss.origin}/.well-known/oauth-authorization-server${iss.pathname === "/" ? "" : iss.pathname}`)) ??
    (await fetchJson(f, `${iss.origin}/.well-known/oauth-authorization-server`)) ??
    (await fetchJson(f, `${iss.origin}/.well-known/openid-configuration`));
  const tokenEndpoint = typeof meta?.token_endpoint === "string" ? meta.token_endpoint : null;
  if (!meta || !tokenEndpoint) return null;
  return { tokenEndpoint, asMetadata: meta, prm };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const raw = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(raw) });
  res.end(raw);
}

/**
 * Start one proxy for one connector. Returns the server; the caller owns its
 * lifetime. `origin` (http://127.0.0.1:<port>) is what the plugin's URL and
 * the rewritten metadata advertise.
 */
export async function startSecretProxy(connector: SecretConnector, deps: Deps = {}): Promise<Server> {
  const f = deps.fetch ?? fetch;
  const log = deps.log ?? (() => {});
  const port = deps.port ?? secretProxyPort(connector.name);
  // Assigned after listen, because an ephemeral port is only known then. Every
  // read happens inside a request handler, long after that.
  let origin = `http://127.0.0.1:${port}`;
  const upstream = new URL(connector.upstreamUrl);
  let discovered: Discovered | null = null;
  const discover = async () => (discovered ??= await discoverUpstream(f, connector.upstreamUrl));

  // state -> where codex wants the code delivered. Short-lived by nature: an
  // authorization leg that has not finished within the window is abandoned.
  const pendingRedirects = new Map<string, { redirectUri: string; at: number }>();
  const PENDING_TTL_MS = 15 * 60_000;
  const prunePending = () => {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [k, v] of pendingRedirects) if (v.at < cutoff) pendingRedirects.delete(k);
  };
  /** Fallback for a provider that drops `state`: the newest live leg. */
  const lastPending = () => {
    let newest: { redirectUri: string; at: number } | null = null;
    for (const v of pendingRedirects.values()) if (!newest || v.at > newest.at) newest = v;
    return newest;
  };

  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? "/").split("?")[0];

      // ── OAuth discovery, rewritten ──────────────────────────────────
      if (req.method === "GET" && path.startsWith("/.well-known/oauth-protected-resource")) {
        const d = await discover();
        // The resource is THIS proxy; the authorization server is too. The
        // provider's real scopes list rides along untouched.
        const base: Record<string, unknown> = d?.prm ?? {};
        return sendJson(res, 200, {
          ...base,
          resource: `${origin}${upstream.pathname}`,
          authorization_servers: [origin],
        });
      }
      if (
        req.method === "GET" &&
        (path.startsWith("/.well-known/oauth-authorization-server") || path.startsWith("/.well-known/openid-configuration"))
      ) {
        const d = await discover();
        if (!d) return sendJson(res, 502, { error: "upstream_discovery_failed" });
        const meta = { ...d.asMetadata };
        // The proxy presents itself as the authorization server, consistently.
        // Both halves are forced:
        //   - discovery requires this issuer to equal the entry codex followed
        //     from the protected-resource document (which is this origin), and
        //   - the callback requires the issuer reported THERE to equal it too.
        // Claiming the provider's identity satisfies the second and breaks the
        // first; claiming ours and leaving authorize with the provider breaks
        // the second, because the provider names itself in the callback. So
        // the whole authorization leg is proxied and the identity stays ours
        // end to end. The user still consents at the real provider — /authorize
        // below is a redirect, not a login page.
        meta.issuer = origin;
        meta.authorization_endpoint = `${origin}/authorize`;
        meta.token_endpoint = `${origin}/token`;
        // No dynamic registration through the proxy: the client is the one
        // configured, full stop. Advertising the provider's registrar here
        // would invite the engine to mint a client the secret does not match.
        delete meta.registration_endpoint;
        return sendJson(res, 200, meta);
      }

      // ── Authorization leg, proxied ──────────────────────────────────
      // codex sends the browser here; we forward it to the provider with our
      // own loopback callback substituted, then hand the result back to codex
      // under our identity. Loopback redirect URIs with any port and path are
      // exactly what a provider's "desktop/native client" type permits, which
      // is what makes this legal rather than a trick.
      if (req.method === "GET" && path === "/authorize") {
        const d = await discover();
        const upstreamAuthorize = typeof d?.asMetadata.authorization_endpoint === "string" ? d.asMetadata.authorization_endpoint : null;
        if (!upstreamAuthorize) return sendJson(res, 502, { error: "upstream_discovery_failed" });
        const incoming = new URL(req.url ?? "/", origin);
        const state = incoming.searchParams.get("state") ?? "";
        const codexRedirect = incoming.searchParams.get("redirect_uri");
        if (codexRedirect) pendingRedirects.set(state, { redirectUri: codexRedirect, at: Date.now() });
        prunePending();
        const out = new URL(upstreamAuthorize);
        incoming.searchParams.forEach((v, k) => out.searchParams.set(k, v));
        // Everything else — scope, PKCE challenge, state, prompt — rides
        // through untouched; only where the provider sends the code changes.
        out.searchParams.set("redirect_uri", `${origin}/oauth/callback`);
        res.writeHead(302, { location: out.toString() });
        return res.end();
      }
      if (req.method === "GET" && path === "/oauth/callback") {
        const incoming = new URL(req.url ?? "/", origin);
        const state = incoming.searchParams.get("state") ?? "";
        const pending = pendingRedirects.get(state) ?? lastPending();
        if (!pending) {
          res.writeHead(400, { "content-type": "text/plain" });
          return res.end("This sign-in did not start here, or it expired. Start it again from the app.");
        }
        pendingRedirects.delete(state);
        const out = new URL(pending.redirectUri);
        incoming.searchParams.forEach((v, k) => out.searchParams.set(k, v));
        // RFC 9207: the client checks who issued the code. We ran the leg, so
        // we name ourselves — matching the issuer advertised in discovery.
        out.searchParams.set("iss", origin);
        log(incoming.searchParams.has("error") ? `authorize returned ${incoming.searchParams.get("error")}` : "authorize ok");
        res.writeHead(302, { location: out.toString() });
        return res.end();
      }

      // ── Token exchange, secret injected ─────────────────────────────
      if (req.method === "POST" && path === "/token") {
        const d = await discover();
        if (!d) return sendJson(res, 502, { error: "upstream_discovery_failed" });
        const raw = (await readBody(req)).toString("utf8");
        const form = new URLSearchParams(raw);
        const grant = form.get("grant_type") ?? "(none)";
        form.set("client_id", connector.clientId);
        form.set("client_secret", connector.clientSecret);
        // The provider matches this against the URI the code was issued to,
        // which was OURS — codex would otherwise send its own and be refused.
        if (form.has("redirect_uri")) form.set("redirect_uri", `${origin}/oauth/callback`);
        try {
          const upstreamRes = await f(d.tokenEndpoint, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
            body: form.toString(),
            signal: AbortSignal.timeout(20_000),
          });
          const body = Buffer.from(await upstreamRes.arrayBuffer());
          // The provider's own words on failure are the only thing that ever
          // localises these bugs; success stays a one-liner.
          log(
            upstreamRes.ok
              ? `token exchange ok (${grant})`
              : `token exchange ${upstreamRes.status} (${grant}): ${body.toString("utf8").slice(0, 300)}`,
          );
          res.writeHead(upstreamRes.status, {
            "content-type": upstreamRes.headers.get("content-type") ?? "application/json",
            "content-length": body.length,
          });
          return res.end(body);
        } catch {
          return sendJson(res, 502, { error: "token_exchange_unreachable" });
        }
      }

      // ── Everything else: transparent MCP pass-through ───────────────
      try {
        const target = `${upstream.origin}${path}${(req.url ?? "").includes("?") ? "?" + (req.url ?? "").split("?")[1] : ""}`;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v !== "string") continue;
          // Hop-by-hop and host headers are the proxy's own business.
          if (["host", "connection", "content-length", "transfer-encoding"].includes(k)) continue;
          headers[k] = v;
        }
        const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
        const upstreamRes = await f(target, {
          method: req.method,
          headers,
          body: body && body.length ? new Uint8Array(body) : undefined,
          signal: AbortSignal.timeout(120_000),
        });
        const outHeaders: Record<string, string> = {};
        upstreamRes.headers.forEach((v, k) => {
          if (["content-length", "transfer-encoding", "connection", "content-encoding"].includes(k)) return;
          outHeaders[k] = v;
        });
        res.writeHead(upstreamRes.status, outHeaders);
        if (!upstreamRes.body) return res.end();
        // Streamed, not buffered: MCP's streamable-HTTP responses are SSE,
        // and buffering one would hold the connection open forever.
        const reader = upstreamRes.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        return res.end();
      } catch {
        if (!res.headersSent) sendJson(res, 502, { error: "upstream_unreachable" });
        else res.end();
      }
    })().catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: "proxy_internal" });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const bound = server.address();
  if (bound && typeof bound === "object") origin = `http://127.0.0.1:${bound.port}`;
  return server;
}
