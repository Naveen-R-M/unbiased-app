import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  isAcceptableSuccessor,
  CATALOGUE_PUBLIC_KEY,
  CATALOGUE_SCHEMA,
  CATALOGUE_URLS,
  fetchCatalogue,
  fetchCatalogueFromAnyHost,
  parseCatalogue,
  verifyCatalogue,
} from "./connector-catalogue";

const NOW = "2026-08-31T00:00:00.000Z";
const REPO = "/Users/naveen/Projects/Work/unbiased-connectors";
const entry = (over: Record<string, unknown> = {}) => ({ name: "linear", url: "https://mcp.linear.app/mcp", ...over });
const PUBLISHED = "2026-08-30T00:00:00.000Z";
const payload = (connectors: unknown[], schema = CATALOGUE_SCHEMA, publishedAt: unknown = PUBLISHED) =>
  JSON.stringify({ schema, publishedAt, connectors });

test("the real published catalogue verifies against the key baked into the app", () => {
  // The end-to-end contract between the two repos. If this fails, either the
  // key was rotated without updating the app or dist was not rebuilt.
  let text: string, sig: string;
  try {
    text = readFileSync(`${REPO}/dist/catalogue.json`, "utf8").trim();
    sig = readFileSync(`${REPO}/dist/catalogue.json.sig`, "utf8").trim();
  } catch {
    return; // the sibling checkout is not present; the rest of the suite stands alone
  }
  assert.ok(verifyCatalogue(text, sig), "published payload must verify with CATALOGUE_PUBLIC_KEY");
  const parsed = parseCatalogue(text, null, NOW);
  assert.ok(parsed, "published payload must parse");
  const offered = parsed!.connectors.filter((c) => !c.unavailable);
  assert.ok(offered.length >= 15, `expected the offered set, got ${offered.length}`);
  const slack = parsed!.connectors.find((c) => c.name === "slack");
  assert.equal(slack?.requiresClientId, true, "slack must still declare bring-your-own");
  assert.ok(
    parsed!.connectors.find((c) => c.name === "gmail")?.unavailable,
    "gmail must remain withheld, with its reason",
  );
});

test("a tampered payload does not verify", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const text = payload([entry()]);
  const sig = sign(null, Buffer.from(text), privateKey).toString("base64");
  // signed with the WRONG key
  assert.equal(verifyCatalogue(text, sig), false);
  // right key, but the bytes changed after signing
  assert.equal(verifyCatalogue(text.replace("linear", "linear2"), sig), false);
  assert.equal(verifyCatalogue(text, ""), false, "an empty signature is not a signature");
  assert.equal(verifyCatalogue(text, "not base64 %%%"), false);
});

test("a future schema is declined rather than guessed at", () => {
  assert.equal(parseCatalogue(payload([entry()], 999), null, NOW), null);
});

test("http urls are refused — they would let the network redirect a sign-in", () => {
  assert.equal(parseCatalogue(payload([entry({ url: "http://mcp.linear.app/mcp" })]), null, NOW), null);
});

test("loopback is allowed, for pointing at a local build", () => {
  const c = parseCatalogue(payload([entry({ url: "http://127.0.0.1:8080/mcp" })]), null, NOW);
  assert.equal(c?.connectors.length, 1);
});

test("a malformed entry is dropped, not repaired, and the rest survive", () => {
  const c = parseCatalogue(
    payload([entry({ name: "bad name with spaces" }), entry({ name: "no-url", url: 42 }), entry({ name: "good" })]),
    null,
    NOW,
  );
  assert.deepEqual(c?.connectors.map((x) => x.name), ["good"]);
});

test("duplicates keep the first, so a later entry cannot redirect an earlier one", () => {
  const c = parseCatalogue(
    payload([entry({ url: "https://real.example/mcp" }), entry({ url: "https://evil.example/mcp" })]),
    null,
    NOW,
  );
  assert.equal(c?.connectors.length, 1);
  assert.equal(c?.connectors[0].url, "https://real.example/mcp");
});

test("only data: icons survive; a remote one is dropped", () => {
  const good = "data:image/png;base64,iVBORw0KGgo=";
  const c = parseCatalogue(payload([entry({ icon: good }), entry({ name: "b", icon: "https://x.example/i.png" })]), null, NOW);
  assert.equal(c?.connectors[0].icon, good);
  assert.equal(c?.connectors[1].icon, null);
});

test("requiresSecret implies requiresClientId, whatever the payload says", () => {
  const c = parseCatalogue(payload([entry({ requiresSecret: true })]), null, NOW);
  assert.equal(c?.connectors[0].requiresClientId, true);
});

test("an empty catalogue reads as a broken publish, not as 'no connectors'", () => {
  assert.equal(parseCatalogue(payload([]), null, NOW), null);
});

/** A fake origin serving a payload signed with the app's real key is not
 *  possible in a test, so the fetch tests inject their own key via a payload
 *  signed by the real one being absent — they assert on POLICY, i.e. which
 *  failures are reported. */
function fakeFetch(routes: Record<string, { status?: number; body?: string; etag?: string }>): typeof fetch {
  return (async (url: string | URL) => {
    const r = routes[String(url)];
    if (!r) return new Response("nope", { status: 404 });
    const status = r.status ?? 200;
    // 204/304 are null-body statuses: constructing one WITH a body throws,
    // which is how this fake first reported "offline" for a valid 304.
    const nullBody = status === 204 || status === 304;
    return new Response(nullBody ? null : r.body ?? "", {
      status,
      headers: r.etag ? { etag: r.etag } : undefined,
    });
  }) as unknown as typeof fetch;
}

test("304 reports 'unchanged' — the cache is current, not broken", async () => {
  const res = await fetchCatalogue('"abc"', {
    url: "https://x.example/c.json",
    fetch: fakeFetch({ "https://x.example/c.json": { status: 304 } }),
  });
  assert.deepEqual(res, { ok: false, reason: "unchanged" });
});

test("a missing or wrong signature is reported as bad-signature, never accepted", async () => {
  const text = payload([entry()]);
  for (const sigRoute of [{ status: 404 }, { body: "AAAA" }]) {
    const res = await fetchCatalogue(null, {
      url: "https://x.example/c.json",
      fetch: fakeFetch({ "https://x.example/c.json": { body: text }, "https://x.example/c.json.sig": sigRoute }),
    });
    assert.deepEqual(res, { ok: false, reason: "bad-signature" });
  }
});

test("a network failure is 'offline', so the caller keeps its cache", async () => {
  const res = await fetchCatalogue(null, {
    url: "https://x.example/c.json",
    fetch: (() => Promise.reject(new Error("ENOTFOUND"))) as unknown as typeof fetch,
  });
  assert.deepEqual(res, { ok: false, reason: "offline" });
});

test("the baked-in key is a real ed25519 public key", () => {
  assert.match(CATALOGUE_PUBLIC_KEY, /^-----BEGIN PUBLIC KEY-----/);
  assert.equal(verifyCatalogue("x", "AAAA", CATALOGUE_PUBLIC_KEY), false); // exercises the parse path
});

test("the published hosts are https, with the CDN leading and raw as fallback", () => {
  assert.ok(CATALOGUE_URLS.length >= 2, "keep a fallback host");
  for (const u of CATALOGUE_URLS) assert.match(u, /^https:\/\//);
  assert.match(CATALOGUE_URLS[0], /^https:\/\/connectors\.unbiased\.ai\//);
  assert.ok(
    CATALOGUE_URLS.some((u) => u.startsWith("https://raw.githubusercontent.com/")),
    "keep raw as the fallback: same signed bytes, different host",
  );
});

test("a dead primary host falls through to the fallback", async () => {
  const asked: string[] = [];
  const res = await fetchCatalogueFromAnyHost(null, {
    fetch: (async (url: string | URL) => {
      asked.push(String(url));
      // primary is down; fallback serves an unsigned payload, which must still
      // be refused — the point here is only that the walk continued.
      if (String(url).includes("connectors.unbiased.ai")) throw new Error("ENOTFOUND");
      return new Response(JSON.stringify({ schema: CATALOGUE_SCHEMA, connectors: [] }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  assert.ok(asked.some((u) => u.includes("raw.githubusercontent.com")), "must try the fallback host");
  assert.equal(res.ok, false);
});

test("an unchanged primary ends the walk — no pointless second request", async () => {
  const asked: string[] = [];
  const res = await fetchCatalogueFromAnyHost('"e"', {
    fetch: (async (url: string | URL) => {
      asked.push(String(url));
      return new Response(null, { status: 304 });
    }) as unknown as typeof fetch,
  });
  assert.deepEqual(res, { ok: false, reason: "unchanged" });
  assert.equal(asked.length, 1);
});

test("a payload without a usable publishedAt is refused", () => {
  // Built by hand: passing `undefined` through payload() would hit the default
  // parameter and quietly test the valid case instead.
  const missing = JSON.stringify({ schema: CATALOGUE_SCHEMA, connectors: [entry()] });
  assert.equal(parseCatalogue(missing, null, NOW), null, "missing");
  for (const bad of ["", "yesterday", 12345, null])
    assert.equal(parseCatalogue(payload([entry()], CATALOGUE_SCHEMA, bad), null, NOW), null, JSON.stringify(bad));
});

test("a wildly future timestamp is refused, so the floor cannot be pinned forever", () => {
  const future = new Date(Date.parse(NOW) + 8 * 24 * 3600_000).toISOString();
  assert.equal(parseCatalogue(payload([entry()], CATALOGUE_SCHEMA, future), null, NOW), null);
  // a few hours of clock skew is tolerated
  const skewed = new Date(Date.parse(NOW) + 3600_000).toISOString();
  assert.ok(parseCatalogue(payload([entry()], CATALOGUE_SCHEMA, skewed), null, NOW));
});

test("older payloads are rejected, same and newer accepted", () => {
  const at = (t: string) => parseCatalogue(payload([entry()], CATALOGUE_SCHEMA, t), null, NOW)!;
  const current = at("2026-08-30T00:00:00.000Z");
  assert.equal(isAcceptableSuccessor(at("2026-08-29T00:00:00.000Z"), current), false, "older must be refused");
  assert.equal(isAcceptableSuccessor(at("2026-08-30T00:00:00.000Z"), current), true, "same publish, re-fetched");
  assert.equal(isAcceptableSuccessor(at("2026-08-31T00:00:00.000Z"), current), true, "newer");
  assert.equal(isAcceptableSuccessor(at("2026-08-29T00:00:00.000Z"), null), true, "nothing cached yet");
});

/** The genuinely signed payload, so the rollback path can be reached — an
 *  unsigned fake stops at the signature check and never gets there. */
function realSigned(): { text: string; sig: string } | null {
  try {
    return {
      text: readFileSync(`${REPO}/dist/catalogue.json`, "utf8").trim(),
      sig: readFileSync(`${REPO}/dist/catalogue.json.sig`, "utf8").trim(),
    };
  } catch {
    return null;
  }
}

/** A catalogue dated after the real one, to stand in for "what we already
 *  trust" when testing that we refuse to go backwards. */
function newerThan(published: string): ReturnType<typeof parseCatalogue> {
  const later = new Date(Date.parse(published) + 60_000).toISOString();
  return parseCatalogue(payload([entry()], CATALOGUE_SCHEMA, later), null, later);
}

test("a validly signed but OLDER payload is refused as a rollback", async () => {
  const real = realSigned();
  if (!real) return; // sibling checkout absent
  const published = JSON.parse(real.text).publishedAt as string;
  const current = newerThan(published);
  const res = await fetchCatalogue(null, {
    url: "https://x.example/c.json",
    current,
    now: () => new Date(Date.parse(published) + 120_000).toISOString(),
    fetch: (async (u: string | URL) =>
      new Response(String(u).endsWith(".sig") ? real.sig : real.text, { status: 200 })) as unknown as typeof fetch,
  });
  assert.deepEqual(res, { ok: false, reason: "rollback" });
});

test("the same payload is accepted when nothing newer is cached", async () => {
  const real = realSigned();
  if (!real) return;
  const published = JSON.parse(real.text).publishedAt as string;
  const res = await fetchCatalogue(null, {
    url: "https://x.example/c.json",
    current: null,
    now: () => new Date(Date.parse(published) + 120_000).toISOString(),
    fetch: (async (u: string | URL) =>
      new Response(String(u).endsWith(".sig") ? real.sig : real.text, { status: 200 })) as unknown as typeof fetch,
  });
  assert.equal(res.ok, true, "a fresh install must accept the live catalogue");
});

test("the walk stops on a rollback instead of shopping hosts", async () => {
  const real = realSigned();
  if (!real) return;
  const published = JSON.parse(real.text).publishedAt as string;
  const asked: string[] = [];
  const res = await fetchCatalogueFromAnyHost(null, {
    current: newerThan(published),
    now: () => new Date(Date.parse(published) + 120_000).toISOString(),
    fetch: (async (u: string | URL) => {
      asked.push(String(u));
      return new Response(String(u).endsWith(".sig") ? real.sig : real.text, { status: 200 });
    }) as unknown as typeof fetch,
  });
  assert.deepEqual(res, { ok: false, reason: "rollback" });
  assert.equal(asked.filter((u) => !u.endsWith(".sig")).length, 1, `asked: ${asked.join(", ")}`);
});

test("a payload served with the trailing newline it is published with still verifies", async () => {
  // The regression that reached production: dist/catalogue.json ends with a
  // newline, the signature does not cover it, and a host that serves the file
  // faithfully would otherwise fail every verification.
  const real = realSigned();
  if (!real) return;
  const published = JSON.parse(real.text).publishedAt as string;
  const res = await fetchCatalogue(null, {
    url: "https://x.example/c.json",
    current: null,
    now: () => new Date(Date.parse(published) + 60_000).toISOString(),
    fetch: (async (u: string | URL) =>
      new Response(String(u).endsWith(".sig") ? real.sig + "\n" : real.text + "\n", { status: 200 })) as unknown as typeof fetch,
  });
  assert.equal(res.ok, true, `served-with-newline payload must verify (got ${res.ok ? "" : res.reason})`);
});

test("the cache keeps the ORIGINAL bytes, so a future build can read new fields", () => {
  // The bug this prevents: the cache used to store re-serialised parsed
  // objects, so a field the fetching build ignored was gone for good — and an
  // ETag revalidation (304) meant it was never re-fetched either.
  const text = payload([entry({ someFutureField: "kept" } as Record<string, unknown>)]);
  const parsed = parseCatalogue(text, null, NOW)!;
  assert.equal(parsed.raw, text, "raw must be the exact text parsed");
  assert.ok(parsed.raw.includes("someFutureField"), "a field this build ignores must survive in the cache");
});

test("comingSoon is read, and defaults to false", () => {
  const c = parseCatalogue(payload([entry({ comingSoon: true }), entry({ name: "b" })]), null, NOW)!;
  assert.equal(c.connectors[0].comingSoon, true);
  assert.equal(c.connectors[1].comingSoon, false);
});
