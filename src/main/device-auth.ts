/**
 * The client half of the platform's RFC 8628 device authorization flow
 * (unbiased-platform docs/partner-device-flow.md). The app is a PUBLIC OAuth
 * client: it presents a registered client_id, receives a device_code (its own
 * handle) and a user_code (what the person confirms in the browser), then polls
 * the token endpoint until the person approves — at which point the platform
 * mints an API key and returns it exactly once.
 *
 * Pure transport, no Electron: fetch and sleep are injectable so the polling
 * discipline can be tested without a server.
 */

export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
/** RFC 8628 §3.5: on slow_down the client MUST add 5 seconds to its interval. */
const SLOW_DOWN_INCREMENT_SECONDS = 5;

export type DeviceGrant = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
};

export type DeviceTokenResult =
  | {
      ok: true;
      accessToken: string;
      organizationId: string;
      workloadId: string;
      workloadName: string;
      keyName: string;
    }
  | { ok: false; error: string; code: string };

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type DeviceAuthDeps = {
  fetch?: Fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(t);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** The RFC default encoding; also what the platform's own examples use. */
async function postForm(
  fetchImpl: Fetch,
  url: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  return fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params).toString(),
    signal,
  });
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body = (await res.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Step 1: ask the platform for the codes. `deviceName` is display-only on the
 *  platform side (it seeds the workload name when the person picks "new"). */
export async function requestDeviceAuthorization(
  opts: { baseUrl: string; clientId: string; deviceName: string | null; signal?: AbortSignal },
  deps: DeviceAuthDeps = {},
): Promise<{ ok: true; grant: DeviceGrant } | { ok: false; error: string; code: string }> {
  const fetchImpl = deps.fetch ?? fetch;
  let res: Response;
  try {
    res = await postForm(
      fetchImpl,
      `${opts.baseUrl}/api/oauth/device_authorization`,
      { client_id: opts.clientId, ...(opts.deviceName ? { device_name: opts.deviceName } : {}) },
      opts.signal,
    );
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") return { ok: false, error: "Canceled.", code: "canceled" };
    return { ok: false, error: "Couldn't reach the platform.", code: "network" };
  }
  const body = await readJson(res);
  if (!res.ok || !body) {
    const code = typeof body?.error === "string" ? body.error : `http_${res.status}`;
    return { ok: false, error: describeStartError(code, res.status, body), code };
  }
  const verificationUri = String(body.verification_uri ?? "");
  const complete = String(body.verification_uri_complete ?? "");
  const grant: DeviceGrant = {
    deviceCode: String(body.device_code ?? ""),
    userCode: String(body.user_code ?? ""),
    verificationUri,
    // These URLs are handed to the OS to open, so only http(s) is accepted;
    // a prefill URL that fails the check degrades to the plain page.
    verificationUriComplete: /^https?:\/\//.test(complete) ? complete : verificationUri,
    expiresIn: Number(body.expires_in) || 600,
    interval: Number(body.interval) || 5,
  };
  if (!grant.deviceCode || !grant.userCode || !/^https?:\/\//.test(verificationUri)) {
    return { ok: false, error: "The platform sent an incomplete response.", code: "bad_response" };
  }
  return { ok: true, grant };
}

function describeStartError(code: string, status: number, body: Record<string, unknown> | null): string {
  switch (code) {
    case "invalid_client":
      return "This build of Unbiased isn't registered for browser sign-in.";
    case "temporarily_unavailable":
      return status === 429
        ? "Too many sign-in attempts from this network — wait a minute and try again."
        : "Browser sign-in is temporarily unavailable — try again shortly.";
    default:
      return typeof body?.error_description === "string"
        ? body.error_description
        : `Couldn't start sign-in (HTTP ${status}).`;
  }
}

/**
 * Step 2: poll until the person approves or the code dies. Sleeps `interval`
 * FIRST — polling on arrival is the RFC's textbook slow_down.
 *
 * Every poll is sent exactly once. A poll of an already-redeemed code REVOKES
 * the key the platform issued (it cannot tell a lost response from a retry),
 * so a transport failure ends the flow instead of being retried: the person
 * restarts and the platform mints afresh. Cheaper than an unseen live key.
 */
export async function pollDeviceToken(
  opts: {
    baseUrl: string;
    clientId: string;
    grant: Pick<DeviceGrant, "deviceCode" | "interval" | "expiresIn">;
    signal?: AbortSignal;
  },
  deps: DeviceAuthDeps = {},
): Promise<DeviceTokenResult> {
  const fetchImpl = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const { signal } = opts;
  const canceled = { ok: false as const, error: "Sign-in canceled.", code: "canceled" };
  const expired = {
    ok: false as const,
    error: "The sign-in code expired before it was confirmed — start again.",
    code: "expired_token",
  };
  let interval = Math.max(1, opts.grant.interval);
  let elapsed = 0;

  for (;;) {
    await sleep(interval * 1000, signal);
    if (signal?.aborted) return canceled;
    elapsed += interval;
    if (elapsed > opts.grant.expiresIn) return expired;

    let res: Response;
    try {
      res = await postForm(
        fetchImpl,
        `${opts.baseUrl}/api/oauth/token`,
        { grant_type: DEVICE_GRANT_TYPE, device_code: opts.grant.deviceCode, client_id: opts.clientId },
        signal,
      );
    } catch (err) {
      if (signal?.aborted || (err as { name?: string })?.name === "AbortError") return canceled;
      return { ok: false, error: "Lost the connection while waiting — start sign-in again.", code: "network" };
    }
    const body = await readJson(res);

    if (res.ok) {
      const token = typeof body?.access_token === "string" ? body.access_token.trim() : "";
      if (!token) return { ok: false, error: "The platform sent an incomplete response.", code: "bad_response" };
      return {
        ok: true,
        accessToken: token,
        organizationId: String(body?.organization_id ?? ""),
        workloadId: String(body?.workload_id ?? ""),
        workloadName: String(body?.workload_name ?? ""),
        keyName: String(body?.key_name ?? ""),
      };
    }

    const code = typeof body?.error === "string" ? body.error : `http_${res.status}`;
    switch (code) {
      case "authorization_pending":
        continue;
      case "slow_down":
        // Both the per-code ratchet (400) and the per-IP limiter (429): back off.
        interval += SLOW_DOWN_INCREMENT_SECONDS;
        continue;
      case "temporarily_unavailable":
        // The request never reached the grant, so no key can have been issued;
        // polling on is safe. Bounded by expiresIn like every other poll.
        continue;
      case "access_denied":
        return { ok: false, error: "Sign-in was declined in the browser.", code };
      case "expired_token":
        return expired;
      default:
        return {
          ok: false,
          error:
            typeof body?.error_description === "string"
              ? `${body.error_description} (${code})`
              : `Sign-in failed (${code}).`,
          code,
        };
    }
  }
}
