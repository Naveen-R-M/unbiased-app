import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { startSecretProxy, secretProxyPort, SECRET_PROXY_PORTS } from "./oauth-proxy";

/** A fake Google: PRM, AS metadata, a token endpoint that DEMANDS the secret,
 *  and an MCP endpoint that records what reaches it. */
function fakeProvider(): Promise<{ server: Server; origin: string; seen: Record<string, unknown>[] }> {
  const seen: Record<string, unknown>[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const path = (req.url ?? "").split("?")[0];
        const json = (code: number, o: unknown) => {
          res.writeHead(code, { "content-type": "application/json" });
          res.end(JSON.stringify(o));
        };
        seen.push({ path, method: req.method, body, auth: req.headers.authorization ?? null });
        if (path.startsWith("/.well-known/oauth-protected-resource"))
          return json(200, { resource: `${origin}/mcp/v1`, authorization_servers: [origin], scopes_supported: ["https://mail.google.com/"] });
        if (path.startsWith("/.well-known/oauth-authorization-server") || path.startsWith("/.well-known/openid-configuration"))
          return json(200, {
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            registration_endpoint: `${origin}/register`,
            code_challenge_methods_supported: ["S256"],
          });
        if (path === "/authorize") {
          const q = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
          res.writeHead(302, { location: `${q.get("redirect_uri")}?code=FAKECODE&state=${encodeURIComponent(q.get("state") ?? "")}` });
          return res.end();
        }
        if (path === "/token") {
          const form = new URLSearchParams(body);
          if (!form.get("client_secret")) return json(400, { error: "invalid_request", error_description: "client_secret is missing." });
          return json(200, { access_token: "AT-ok", refresh_token: "RT-ok", token_type: "Bearer", expires_in: 3600 });
        }
        if (path === "/mcp/v1") return json(200, { jsonrpc: "2.0", id: 1, result: { echoedAuth: req.headers.authorization ?? null } });
        json(404, {});
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve({ server, origin, seen });
    });
  });
}

test("fixed ports for the google trio, stable fallback elsewhere", () => {
  assert.equal(SECRET_PROXY_PORTS.gmail, 45991);
  assert.equal(secretProxyPort("gmail"), 45991);
  const p = secretProxyPort("some-future-thing");
  assert.ok(p >= 45900 && p < 45980);
  assert.equal(p, secretProxyPort("some-future-thing"), "fallback port must be stable");
});

test("discovery rewritten, authorize left real, registration stripped", async () => {
  const fake = await fakeProvider();
  const proxy = await startSecretProxy({ name: "gmail", upstreamUrl: `${fake.origin}/mcp/v1`, clientId: "id-1", clientSecret: "sec-1" }, { port: 0 });
  const origin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  try {
    const prm = (await (await fetch(`${origin}/.well-known/oauth-protected-resource/mcp/v1`)).json()) as Record<string, unknown>;
    assert.equal(prm.resource, `${origin}/mcp/v1`);
    assert.deepEqual(prm.authorization_servers, [origin]);
    assert.deepEqual(prm.scopes_supported, ["https://mail.google.com/"], "provider scopes must ride along");
    const meta = (await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    // The proxy is the authorization server as far as the client is concerned,
    // consistently across discovery and callback.
    assert.equal(meta.issuer, origin);
    assert.equal(meta.authorization_endpoint, `${origin}/authorize`, "the authorize leg is proxied too");
    assert.equal(meta.token_endpoint, `${origin}/token`, "token endpoint must land on the proxy");
    assert.equal(meta.registration_endpoint, undefined, "no DCR through the proxy");
  } finally {
    proxy.close();
    fake.server.close();
  }
});

test("token exchange gets the secret injected; refresh too", async () => {
  const fake = await fakeProvider();
  const proxy = await startSecretProxy({ name: "google-drive", upstreamUrl: `${fake.origin}/mcp/v1`, clientId: "id-2", clientSecret: "sec-2" }, { port: 0 });
  const origin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  try {
    for (const grant of ["authorization_code", "refresh_token"]) {
      const res = await fetch(`${origin}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        // exactly what the engine sends: no secret
        body: new URLSearchParams({ grant_type: grant, code: "c", client_id: "id-2" }).toString(),
      });
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(res.status, 200, `${grant}: ${JSON.stringify(body)}`);
      assert.equal(body.access_token, "AT-ok");
    }
    const tokenCalls = fake.seen.filter((s) => s.path === "/token");
    assert.equal(tokenCalls.length, 2);
    for (const c of tokenCalls) {
      const form = new URLSearchParams(String(c.body));
      assert.equal(form.get("client_secret"), "sec-2", "secret must reach the provider");
      assert.equal(form.get("client_id"), "id-2");
    }
  } finally {
    proxy.close();
    fake.server.close();
  }
});

test("MCP traffic passes through with auth intact", async () => {
  const fake = await fakeProvider();
  const proxy = await startSecretProxy({ name: "google-calendar", upstreamUrl: `${fake.origin}/mcp/v1`, clientId: "id-3", clientSecret: "sec-3" }, { port: 0 });
  const origin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  try {
    const res = await fetch(`${origin}/mcp/v1`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-123" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    const body = (await res.json()) as { result?: { echoedAuth?: string } };
    assert.equal(res.status, 200);
    assert.equal(body.result?.echoedAuth, "Bearer tok-123", "bearer must reach the upstream untouched");
  } finally {
    proxy.close();
    fake.server.close();
  }
});

test("the authorization leg swaps the callback and restores it under our identity", async () => {
  const fake = await fakeProvider();
  const proxy = await startSecretProxy(
    { name: "gmail", upstreamUrl: `${fake.origin}/mcp/v1`, clientId: "id-4", clientSecret: "sec-4" },
    { port: 0 },
  );
  const origin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  try {
    const codexCallback = "http://127.0.0.1:45999/callback/abc123";
    const q = new URLSearchParams({
      client_id: "id-4",
      redirect_uri: codexCallback,
      state: "STATE-1",
      code_challenge: "CHAL",
      code_challenge_method: "S256",
      scope: "https://mail.google.com/",
      response_type: "code",
    });
    // 1. codex opens /authorize on the proxy
    const first = await fetch(`${origin}/authorize?${q}`, { redirect: "manual" });
    assert.equal(first.status, 302);
    const toProvider = new URL(first.headers.get("location")!);
    assert.equal(toProvider.origin, fake.origin, "the person still consents at the provider");
    assert.equal(toProvider.searchParams.get("redirect_uri"), `${origin}/oauth/callback`, "our callback is substituted");
    for (const keep of ["state", "code_challenge", "code_challenge_method", "scope"])
      assert.equal(toProvider.searchParams.get(keep), q.get(keep), `${keep} must survive untouched`);

    // 2. the provider sends the browser back to the proxy
    const back = await fetch(toProvider.toString(), { redirect: "manual" });
    const toProxy = new URL(back.headers.get("location")!);
    assert.equal(toProxy.origin, origin);
    const second = await fetch(toProxy.toString(), { redirect: "manual" });
    assert.equal(second.status, 302);

    // 3. …and the proxy hands it to codex, naming ITSELF as the issuer
    const toCodex = new URL(second.headers.get("location")!);
    assert.equal(toCodex.origin + toCodex.pathname, codexCallback);
    assert.equal(toCodex.searchParams.get("code"), "FAKECODE");
    assert.equal(toCodex.searchParams.get("state"), "STATE-1");
    assert.equal(toCodex.searchParams.get("iss"), origin, "issuer must match what discovery advertised");

    // 4. the exchange rewrites redirect_uri to the one the code was issued to
    const tok = await fetch(`${origin}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: "FAKECODE", redirect_uri: codexCallback }).toString(),
    });
    assert.equal(tok.status, 200);
    const sentForm = new URLSearchParams(String(fake.seen.find((x) => x.path === "/token")!.body));
    assert.equal(sentForm.get("redirect_uri"), `${origin}/oauth/callback`);
    assert.equal(sentForm.get("client_secret"), "sec-4");
  } finally {
    proxy.close();
    fake.server.close();
  }
});
