import { describe, expect, it } from "vitest";
import { LoginError, startBrowserLogin, waitForApproval } from "../src/login.ts";

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("browser sign-in", () => {
  it("starts a device flow as opencontact and polls until the owner approves", async () => {
    const bodies: unknown[] = [];
    const answers = [
      reply(200, { data: { status: "pending", interval: 1, expires_in: 800 } }),
      reply(503, { errors: [{ error: "SERVICE_UNAVAILABLE" }] }),
      reply(200, { data: { status: "approved", api_key: "org_key", org_id: "o1" } }),
    ];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      if (url.endsWith("/start"))
        return reply(200, {
          data: {
            device_code: "dev-secret",
            user_code: "PVT7-W7TV",
            verification_url_complete: "https://app.bland.ai/agent-setup?code=PVT7-W7TV",
            expires_in: 900,
            interval: 5,
          },
        });
      return answers.shift() as Response;
    }) as unknown as typeof fetch;

    const login = await startBrowserLogin("https://api.test", fetchImpl);
    expect(login).toMatchObject({ userCode: "PVT7-W7TV", intervalSeconds: 5 });
    const outcome = await waitForApproval("https://api.test", login, { fetch: fetchImpl, sleep: async () => {} });
    expect(outcome).toEqual({ status: "approved", apiKey: "org_key" });
    expect(bodies).toEqual([
      { client_name: "opencontact" },
      { device_code: "dev-secret" },
      { device_code: "dev-secret" },
      { device_code: "dev-secret" },
    ]);
  });

  it("reports an expired code, and a disabled flow as an error", async () => {
    const expired = (async () => reply(200, { data: { status: "expired" } })) as unknown as typeof fetch;
    const login = { deviceCode: "d", userCode: "U", url: "u", expiresInSeconds: 60, intervalSeconds: 1 };
    expect(await waitForApproval("https://api.test", login, { fetch: expired, sleep: async () => {} })).toEqual({
      status: "expired",
    });
    const off = (async () =>
      reply(403, { errors: [{ error: "DISABLED", message: "not available" }] })) as unknown as typeof fetch;
    await expect(startBrowserLogin("https://api.test", off)).rejects.toThrow(LoginError);
  });
});
