import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getProxyPoolById: vi.fn(),
  bulkUpdateProxyPoolHealth: vi.fn(),
}));
const proxyMocks = vi.hoisted(() => ({ testProxyUrl: vi.fn() }));
const healthProbeMocks = vi.hoisted(() => ({
  checkHealthEnvironment: vi.fn(),
  testRelayUrl: vi.fn(),
}));

vi.mock("@/models", () => dbMocks);
vi.mock("@/lib/network/proxyTest", () => proxyMocks);
vi.mock("@/lib/network/healthProbe", () => healthProbeMocks);
vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "content-type": "application/json" },
      });
    },
  },
}));

import { POST } from "@/app/api/proxy-pools/[id]/test/route.js";

function context(id = "proxy-1") {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getProxyPoolById.mockResolvedValue({
    id: "proxy-1",
    type: "proxy",
    proxyUrl: "socks5://alice:secret@proxy.test:1080",
    isActive: false,
    updatedAt: "2026-08-10T00:00:00.000Z",
  });
  dbMocks.bulkUpdateProxyPoolHealth.mockResolvedValue(1);
  healthProbeMocks.testRelayUrl.mockReset().mockResolvedValue({
    ok: true,
    targetOk: true,
    status: 204,
    statusText: "No Content",
    elapsedMs: 18,
    retryable: false,
  });
  healthProbeMocks.checkHealthEnvironment.mockReset().mockResolvedValue({
    ok: true,
    reachableTargets: 2,
    checkedTargets: 2,
  });
});

describe("POST /api/proxy-pools/[id]/test", () => {
  it("persists successful health metadata without activating the proxy", async () => {
    proxyMocks.testProxyUrl.mockResolvedValue({
      ok: true,
      status: 204,
      statusText: "No Content",
      elapsedMs: 42,
    });

    const response = await POST(new Request("http://localhost/test", { method: "POST" }), context());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, latencyMs: 42, elapsedMs: 42 });
    expect(dbMocks.bulkUpdateProxyPoolHealth).toHaveBeenCalledWith([expect.objectContaining({
      id: "proxy-1",
      expectedProxyUrl: "socks5://alice:secret@proxy.test:1080",
      expectedUpdatedAt: "2026-08-10T00:00:00.000Z",
      testStatus: "active",
      lastError: null,
      latencyMs: 42,
      lastTestedAt: expect.any(String),
    })]);
    expect(dbMocks.bulkUpdateProxyPoolHealth.mock.calls[0][0][0]).not.toHaveProperty("isActive");
  });

  it("persists failed health metadata without deactivating the proxy", async () => {
    dbMocks.getProxyPoolById.mockResolvedValue({
      id: "proxy-1",
      type: "proxy",
      proxyUrl: "http://alice:secret@proxy.test:8080",
      isActive: true,
      updatedAt: "2026-08-10T00:00:00.000Z",
    });
    proxyMocks.testProxyUrl.mockResolvedValue({
      ok: false,
      status: 504,
      error: "Proxy test timed out",
      elapsedMs: 8000,
    });

    const response = await POST(new Request("http://localhost/test", { method: "POST" }), context());
    const body = await response.json();

    expect(body).toMatchObject({ ok: false, latencyMs: 8000, error: "Proxy test timed out" });
    expect(dbMocks.bulkUpdateProxyPoolHealth).toHaveBeenCalledWith([expect.objectContaining({
      id: "proxy-1",
      expectedProxyUrl: "http://alice:secret@proxy.test:8080",
      expectedUpdatedAt: "2026-08-10T00:00:00.000Z",
      testStatus: "error",
      lastError: "Proxy test timed out",
      latencyMs: 8000,
    })]);
    expect(dbMocks.bulkUpdateProxyPoolHealth.mock.calls[0][0][0]).not.toHaveProperty("isActive");
  });

  it("reports a stale result without overwriting an edited proxy", async () => {
    dbMocks.bulkUpdateProxyPoolHealth.mockResolvedValue(0);
    proxyMocks.testProxyUrl.mockResolvedValue({ ok: true, status: 204, elapsedMs: 20 });

    const response = await POST(new Request("http://localhost/test", { method: "POST" }), context());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, persisted: false });
  });

  it("retries a transient failure against the independent target and saves the recovered success", async () => {
    proxyMocks.testProxyUrl
      .mockResolvedValueOnce({
        ok: false,
        status: 504,
        error: "Proxy test timed out",
        elapsedMs: 8_000,
        retryable: true,
        proxyFailure: true,
        inconclusive: false,
      })
      .mockResolvedValueOnce({
        ok: true,
        targetOk: false,
        status: 404,
        elapsedMs: 37,
      });

    const response = await POST(new Request("http://localhost/test", { method: "POST" }), context());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, attempts: 2, latencyMs: 37, persisted: true });
    expect(proxyMocks.testProxyUrl.mock.calls[1][0]).toMatchObject({
      testUrl: "https://cloudflare.com/cdn-cgi/trace",
    });
    expect(dbMocks.bulkUpdateProxyPoolHealth).toHaveBeenCalledWith([expect.objectContaining({
      testStatus: "active",
      latencyMs: 37,
    })]);
  });

  it("preserves the previous health status when the checker is inconclusive", async () => {
    proxyMocks.testProxyUrl.mockResolvedValue({
      ok: false,
      status: 503,
      error: "local socket resources exhausted",
      elapsedMs: 2,
      retryable: false,
      proxyFailure: false,
      inconclusive: true,
      failureKind: "local-resource",
    });

    const response = await POST(new Request("http://localhost/test", { method: "POST" }), context());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: false,
      inconclusive: true,
      persisted: false,
      failureKind: "local-resource",
    });
    expect(dbMocks.bulkUpdateProxyPoolHealth).not.toHaveBeenCalled();
  });

  it("preserves the previous health when both server control targets are down", async () => {
    proxyMocks.testProxyUrl.mockResolvedValue({
      ok: false,
      status: 504,
      error: "Proxy test timed out",
      elapsedMs: 8_000,
      retryable: false,
      proxyFailure: true,
      inconclusive: false,
    });
    healthProbeMocks.checkHealthEnvironment.mockResolvedValue({
      ok: false,
      reachableTargets: 0,
      checkedTargets: 2,
    });

    const response = await POST(new Request("http://localhost/test", { method: "POST" }), context());
    const body = await response.json();

    expect(body).toMatchObject({
      ok: false,
      inconclusive: true,
      environmentHealthy: false,
      persisted: false,
    });
    expect(dbMocks.bulkUpdateProxyPoolHealth).not.toHaveBeenCalled();
  });

  it("uses the shared sentinel-validated relay checker", async () => {
    dbMocks.getProxyPoolById.mockResolvedValue({
      id: "proxy-1",
      type: "vercel",
      proxyUrl: "https://relay.test/health",
      isActive: true,
      updatedAt: "2026-08-10T00:00:00.000Z",
    });
    const response = await POST(new Request("http://localhost/test", { method: "POST" }), context());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, latencyMs: 18, persisted: true });
    expect(healthProbeMocks.testRelayUrl).toHaveBeenCalledWith({
      relayUrl: "https://relay.test/health",
    });
  });
});
