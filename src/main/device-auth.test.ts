import { test } from "node:test";
import assert from "node:assert/strict";
import { DEVICE_GRANT_TYPE, pollDeviceToken, requestDeviceAuthorization } from "./device-auth";

const BASE = "https://platform.test";
const GRANT = { deviceCode: "dev-code", interval: 5, expiresIn: 600 };

/** A scripted token endpoint: each call pops the next response. Records every
 *  request body so a test can assert exactly how many polls were sent. */
function tokenServer(script: Array<{ status: number; body: unknown }>) {
  const bodies: string[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    assert.equal(url, `${BASE}/api/oauth/token`);
    bodies.push(String(init.body));
    const next = script.shift();
    if (!next) throw new Error("unexpected poll after the script ended");
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  return { fetch, sleep, bodies, sleeps };
}

const pending = { status: 400, body: { error: "authorization_pending" } };
const issued = {
  status: 200,
  body: {
    access_token: "sk_pareto_abc",
    token_type: "bearer",
    organization_id: "org1",
    workload_id: "wl1",
    workload_name: "unbiased-laptop",
    key_name: "bdj · Unbiased · 2026-08-27",
  },
};

test("polls until approved, then returns the key from the single 200", async () => {
  const s = tokenServer([pending, pending, issued]);
  const r = await pollDeviceToken({ baseUrl: BASE, clientId: "cid", grant: GRANT }, s);
  assert.deepEqual(r, {
    ok: true,
    accessToken: "sk_pareto_abc",
    organizationId: "org1",
    workloadId: "wl1",
    workloadName: "unbiased-laptop",
    keyName: "bdj · Unbiased · 2026-08-27",
  });
  assert.equal(s.bodies.length, 3);
  const params = new URLSearchParams(s.bodies[0]);
  assert.equal(params.get("grant_type"), DEVICE_GRANT_TYPE);
  assert.equal(params.get("device_code"), "dev-code");
  assert.equal(params.get("client_id"), "cid");
  // Sleeps BEFORE the first poll (polling on arrival is a textbook slow_down).
  assert.deepEqual(s.sleeps, [5000, 5000, 5000]);
});

test("slow_down adds 5s to the interval and never decays", async () => {
  const s = tokenServer([
    { status: 400, body: { error: "slow_down" } },
    pending,
    { status: 429, body: { error: "slow_down", error_description: "rate limited" } },
    issued,
  ]);
  const r = await pollDeviceToken({ baseUrl: BASE, clientId: "cid", grant: GRANT }, s);
  assert.equal(r.ok, true);
  assert.deepEqual(s.sleeps, [5000, 10000, 10000, 15000]);
});

test("temporarily_unavailable keeps polling (no grant could have been touched)", async () => {
  const s = tokenServer([{ status: 503, body: { error: "temporarily_unavailable" } }, issued]);
  const r = await pollDeviceToken({ baseUrl: BASE, clientId: "cid", grant: GRANT }, s);
  assert.equal(r.ok, true);
  assert.equal(s.bodies.length, 2);
});

for (const [error, status] of [
  ["access_denied", 400],
  ["expired_token", 400],
  ["invalid_grant", 400],
  ["invalid_client", 401],
  ["server_error", 500],
] as const) {
  test(`${error} ends the flow without another poll`, async () => {
    const s = tokenServer([pending, { status, body: { error, error_description: "why" } }]);
    const r = await pollDeviceToken({ baseUrl: BASE, clientId: "cid", grant: GRANT }, s);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, error);
    assert.equal(s.bodies.length, 2);
  });
}

test("a transport failure ends the flow rather than retrying the token endpoint", async () => {
  // A re-poll of a code the server already answered 200 to revokes the issued
  // key, so a lost response must surface as "start again", never as a retry.
  let calls = 0;
  const fetch = async (): Promise<Response> => {
    calls++;
    throw new TypeError("fetch failed");
  };
  const r = await pollDeviceToken(
    { baseUrl: BASE, clientId: "cid", grant: GRANT },
    { fetch, sleep: async () => {} },
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "network");
  assert.equal(calls, 1);
});

test("gives up once the code's lifetime has elapsed", async () => {
  const s = tokenServer(Array.from({ length: 200 }, () => pending));
  const r = await pollDeviceToken(
    { baseUrl: BASE, clientId: "cid", grant: { ...GRANT, expiresIn: 30 } },
    s,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "expired_token");
  // 6 polls fit inside 30s at 5s each; the 7th would be past expiry.
  assert.equal(s.bodies.length, 6);
});

test("cancel stops the loop without another request", async () => {
  const controller = new AbortController();
  let calls = 0;
  const fetch = async (): Promise<Response> => {
    calls++;
    controller.abort(); // the user cancels while a poll is in flight
    return new Response(JSON.stringify(pending.body), { status: 400 });
  };
  const r = await pollDeviceToken(
    { baseUrl: BASE, clientId: "cid", grant: GRANT, signal: controller.signal },
    { fetch, sleep: async () => {} },
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "canceled");
  assert.equal(calls, 1);
});

test("a 200 without an access_token is an error, not a sign-in", async () => {
  const s = tokenServer([{ status: 200, body: { token_type: "bearer" } }]);
  const r = await pollDeviceToken({ baseUrl: BASE, clientId: "cid", grant: GRANT }, s);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "bad_response");
});

test("requestDeviceAuthorization posts client_id + device_name as a form and maps the grant", async () => {
  const seen: { url?: string; body?: string; contentType?: string } = {};
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    seen.url = url;
    seen.body = String(init.body);
    seen.contentType = String((init.headers as Record<string, string>)["Content-Type"]);
    return new Response(
      JSON.stringify({
        device_code: "dc",
        user_code: "BCDF-GHJK",
        verification_uri: "https://platform.test/activate",
        verification_uri_complete: "https://platform.test/activate?user_code=BCDF-GHJK",
        expires_in: 600,
        interval: 5,
      }),
      { status: 200 },
    );
  };
  const r = await requestDeviceAuthorization(
    { baseUrl: BASE, clientId: "cid", deviceName: "bdjs MacBook" },
    { fetch },
  );
  assert.equal(seen.url, `${BASE}/api/oauth/device_authorization`);
  assert.equal(seen.contentType, "application/x-www-form-urlencoded");
  assert.equal(new URLSearchParams(seen.body).get("client_id"), "cid");
  assert.equal(new URLSearchParams(seen.body).get("device_name"), "bdjs MacBook");
  assert.deepEqual(r, {
    ok: true,
    grant: {
      deviceCode: "dc",
      userCode: "BCDF-GHJK",
      verificationUri: "https://platform.test/activate",
      verificationUriComplete: "https://platform.test/activate?user_code=BCDF-GHJK",
      expiresIn: 600,
      interval: 5,
    },
  });
});

test("requestDeviceAuthorization: an unregistered client_id reads as a build problem", async () => {
  const fetch = async (): Promise<Response> =>
    new Response(JSON.stringify({ error: "invalid_client", error_description: "unknown or disabled client_id" }), {
      status: 401,
    });
  const r = await requestDeviceAuthorization({ baseUrl: BASE, clientId: "cid", deviceName: null }, { fetch });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, "invalid_client");
    assert.match(r.error, /isn't registered/);
  }
});

test("requestDeviceAuthorization: a non-http prefill URL degrades to the plain page", async () => {
  const fetch = async (): Promise<Response> =>
    new Response(
      JSON.stringify({
        device_code: "dc",
        user_code: "BCDF-GHJK",
        verification_uri: "https://platform.test/activate",
        verification_uri_complete: "javascript:alert(1)",
      }),
      { status: 200 },
    );
  const r = await requestDeviceAuthorization({ baseUrl: BASE, clientId: "cid", deviceName: null }, { fetch });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.grant.verificationUriComplete, "https://platform.test/activate");
});
