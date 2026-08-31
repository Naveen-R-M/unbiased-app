/**
 * The remote connector catalogue.
 *
 * Adding a connector used to mean an app release: the list was derived from the
 * plugin manifests bundled inside the engine and filtered by hardcoded maps.
 * It now comes from circuitandchisel/unbiased-connectors, so a connector ships
 * by merging a pull request there.
 *
 * This payload decides where a sign-in goes and which OAuth client identity is
 * used, so it is treated as hostile until proven otherwise: https only, size
 * capped, strictly parsed, and above all ed25519-verified against a public key
 * compiled in below. Anything short of that keeps the previous copy — a bad or
 * tampered publish degrades to yesterday's catalogue, never to an attacker's.
 *
 * No network in this module: fetch and clock are injected so the whole policy
 * is testable (npm test).
 */
import { createPublicKey, verify } from "node:crypto";

/** The published payload's shape version. A payload declaring anything else is
 *  declined rather than guessed at — an old app keeps its fallback instead of
 *  misreading a future format. */
export const CATALOGUE_SCHEMA = 1;

/**
 * Signing key for the catalogue, from unbiased-connectors. Rotating it strands
 * installed apps on their bundled fallback until they update, which is why the
 * repo treats keygen as a one-time act.
 */
export const CATALOGUE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAx0p2lW2s2PuiHXD0dMyqFqg9/3+ZV5bXnkTCPNiKNLk=
-----END PUBLIC KEY-----
`;

/**
 * Where to look, in order.
 *
 * GitHub raw leads because that is what is actually serving today;
 * connectors.unbiased.ai is listed second and ready for the moment Pages and
 * DNS are set up, at which point the two swap. Trying a host that does not
 * resolve costs a DNS failure per refresh, which is why the live one goes
 * first rather than the aspirational one.
 *
 * Neither host is trusted: the signature is what is checked, so a second
 * source costs nothing in safety and buys uptime. An override replaces both
 * (used by the local end-to-end test).
 */
export const CATALOGUE_URLS: string[] = process.env.UNBIASED_CATALOGUE_URL?.trim()
  ? [process.env.UNBIASED_CATALOGUE_URL.trim()]
  : [
      "https://raw.githubusercontent.com/circuitandchisel/unbiased-connectors/main/dist/catalogue.json",
      "https://connectors.unbiased.ai/catalogue.json",
    ];

const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type CatalogueEntry = {
  name: string;
  url: string;
  displayName: string;
  description: string;
  longDescription: string;
  category: string;
  developer: string | null;
  brandColor: string | null;
  websiteUrl: string | null;
  privacyUrl: string | null;
  termsUrl: string | null
  supportUrl: string | null;
  capabilities: string[];
  prompts: string[];
  scopes: string[];
  icon: string | null;
  requiresClientId: boolean;
  requiresSecret: boolean;
  /** Present = documented but not offered, with the reason. */
  unavailable: string | null;
};

export type Catalogue = { schema: number; connectors: CatalogueEntry[]; etag: string | null; fetchedAt: string };

const str = (v: unknown, max = 4000): string | null =>
  typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null;
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length <= 4000).slice(0, 32) : [];

/** https, or loopback for a developer pointing at a local build. */
function safeUrl(raw: unknown): string | null {
  const s = str(raw, 2048);
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1";
  if (u.protocol !== "https:" && !loopback) return null;
  return u.toString();
}

/** A data: image, or nothing. A remote URL would be blocked by the renderer's
 *  CSP anyway, and following one would leak which connectors a user browses. */
function safeIcon(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s || s.length > 512 * 1024) return null;
  return /^data:image\/(png|jpeg|svg\+xml|webp);base64,[A-Za-z0-9+/=]+$/.test(s) ? s : null;
}

/** Strict parse. An entry that fails is dropped, not repaired: a malformed
 *  connector is one nobody can connect, and guessing at its url is exactly the
 *  mistake that would send someone's credentials somewhere unintended. */
export function parseCatalogue(text: string, etag: string | null, now: string): Catalogue | null {
  if (text.length > MAX_PAYLOAD_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const body = raw as { schema?: unknown; connectors?: unknown };
  if (body.schema !== CATALOGUE_SCHEMA) return null;
  if (!Array.isArray(body.connectors)) return null;
  const connectors: CatalogueEntry[] = [];
  const seen = new Set<string>();
  for (const item of body.connectors) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const name = str(c.name, 64);
    const url = safeUrl(c.url);
    if (!name || !NAME_RE.test(name) || !url || seen.has(name)) continue;
    seen.add(name);
    const requiresClientId = c.requiresClientId === true || c.requiresSecret === true;
    connectors.push({
      name,
      url,
      displayName: str(c.displayName, 120) ?? name,
      description: str(c.description) ?? "",
      longDescription: str(c.longDescription) ?? "",
      category: str(c.category, 60) ?? "Other",
      developer: str(c.developer, 120),
      brandColor: str(c.brandColor, 32),
      websiteUrl: safeUrl(c.websiteUrl),
      privacyUrl: safeUrl(c.privacyUrl),
      termsUrl: safeUrl(c.termsUrl),
      supportUrl: safeUrl(c.supportUrl),
      capabilities: list(c.capabilities),
      prompts: list(c.prompts),
      scopes: list(c.scopes),
      icon: safeIcon(c.icon),
      requiresClientId,
      requiresSecret: c.requiresSecret === true,
      unavailable: str(c.unavailable, 400),
    });
  }
  if (!connectors.length) return null; // an empty catalogue is a broken publish
  return { schema: CATALOGUE_SCHEMA, connectors, etag, fetchedAt: now };
}

export function verifyCatalogue(text: string, signatureB64: string, publicKeyPem = CATALOGUE_PUBLIC_KEY): boolean {
  try {
    const sig = Buffer.from(signatureB64.trim(), "base64");
    if (!sig.length) return false;
    return verify(null, Buffer.from(text, "utf8"), createPublicKey(publicKeyPem), sig);
  } catch {
    return false;
  }
}

export type FetchDeps = {
  fetch?: typeof fetch;
  now?: () => string;
  url?: string;
  timeoutMs?: number;
};

export type FetchResult =
  | { ok: true; catalogue: Catalogue }
  | { ok: false; reason: "unchanged" | "offline" | "bad-signature" | "bad-payload" | "http" };

/**
 * Fetch the payload and its detached signature, verify, parse.
 *
 * `unchanged` (HTTP 304) is a success from the caller's point of view: the
 * cached copy is current. Every other failure is a reason to keep what we have.
 */
/**
 * Try each host in turn. `unchanged` ends the walk — the cache is current, and
 * asking a second host the same question would only waste a round trip.
 */
export async function fetchCatalogueFromAnyHost(etag: string | null, deps: FetchDeps = {}): Promise<FetchResult> {
  const urls = deps.url ? [deps.url] : CATALOGUE_URLS;
  let last: FetchResult = { ok: false, reason: "offline" };
  for (const url of urls) {
    const res = await fetchCatalogue(etag, { ...deps, url });
    if (res.ok || res.reason === "unchanged") return res;
    last = res;
  }
  return last;
}

export async function fetchCatalogue(etag: string | null, deps: FetchDeps = {}): Promise<FetchResult> {
  const f = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date().toISOString());
  const base = deps.url ?? CATALOGUE_URLS[0];
  const timeout = deps.timeoutMs ?? 10_000;
  try {
    const res = await f(base, {
      headers: { accept: "application/json", ...(etag ? { "if-none-match": etag } : {}) },
      signal: AbortSignal.timeout(timeout),
    });
    if (res.status === 304) return { ok: false, reason: "unchanged" };
    if (!res.ok) return { ok: false, reason: "http" };
    const text = await res.text();
    // The signature is a sibling of whatever URL the payload came from, so a
    // developer override points both at the same place.
    const sigRes = await f(`${base}.sig`, { signal: AbortSignal.timeout(timeout) });
    if (!sigRes.ok) return { ok: false, reason: "bad-signature" };
    const sig = await sigRes.text();
    // Verify BEFORE parsing: the bytes are the signed artefact, and parsing
    // unverified input is work done on an attacker's behalf.
    if (!verifyCatalogue(text, sig)) return { ok: false, reason: "bad-signature" };
    const parsed = parseCatalogue(text, res.headers.get("etag"), now());
    return parsed ? { ok: true, catalogue: parsed } : { ok: false, reason: "bad-payload" };
  } catch {
    return { ok: false, reason: "offline" };
  }
}
