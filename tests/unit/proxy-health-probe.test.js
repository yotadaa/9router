import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("undici", () => ({ fetch: mocks.fetch }));

import { checkHealthEnvironment, testRelayUrl } from "@/lib/network/healthProbe.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("relay health sentinel verification", () => {
  it("accepts only the exact primary 204 sentinel response", async () => {
    mocks.fetch.mockResolvedValue(new Response(null, {
      status: 204,
      statusText: "No Content",
    }));

    const result = await testRelayUrl({ relayUrl: "https://relay.test/api" });

    expect(result).toMatchObject({ ok: true, targetOk: true, status: 204 });
    expect(mocks.fetch).toHaveBeenCalledWith(
      expect.objectContaining({ href: "https://relay.test/api" }),
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
        headers: expect.objectContaining({
          "x-relay-target": "https://connectivitycheck.gstatic.com",
          "x-relay-path": "/generate_204",
        }),
      })
    );
  });

  it("rejects a provider landing page instead of calling it a valid relay", async () => {
    mocks.fetch.mockResolvedValue(new Response("landing page", { status: 200 }));

    const result = await testRelayUrl({ relayUrl: "https://relay.test/" });

    expect(result).toMatchObject({
      ok: false,
      failureKind: "relay-verification",
      retryable: true,
      proxyFailure: true,
      inconclusive: false,
    });
  });

  it("validates the bounded independent Cloudflare trace fallback", async () => {
    mocks.fetch.mockResolvedValue(new Response(
      "fl=123f456\nh=cloudflare.com\nip=203.0.113.7\ncolo=CGK\n",
      { status: 200 }
    ));

    const result = await testRelayUrl({
      relayUrl: "https://relay.test/api",
      testUrl: "https://cloudflare.com/cdn-cgi/trace",
    });

    expect(result).toMatchObject({ ok: true, targetOk: true, status: 200 });
    expect(mocks.fetch.mock.calls[0][1].headers).toMatchObject({
      "x-relay-target": "https://cloudflare.com",
      "x-relay-path": "/cdn-cgi/trace",
    });
  });

  it("keeps local socket exhaustion inconclusive", async () => {
    const cause = Object.assign(new Error("no buffers"), { code: "ENOBUFS" });
    const error = Object.assign(new TypeError("fetch failed"), { cause });
    mocks.fetch.mockRejectedValue(error);

    const result = await testRelayUrl({ relayUrl: "https://relay.test/api" });

    expect(result).toMatchObject({
      ok: false,
      failureKind: "local-resource",
      errorCode: "ENOBUFS",
      retryable: false,
      proxyFailure: false,
      inconclusive: true,
    });
  });

  it("classifies a missing relay host as a retryable relay-endpoint failure", async () => {
    const cause = Object.assign(new Error("host not found"), { code: "ENOTFOUND" });
    mocks.fetch.mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause }));

    const result = await testRelayUrl({ relayUrl: "https://missing-relay.test/api" });

    expect(result).toMatchObject({
      ok: false,
      failureKind: "relay-endpoint",
      errorCode: "ENOTFOUND",
      retryable: true,
      proxyFailure: true,
      inconclusive: false,
    });
  });
});

describe("health-check environment controls", () => {
  it("allows a job when at least one independent direct target responds", async () => {
    mocks.fetch
      .mockRejectedValueOnce(new Error("primary unavailable"))
      .mockResolvedValueOnce(new Response(
        "fl=123f456\nh=cloudflare.com\nip=203.0.113.7\ncolo=CGK\n",
        { status: 200 }
      ));

    await expect(checkHealthEnvironment()).resolves.toEqual({
      ok: true,
      reachableTargets: 1,
      checkedTargets: 2,
    });
  });

  it("blocks failure classification when both direct targets are unreachable", async () => {
    mocks.fetch.mockRejectedValue(new Error("offline"));

    await expect(checkHealthEnvironment()).resolves.toEqual({
      ok: false,
      reachableTargets: 0,
      checkedTargets: 2,
    });
  });

  it("does not call target error pages a healthy control environment", async () => {
    mocks.fetch
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("not found", { status: 404 }));

    await expect(checkHealthEnvironment()).resolves.toEqual({
      ok: false,
      reachableTargets: 0,
      checkedTargets: 2,
    });
  });
});
