import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { clearQoderCredentialCache } from "../../open-sse/shared/qoder/credentials.js";
import {
  QODER_ACTIVITY_URL,
  QODER_ACTIVITY_URL_ALT,
  QODER_QUOTA_USAGE_URL,
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
const ACTIVITY_NAME = "Qwen3.8-Max \u514d\u8d39\u989d\u5ea6";

const SAMPLE_ACTIVITY_RESPONSE = {
  code: 0,
  msg: "ok",
  data: {
    activities: [
      {
        type: "MODEL_FREE_QUOTA",
        activityId: "qwen38_800_invoke",
        modelName: ACTIVITY_NAME,
        tag: "\u9650\u65f6\u7279\u60e0",
        tagStyle: "FREE",
        modelKeys: ["qmodel_38max"],
        limit: 800,
        used: 0,
        remaining: 800,
        resetAt: 0,
        resetStrategy: "NEVER_EXPIRE",
        serverTimezone: "Asia/Shanghai",
        description: "\u6d3b\u52a8\u671f\u5185\u6bcf\u4eba 800 \u6b21\u514d\u8d39\u8c03\u7528",
        statusText: "\u5269\u4f59 800 \u6b21",
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

const SAMPLE_CREDITS_RESPONSE = {
  userType: "personal_professional_trial",
  userQuota: {
    total: 300,
    used: 33,
    remaining: 267,
    unit: "credits",
  },
  isQuotaExceeded: false,
  expiresAt: 1793375940000,
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function queuePatFlow({
  activity = jsonResponse(SAMPLE_ACTIVITY_RESPONSE),
  credits = jsonResponse(SAMPLE_CREDITS_RESPONSE),
  exchange = { token: "jt-test-job", expires_in: 3600 },
  user = { id: "qoder-user-1" },
} = {}) {
  proxyAwareFetch
    .mockResolvedValueOnce(jsonResponse(exchange))
    .mockResolvedValueOnce(jsonResponse(user))
    .mockResolvedValueOnce(activity)
    .mockResolvedValueOnce(credits);
}

function queueDirectFlow({
  activity = jsonResponse(SAMPLE_ACTIVITY_RESPONSE),
  credits = jsonResponse(SAMPLE_CREDITS_RESPONSE),
} = {}) {
  proxyAwareFetch
    .mockResolvedValueOnce(activity)
    .mockResolvedValueOnce(credits);
}

function serializedConsoleOutput(spies) {
  return spies
    .flatMap((spy) => spy.mock.calls)
    .flatMap((args) => args)
    .map((value) => {
      if (typeof value === "string") return value;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(" ");
}

describe("Qoder combined quota", () => {
  const consoleSpies = [];

  beforeEach(() => {
    vi.clearAllMocks();
    clearQoderCredentialCache();
    for (const method of ["log", "warn", "error", "info", "debug"]) {
      consoleSpies.push(vi.spyOn(console, method).mockImplementation(() => {}));
    }
  });

  afterEach(() => {
    while (consoleSpies.length) consoleSpies.pop().mockRestore();
    vi.useRealTimers();
  });

  it("registers distinct credits and activity endpoints", () => {
    expect(PROVIDERS.qoder.usage.url).toBe(QODER_QUOTA_USAGE_URL);
    expect(PROVIDERS.qoder.usage.activityUrl).toBe(QODER_ACTIVITY_URL);
    expect(PROVIDERS.qoder.usage.jobTokenActivityUrl).toBe(QODER_ACTIVITY_URL_ALT);
  });

  it("returns both the 800-call activity and 300 credits for a PAT", async () => {
    const pat = "pt-secret-that-must-not-be-logged";
    queuePatFlow();

    const usage = await getUsageForProvider(
      { provider: "qoder", apiKey: pat, providerSpecificData: {} },
      PROXY_OPTIONS,
    );

    expect(proxyAwareFetch.mock.calls.map(([url]) => url)).toEqual([
      PAT_EXCHANGE_URL,
      USERINFO_URL,
      QODER_ACTIVITY_URL_ALT,
      QODER_QUOTA_USAGE_URL,
    ]);
    for (const call of proxyAwareFetch.mock.calls) {
      expect(call[2]).toBe(PROXY_OPTIONS);
    }

    expect(JSON.parse(proxyAwareFetch.mock.calls[0][1].body)).toEqual({
      personal_token: pat,
    });
    expect(proxyAwareFetch.mock.calls[1][1].headers.Authorization).toBe(
      "Bearer jt-test-job",
    );

    const activityOptions = proxyAwareFetch.mock.calls[2][1];
    expect(activityOptions.method).toBe("GET");
    expect(activityOptions.headers.Authorization).toMatch(/^Bearer COSY\./);
    expect(activityOptions.headers.Authorization).not.toContain(pat);
    expect(activityOptions.headers["Cosy-User"]).toBe("qoder-user-1");
    expect(activityOptions.headers["Accept-Encoding"]).toBe("identity");

    const creditsOptions = proxyAwareFetch.mock.calls[3][1];
    expect(creditsOptions.headers.Authorization).toBe("Bearer jt-test-job");
    expect(creditsOptions.headers.Authorization).not.toContain(pat);

    expect(usage).toMatchObject({
      plan: "Professional Trial",
      quotas: {
        qwen38_800_invoke: {
          name: ACTIVITY_NAME,
          used: 0,
          total: 800,
          remaining: 800,
          remainingPercentage: 100,
          recurring: false,
          unit: "calls",
        },
        credits: {
          name: "Credits",
          used: 33,
          total: 300,
          remaining: 267,
          remainingPercentage: 89,
          recurring: false,
          unit: "credits",
        },
      },
    });
    expect(usage.quotas.qwen38_800_invoke.resetAt).toBe(
      new Date(1790783940000).toISOString(),
    );
    expect(usage.quotas.credits.resetAt).toBe(
      new Date(1793375940000).toISOString(),
    );
    expect(usage.message).toBeUndefined();

    const logged = serializedConsoleOutput(consoleSpies);
    expect(logged).not.toContain(pat);
    expect(logged).not.toContain("jt-test-job");
  });

  it("uses a stored device token for both sources without PAT exchange", async () => {
    queueDirectFlow();

    const usage = await getUsageForProvider(
      {
        provider: "qoder",
        accessToken: "dt-device-token",
        providerSpecificData: { userId: "oauth-user", machineId: "oauth-machine" },
      },
      PROXY_OPTIONS,
    );

    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
    expect(proxyAwareFetch.mock.calls[0][0]).toBe(QODER_ACTIVITY_URL);
    expect(proxyAwareFetch.mock.calls[0][1].headers.Authorization).toMatch(/^Bearer COSY\./);
    expect(proxyAwareFetch.mock.calls[0][1].headers["Cosy-User"]).toBe("oauth-user");
    expect(proxyAwareFetch.mock.calls[1][0]).toBe(QODER_QUOTA_USAGE_URL);
    expect(proxyAwareFetch.mock.calls[1][1].headers.Authorization).toBe(
      "Bearer dt-device-token",
    );
    expect(Object.keys(usage.quotas)).toEqual(["qwen38_800_invoke", "credits"]);
  });

  it("uses the job-token activity host and reuses the cached PAT credential", async () => {
    queuePatFlow();
    queueDirectFlow();
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
      QODER_QUOTA_USAGE_URL,
      QODER_ACTIVITY_URL_ALT,
      QODER_QUOTA_USAGE_URL,
    ]);
    expect(proxyAwareFetch.mock.calls.filter(([url]) => url === PAT_EXCHANGE_URL)).toHaveLength(1);
  });

  it("invalidates and re-exchanges a rejected cached PAT exactly once", async () => {
    queuePatFlow();
    await getUsageForProvider({
      provider: "qoder",
      apiKey: "pt-rejected-cache",
      providerSpecificData: {},
    });

    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ message: "Login expired" }, 403))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_CREDITS_RESPONSE))
      .mockResolvedValueOnce(jsonResponse({ token: "jt-fresh-job", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ id: "qoder-user-1" }))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_ACTIVITY_RESPONSE))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_CREDITS_RESPONSE));

    const usage = await getUsageForProvider({
      provider: "qoder",
      apiKey: "pt-rejected-cache",
      providerSpecificData: {},
    });

    expect(usage.quotas.credits.total).toBe(300);
    expect(usage.quotas.qwen38_800_invoke.total).toBe(800);
    expect(proxyAwareFetch.mock.calls.slice(4).map(([url]) => url)).toEqual([
      QODER_ACTIVITY_URL_ALT,
      QODER_QUOTA_USAGE_URL,
      PAT_EXCHANGE_URL,
      USERINFO_URL,
      QODER_ACTIVITY_URL_ALT,
      QODER_QUOTA_USAGE_URL,
    ]);
  });

  it.each([
    {
      name: "credits when activity authentication is rejected",
      activity: jsonResponse({ message: "Login expired" }, 403),
      credits: jsonResponse(SAMPLE_CREDITS_RESPONSE),
      expectedQuota: "credits",
      rejectedSource: /authentication expired|rejected/i,
    },
    {
      name: "activity when credits authentication is rejected",
      activity: jsonResponse(SAMPLE_ACTIVITY_RESPONSE),
      credits: jsonResponse({ message: "Login expired" }, 403),
      expectedQuota: "qwen38_800_invoke",
      rejectedSource: /credits authentication expired|rejected/i,
    },
  ])("preserves $name when PAT refresh fails", async ({
    activity,
    credits,
    expectedQuota,
    rejectedSource,
  }) => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse({ token: "jt-partial-job", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ id: "qoder-partial-user" }))
      .mockResolvedValueOnce(activity)
      .mockResolvedValueOnce(credits)
      .mockResolvedValueOnce(jsonResponse({ error: "exchange unavailable" }, 503));

    const usage = await getUsageForProvider({
      provider: "qoder",
      apiKey: `pt-partial-refresh-${expectedQuota}`,
      providerSpecificData: {},
    });

    expect(Object.keys(usage.quotas)).toEqual([expectedQuota]);
    expect(usage.message).toBeUndefined();
    expect(usage.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/PAT exchange.*503/i),
      expect.stringMatching(rejectedSource),
    ]));
    expect(proxyAwareFetch.mock.calls.map(([url]) => url)).toEqual([
      PAT_EXCHANGE_URL,
      USERINFO_URL,
      QODER_ACTIVITY_URL_ALT,
      QODER_QUOTA_USAGE_URL,
      PAT_EXCHANGE_URL,
    ]);
  });

  it("normalizes an unprefixed PAT before exchange", async () => {
    queuePatFlow();
    await getUsageForProvider({
      provider: "qoder",
      apiKey: "unprefixed-personal-token",
      providerSpecificData: {},
    });

    expect(JSON.parse(proxyAwareFetch.mock.calls[0][1].body)).toEqual({
      personal_token: "pt-unprefixed-personal-token",
    });
  });

  it("preserves credits when activity fails", async () => {
    queueDirectFlow({ activity: jsonResponse({ error: "upstream" }, 500) });
    const usage = await getUsageForProvider({
      provider: "qoder",
      accessToken: "dt-partial-credits",
      providerSpecificData: { userId: "partial-user" },
    });

    expect(Object.keys(usage.quotas)).toEqual(["credits"]);
    expect(usage.quotas.credits.total).toBe(300);
    expect(usage.message).toBeUndefined();
    expect(usage.warnings[0]).toMatch(/activity.*500/i);
  });

  it("preserves the 800-call activity when credits fail", async () => {
    queueDirectFlow({ credits: jsonResponse({ error: "upstream" }, 500) });
    const usage = await getUsageForProvider({
      provider: "qoder",
      accessToken: "dt-partial-activity",
      providerSpecificData: { userId: "partial-user" },
    });

    expect(Object.keys(usage.quotas)).toEqual(["qwen38_800_invoke"]);
    expect(usage.quotas.qwen38_800_invoke.total).toBe(800);
    expect(usage.message).toBeUndefined();
    expect(usage.warnings[0]).toMatch(/credits.*500/i);
  });

  it("shows credits without an error message when no activity is eligible", async () => {
    queueDirectFlow({
      activity: jsonResponse({ code: 0, msg: "ok", data: { activities: [] } }),
    });
    const usage = await getUsageForProvider({
      provider: "qoder",
      accessToken: "dt-empty-activity",
      providerSpecificData: { userId: "empty-user" },
    });

    expect(Object.keys(usage.quotas)).toEqual(["credits"]);
    expect(usage.message).toBeUndefined();
  });

  it("keeps activity IDs collision-safe and excludes occupied or expired rows", async () => {
    const queryAt = 1_800_000_000_000;
    const activityBody = {
      code: 0,
      msg: "ok",
      data: {
        queryAt,
        activities: [
          {
            type: "MODEL_FREE_QUOTA",
            activityId: "same-id",
            modelName: "Same name",
            limit: 100,
            used: 25,
            remaining: 75,
            eligible: true,
            activityEndAt: queryAt + 60_000,
          },
          {
            type: "MODEL_FREE_QUOTA",
            activityId: "same-id",
            modelName: "Same name",
            limit: 200,
            used: 40,
            remaining: 160,
            eligible: true,
            activityEndAt: queryAt + 60_000,
          },
          {
            type: "MODEL_FREE_QUOTA",
            activityId: "occupied",
            limit: 100,
            remaining: 100,
            eligible: true,
            deviceOccupiedByOthers: true,
            activityEndAt: queryAt + 60_000,
          },
          {
            type: "MODEL_FREE_QUOTA",
            activityId: "expired",
            limit: 100,
            remaining: 100,
            eligible: true,
            activityEndAt: queryAt - 1,
          },
        ],
      },
    };
    queueDirectFlow({
      activity: jsonResponse(activityBody),
      credits: jsonResponse({ error: "not available" }, 500),
    });

    const usage = await getUsageForProvider({
      provider: "qoder",
      accessToken: "dt-collisions",
      providerSpecificData: { userId: "collision-user" },
    });

    expect(Object.keys(usage.quotas)).toEqual(["same-id", "same-id-2"]);
    expect(usage.quotas["same-id"].remainingPercentage).toBe(75);
    expect(usage.quotas["same-id-2"].remainingPercentage).toBe(80);
    expect(parseQuotaData("qoder", usage).map((quota) => quota.modelKey)).toEqual([
      "same-id",
      "same-id-2",
    ]);
  });

  it("falls back to the alternate activity host after a direct-token 403", async () => {
    queueDirectFlow({ activity: jsonResponse({ message: "rejected" }, 403) });
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(SAMPLE_ACTIVITY_RESPONSE));

    const usage = await getUsageForProvider({
      provider: "qoder",
      accessToken: "dt-activity-fallback",
      providerSpecificData: { userId: "fallback-user" },
    });

    expect(proxyAwareFetch.mock.calls.map(([url]) => url)).toEqual([
      QODER_ACTIVITY_URL,
      QODER_QUOTA_USAGE_URL,
      QODER_ACTIVITY_URL_ALT,
    ]);
    expect(usage.quotas.qwen38_800_invoke.total).toBe(800);
    expect(usage.quotas.credits.total).toBe(300);
  });

  it("returns a sanitized error only when both quota sources fail", async () => {
    queueDirectFlow({
      activity: jsonResponse({ error: "activity down" }, 500),
      credits: jsonResponse({ error: "credits down" }, 503),
    });
    const usage = await getUsageForProvider({
      provider: "qoder",
      accessToken: "dt-both-fail",
      providerSpecificData: { userId: "failed-user" },
    });

    expect(usage.quotas).toEqual({});
    expect(usage.message).toMatch(/activity.*500/i);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
  });

  it("handles independent network failures without throwing", async () => {
    proxyAwareFetch
      .mockRejectedValueOnce(new Error("activity socket closed"))
      .mockRejectedValueOnce(new Error("credits socket closed"));
    const usage = await getUsageForProvider({
      provider: "qoder",
      accessToken: "dt-network-failure",
      providerSpecificData: { userId: "network-user" },
    });

    expect(usage.quotas).toEqual({});
    expect(usage.message).toMatch(/temporarily unavailable/i);
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

  it("treats Qoder's millisecond expires_in as milliseconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:00:00Z"));
    queuePatFlow({ exchange: { token: "jt-ms-expiry", expires_in: 86_400_000 } });
    const connection = {
      provider: "qoder",
      apiKey: "pt-ms-expiry",
      providerSpecificData: {},
    };
    await getUsageForProvider(connection);

    vi.setSystemTime(new Date("2026-08-11T01:00:00Z"));
    queuePatFlow({ exchange: { token: "jt-ms-expiry-new", expires_in: 86_400_000 } });
    await getUsageForProvider(connection);

    expect(proxyAwareFetch.mock.calls.filter(([url]) => url === PAT_EXCHANGE_URL)).toHaveLength(2);
  });

  it("normalizes both rows for the dashboard with stable keys", async () => {
    queueDirectFlow();
    const usage = await getUsageForProvider({
      provider: "qoder",
      accessToken: "dt-ui-test",
      providerSpecificData: { userId: "ui-user" },
    });

    const rows = parseQuotaData("qoder", usage);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      name: ACTIVITY_NAME,
      modelKey: "qwen38_800_invoke",
      used: 0,
      total: 800,
      unit: "calls",
      remainingPercentage: 100,
      recurring: false,
    });
    expect(rows[1]).toMatchObject({
      name: "Credits",
      modelKey: "credits",
      used: 33,
      total: 300,
      unit: "credits",
      remainingPercentage: 89,
      recurring: false,
    });
    expect(rows[0].remaining).toBeUndefined();
    expect(getRemainingPercentage(rows[0])).toBe(100);
  });

  it("does not call Qoder without a credential", async () => {
    const usage = await getUsageForProvider({ provider: "qoder" });
    expect(usage.message).toMatch(/credential|reconnect|token/i);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });
});
