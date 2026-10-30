/**
 * Sign in with Bland from the terminal: Bland's device flow. opencontact asks
 * for a code, the owner approves it in the browser (signing up first if they
 * have no account), and the next poll hands back an API key for that org.
 * Both calls are unauthenticated by design; the browser is where the owner
 * proves who they are.
 */

export interface BrowserLogin {
  /** Secret: only ever sent back to /poll. */
  deviceCode: string;
  /** What the owner checks in the browser, like "PVT7-W7TV". */
  userCode: string;
  /** Opens the approval page with the code already filled in. */
  url: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

export type LoginOutcome = { status: "approved"; apiKey: string } | { status: "expired" };

interface Envelope<T> {
  data?: T | null;
  errors?: Array<{ error?: string; message?: string }> | null;
}

export class LoginError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "LoginError";
  }
}

async function post<T>(fetchImpl: typeof fetch, url: string, body: unknown): Promise<T> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const parsed = (await res.json().catch(() => ({}))) as Envelope<T>;
  if (!res.ok || !parsed.data) {
    const first = parsed.errors?.[0];
    throw new LoginError(res.status, first?.message ?? `${url} returned ${res.status}`);
  }
  return parsed.data;
}

export async function startBrowserLogin(apiUrl: string, fetchImpl: typeof fetch = fetch): Promise<BrowserLogin> {
  const data = await post<{
    device_code: string;
    user_code: string;
    verification_url_complete: string;
    expires_in: number;
    interval: number;
  }>(fetchImpl, `${apiUrl}/v1/agent/onboarding/start`, { client_name: "opencontact" });
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    url: data.verification_url_complete,
    expiresInSeconds: data.expires_in,
    intervalSeconds: Math.max(1, data.interval),
  };
}

/** Poll until the owner approves the code or it expires. */
export async function waitForApproval(
  apiUrl: string,
  login: BrowserLogin,
  opts: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): Promise<LoginOutcome> {
  const fetchImpl = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + login.expiresInSeconds * 1000;
  let interval = login.intervalSeconds;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    let data: { status: string; api_key?: string; interval?: number };
    try {
      data = await post(fetchImpl, `${apiUrl}/v1/agent/onboarding/poll`, { device_code: login.deviceCode });
    } catch (err) {
      // A slow network or a rate limit is not a refusal; keep waiting for the owner.
      if (err instanceof LoginError && err.status >= 400 && err.status < 500 && err.status !== 429) throw err;
      continue;
    }
    if (data.status === "approved" && data.api_key) return { status: "approved", apiKey: data.api_key };
    if (data.status === "expired") return { status: "expired" };
    if (typeof data.interval === "number" && data.interval > 0) interval = data.interval;
  }
  return { status: "expired" };
}
