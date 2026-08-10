import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import {
  clearQoderCredentialCache,
} from "../../open-sse/shared/qoder/credentials.js";
import {
  QODER_ACTIVITY_URL,
  QODER_ACTIVITY_URL_ALT,
} from "../../open-sse/shared/qoder/constants.js";
import { PROVIDERS } from "../../open-sse/providers/index.js";
import {
  getRemainingPercentage,
  parseQuotaData,
} from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const PAT_EXCHANGE_URL = "https://openapi.qoder.sh/api/v1/jobToken/exchange";
const USERINFO_URL = "https://openapi.qoder.sh/api/v1/userinfo";
const PROXY_OPTIONS = {
  connectionProxyEnabled: true,
  connectionProxyUrl: "http://127.0.0.1:8080",
};

const SAMPLE_ACTIVITY_RESPONSE = {
  code: 0,
  msg: "ok",
  data: {
    activities: [
      {
        type: "MODEL_FREE_QUOTA",
        activityId: "qwen38_800_invoke",
        modelName: "Qwen3.8-Max 免费额度",
        tag: "限时特惠",
        tagStyle: "FREE",
        modelKeys: ["qmodel_38max"],
        limit: 800,
        used: 0,
        remaining: 800,
        resetAt: 0,
        resetStrategy: "NEVER_EXPIRE",
        serverTimezone: "Asia/Shanghai",
        description: "活动期内每人 800 次免费调用",
        statusText: "剩余 800 次",
        eligible: true,
        deviceOccupiedByOthers: false,
        claimActivity: true,
        activityEndAt: 1790783940000,
        cliText: "Used 0 / 800",
      },
    ],
    queryAt: 1786292392469,
  },
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockPatFlow(activityBody = SAMPLE_ACTIVITY_RESPONSE) {
  proxyAwareFetch
    .mockResolvedValueOnce(jsonResponse({ token: "jt-test-job", expires_in: 3600 }))
    .mockResolvedValueOnce(jsonResponse({ id: "qoder-user-1" }))
    .mockResolvedValueOnce(jsonResponse(activityBody));
}

describe("Qoder activity quota", () => {
  const consoleSpies = [];

  beforeEach(() => {
    vi.clearAllMocks();
    clearQoderCredentialCache();
    consoleSpies.push(
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    );
  });

  afterEach(() => {
    while (consoleSpies.length) consoleSpies.pop().mockRestore();
  });

  it("registers the activity endpoint as Qoder's usage source", () => {
    expect(PROVIDERS.qoder.usage.url).toBe(QODER_ACTIVITY_URL);
    expect(PROVIDERS.qoder.usage.jobTokenUrl).toBe(QODER_ACTIVITY_URL_ALT);
  });

  it("exchanges a PAT, resolves user identity, and COSY-signs the activity request", async () => {
    const pat = "pt-secret-that-must-not-be-logged";
    mockPatFlow();

    const usage = await getUsageForProvider(
      { provider: "qoder", apiKey: pat, providerSpecificData: {} },
      PROXY_OPTIONS,
    );

    expect(proxyAwareFetch).toHaveBeenCalledTimes(3);
    expect(proxyAwareFetch.mock.calls.map(([url]) => url)).toEqual([
      PAT_EXCHANGE_URL,
      USERINFO_URL,
      QODER_ACTIVITY_URL_ALT,
    ]);
    for (const call of proxyAwareFetch.mock.calls) {
      expect(call[2]).toBe(PROXY_OPTIONS);
    }

    const exchangeOptions = proxyAwareFetch.mock.calls[0][1];
    expect(JSON.parse(exchangeOptions.body)).toEqual({ personal_token: pat });
    const userInfoOptions = proxyAwareFetch.mock.calls[1][1];
    expect(userInfoOptions.headers.Authorization).toBe("Bearer jt-test-job");

    const activityOptions = proxyAwareFetch.mock.calls[2][1];
    expect(activityOptions.method).toBe("GET");
    expect(activityOptions.headers.Authorization).toMatch(/^Bearer COSY\./);
    expect(activityOptions.headers.Authorization).not.toContain(pat);
    expect(activityOptions.headers["Cosy-User"]).toBe("qoder-user-1");
    expect(activityOptions.headers["Accept-Encoding"]).toBe("identity");

    expect(usage).toMatchObject({
      plan: "Qoder Free",
      quotas: {
        qwen38_800_invoke: {
          name: "Qwen3.8-Max 免费额度",
          activityId: "qwen38_800_invoke",
          modelKeys: ["qmodel_38max"],
          used: 0,
          total: 800,
          remaining: 800,
          remainingPercentage: 100,
          recurring: false,
          resetStrategy: "NEVER_EXPIRE",
        },
      },
    });
    expect(usage.quotas.qwen38_800_invoke.resetAt).toBe(
      new Date(1790783940000).toISOString(),
    );

    const logged = consoleSpies.flatMap((spy) => spy.mock.calls).flat().join(" ");
    expect(logged).not.toContain(pat);
    expect(logged).not.toContain("jt-test-job");
  });

  it("uses a stored device token and user id directly without PAT exchange", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(SAMPLE_ACTIVITY_RESPONSE));

    await getUsageForProvider(
      {
        provider: "qoder",
        accessToken: "dt-device-token",
        providerSpecificData: {
          userId: "oauth-user",
          machineId: "oauth-machine",
        },
      },
      PROXY_OPTIONS,
    );

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    const [url, options, proxy] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe(QODER_ACTIVITY_URL);
    expect(options.headers.Authorization).toMatch(/^Bearer COSY\./);
    expect(options.headers.Authorization).not.toBe("Bearer dt-device-token");
    expect(options.headers["Cosy-User"]).toBe("oauth-user");
    expect(options.headers["Cosy-Machineid"]).toBe("oauth-machine");
    expect(proxy).toBe(PROXY_OPTIONS);
  });

  it("reuses a cached PAT job credential across quota refreshes", async () => {
    mockPatFlow();
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(SAMPLE_ACTIVITY_RESPONSE));

    const connection = {
      provider: "qoder",
      apiKey: "pt-cache-test",
      providerSpecificData: {},
    };
    await getUsageForProvider(connection);
    await getUsageForProvider(connection);

    expect(proxyAwareFetch.mock.calls.map(([url]) => url)).toEqual([
      PAT_EXCHANGE_URL,
      USERINFO_URL,
      QODER_ACTIVITY_URL_ALT,
      QODER_ACTIVITY_URL_ALT,
    ]);
  });

  it("re-exchanges a cached PAT once when Qoder rejects its job token", async () => {
    mockPatFlow();
    await getUsageForProvider({
      provider: "qoder",
      apiKey: "pt-rejected-cache",
      providerSpecificData: {},
    });

    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ message: "Login expired" }, 403))
      .mockResolvedValueOnce(jsonResponse({ token: "jt-fresh-job", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ id: "qoder-user-1" }))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_ACTIVITY_RESPONSE));

    const usage = await getUsageForProvider({
      provider: "qoder",
      apiKey: "pt-rejected-cache",
      providerSpecificData: {},
    });

    expect(usage.plan).toBe("Qoder Free");
    expect(proxyAwareFetch.mock.calls.slice(3).map(([url]) => url)).toEqual([
      QODER_ACTIVITY_URL_ALT,
      PAT_EXCHANGE_URL,
      USERINFO_URL,
      QODER_ACTIVITY_URL_ALT,
    ]);
    expect(proxyAwareFetch.mock.calls[6][1].headers.Authorization).toMatch(/^Bearer COSY\./);
  });

  it("normalizes an accepted unprefixed PAT before exchange", async () => {
    mockPatFlow();

    await getUsageForProvider({
      provider: "qoder",
      apiKey: "unprefixed-personal-token",
      providerSpecificData: {},
    });

    expect(proxyAwareFetch.mock.calls[0][0]).toBe(PAT_EXCHANGE_URL);
    expect(JSON.parse(proxyAwareFetch.mock.calls[0][1].body)).toEqual({
      personal_token: "pt-unprefixed-personal-token",
    });
    expect(proxyAwareFetch.mock.calls[2][0]).toBe(QODER_ACTIVITY_URL_ALT);
  });

  it("keeps eligible free activities under collision-safe stable keys", async () => {
    const body = {
      code: 0,
      msg: "ok",
      data: {
        activities: [
          {
            type: "MODEL_FREE_QUOTA",
            activityId: "same-id",
            modelName: "Same name",
            limit: 100,
            used: 25,
            remaining: 75,
            eligible: true,
          },
          {
            type: "MODEL_FREE_QUOTA",
            activityId: "same-id",
            modelName: "Same name",
            limit: "200",
            used: "40",
            remaining: "160",
            eligible: true,
          },
          {
            type: "MODEL_FREE_QUOTA",
            activityId: "not-eligible",
            modelName: "Unavailable",
            limit: 50,
            remaining: 50,
            eligible: false,
          },
          { type: "OTHER_ACTIVITY", activityId: "other", limit: 999 },
        ],
      },
    };
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(body));

    const usage = await getUsageForProvider({
      provider: "qoder",
      accessToken: "dt-multi",
      providerSpecificData: { userId: "user-multi" },
    });

    expect(Object.keys(usage.quotas)).toEqual(["same-id", "same-id-2"]);
    expect(usage.quotas["same-id"].remainingPercentage).toBe(75);
    expect(usage.quotas["same-id-2"].remainingPercentage).toBe(80);
    expect(parseQuotaData("qoder", usage).map((quota) => quota.modelKey)).toEqual([
      "same-id",
      "same-id-2",
    ]);
  });

  it("returns a clear empty state when no eligible free activity exists", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      code: 0,
      msg: "ok",
      data: { activities: [] },
    }));

    const usage = await getUsageForProvider({
      provider: "qoder",
      accessToken: "dt-empty",
      providerSpecificData: { userId: "user-empty" },
    });

    expect(usage.quotas).toEqual({});
    expect(usage.message).toMatch(/no eligible/i);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("does not report occupied or already-expired activities as usable quota", async () => {
    const queryAt = 1_800_000_000_000;
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      code: 0,
      msg: "ok",
      data: {
        queryAt,
        activities: [
          {
            type: "MODEL_FREE_QUOTA",
            activityId: "occupied",
            modelName: "Occupied",
            limit: 100,
            remaining: 100,
            eligible: true,
            deviceOccupiedByOthers: true,
            activityEndAt: queryAt + 1000,
          },
          {
            type: "MODEL_FREE_QUOTA",
            activityId: "expired",
            modelName: "Expired",
            limit: 100,
            remaining: 100,
            eligible: true,
            activityEndAt: queryAt - 1,
          },
          {
            type: "MODEL_FREE_QUOTA",
            activityId: "usable",
            modelName: "Usable",
            limit: 100,
            remaining: 80,
            eligible: true,
            claimActivity: true,
            activityEndAt: queryAt + 60_000,
          },
        ],
      },
    }));

    const usage = await getUsageForProvider({
      provider: "qoder",
      accessToken: "dt-availability",
      providerSpecificData: { userId: "availability-user" },
    });

    expect(Object.keys(usage.quotas)).toEqual(["usable"]);
    expect(usage.quotas.usable).toMatchObject({
      claimActivity: true,
      deviceOccupiedByOthers: false,
      remainingPercentage: 80,
    });
  });

  it("stops safely when PAT exchange or user identity resolution fails", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ error: "bad PAT" }, 401));
    const exchangeFailure = await getUsageForProvider({
      provider: "qoder",
      apiKey: "pt-exchange-failure",
      providerSpecificData: {},
    });
    expect(exchangeFailure.message).toMatch(/PAT exchange.*401/i);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ token: "jt-no-user", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ error: "no identity" }, 403));
    const userInfoFailure = await getUsageForProvider({
      provider: "qoder",
      apiKey: "pt-userinfo-failure",
      providerSpecificData: {},
    });
    expect(userInfoFailure.message).toMatch(/identity.*403/i);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
  });

  it("reports network and timeout failures without making fallback requests", async () => {
    proxyAwareFetch.mockRejectedValueOnce(new Error("socket closed"));
    const networkFailure = await getUsageForProvider({
      provider: "qoder",
      accessToken: "dt-network-failure",
      providerSpecificData: { userId: "network-user" },
    });
    expect(networkFailure.message).toMatch(/temporarily unavailable/i);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    const timeoutError = new Error("request aborted");
    timeoutError.name = "AbortError";
    proxyAwareFetch.mockRejectedValueOnce(timeoutError);
    const timeoutFailure = await getUsageForProvider({
      provider: "qoder",
      accessToken: "dt-timeout-failure",
      providerSpecificData: { userId: "timeout-user" },
    });
    expect(timeoutFailure.message).toMatch(/timed out/i);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, /expired|reconnect|rejected/i],
    [403, /expired|reconnect|rejected/i],
    [429, /rate limited/i],
    [500, /HTTP 500/i],
  ])("surfaces activity HTTP %i without obsolete fallback calls", async (status, expected) => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ error: "upstream" }, status));

    const usage = await getUsageForProvider({
      provider: "qoder",
      accessToken: `dt-http-${status}`,
      providerSpecificData: { userId: "http-user" },
    });

    expect(usage.message).toMatch(expected);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("distinguishes upstream envelope and malformed JSON failures from empty quota", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ code: 17, msg: "activity unavailable" }));
    const envelopeError = await getUsageForProvider({
      provider: "qoder",
      accessToken: "dt-code-error",
      providerSpecificData: { userId: "code-user" },
    });
    expect(envelopeError.message).toMatch(/activity unavailable/i);

    proxyAwareFetch.mockResolvedValueOnce(new Response("{", { status: 200 }));
    const jsonError = await getUsageForProvider({
      provider: "qoder",
      accessToken: "dt-json-error",
      providerSpecificData: { userId: "json-user" },
    });
    expect(jsonError.message).toMatch(/invalid JSON/i);

    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ code: 0, data: {} }));
    const shapeError = await getUsageForProvider({
      provider: "qoder",
      accessToken: "dt-shape-error",
      providerSpecificData: { userId: "shape-user" },
    });
    expect(shapeError.message).toMatch(/invalid activity/i);
  });

  it("does not make a request without a credential", async () => {
    const usage = await getUsageForProvider({ provider: "qoder" });
    expect(usage.message).toMatch(/credential|reconnect|token/i);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("normalizes stable IDs and activity expiry for the quota dashboard", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(SAMPLE_ACTIVITY_RESPONSE));
    const usage = await getUsageForProvider({
      provider: "qoder",
      accessToken: "dt-ui-test",
      providerSpecificData: { userId: "ui-user" },
    });

    const rows = parseQuotaData("qoder", usage);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "Qwen3.8-Max 免费额度",
      modelKey: "qwen38_800_invoke",
      used: 0,
      total: 800,
      remainingPercentage: 100,
      recurring: false,
      resetAt: new Date(1790783940000).toISOString(),
    });
    expect(rows[0].remaining).toBeUndefined();
    expect(getRemainingPercentage(rows[0])).toBe(100);
  });
});
