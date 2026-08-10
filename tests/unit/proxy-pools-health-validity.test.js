import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  bulkUpdateProxyPoolHealth: vi.fn(),
  disableProxyPoolsFromHealthJob: vi.fn(),
  getProxyPools: vi.fn(),
  getProxyPoolsByIds: vi.fn(),
}));

const networkMocks = vi.hoisted(() => ({
  testProxyUrl: vi.fn(),
}));
const healthProbeMocks = vi.hoisted(() => ({
  checkHealthEnvironment: vi.fn(),
  testRelayUrl: vi.fn(),
}));

vi.mock("@/lib/db/index.js", () => dbMocks);
vi.mock("@/lib/network/proxyTest", () => networkMocks);
vi.mock("@/lib/network/healthProbe", () => healthProbeMocks);

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "content-type": "application/json", ...(init.headers || {}) },
      });
    },
  },
}));

const pool = {
  id: "health-validity-pool",
  name: "Health validity pool",
  proxyUrl: "http://user:secret@health-validity.test:8080",
  type: "http",
  isActive: true,
  updatedAt: "2026-08-10T01:00:00.000Z",
};

function makePost(body = { scope: "all", concurrency: 1 }) {
  return new Request("http://localhost/api/proxy-pools/batch-test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function waitForSnapshot(GET, jobId, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await GET(new Request(
      `http://localhost/api/proxy-pools/batch-test?jobId=${encodeURIComponent(jobId)}`
    ));
    const body = await response.json();
    if (predicate(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Health job ${jobId} did not reach the expected state within ${timeoutMs}ms`);
}

function waitForTerminal(GET, jobId) {
  return waitForSnapshot(
    GET,
    jobId,
    (body) => ["completed", "failed", "cancelled"].includes(body.status)
  );
}

async function waitUntil(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`);
}

function persistedUpdates() {
  return dbMocks.bulkUpdateProxyPoolHealth.mock.calls.flatMap(([updates]) => updates);
}

async function loadRoute() {
  return import("@/app/api/proxy-pools/batch-test/route.js");
}

beforeEach(() => {
  delete globalThis.__proxyPoolHealthJobStateV2;
  vi.resetModules();
  dbMocks.bulkUpdateProxyPoolHealth.mockReset().mockImplementation(async (updates) => updates.length);
  dbMocks.disableProxyPoolsFromHealthJob.mockReset().mockResolvedValue({
    disabled: 0,
    stale: 0,
    alreadyInactive: 0,
    missing: 0,
  });
  dbMocks.getProxyPools.mockReset().mockResolvedValue([pool]);
  dbMocks.getProxyPoolsByIds.mockReset().mockResolvedValue([]);
  networkMocks.testProxyUrl.mockReset();
  healthProbeMocks.checkHealthEnvironment.mockReset().mockResolvedValue({
    ok: true,
    reachableTargets: 2,
    checkedTargets: 2,
  });
  healthProbeMocks.testRelayUrl.mockReset().mockResolvedValue({
    ok: true,
    targetOk: true,
    status: 204,
    elapsedMs: 12,
  });
});

describe("complete health-check validity safeguards", () => {
  it("refuses to start when neither server control target is reachable", async () => {
    healthProbeMocks.checkHealthEnvironment.mockResolvedValue({
      ok: false,
      reachableTargets: 0,
      checkedTargets: 2,
    });
    const { POST } = await loadRoute();

    const response = await POST(makePost());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toMatch(/control targets are unreachable/i);
    expect(networkMocks.testProxyUrl).not.toHaveBeenCalled();
    expect(dbMocks.bulkUpdateProxyPoolHealth).not.toHaveBeenCalled();
  });

  it("reserves only one full job when two starts race through the async control check", async () => {
    let releaseControls;
    const controls = new Promise((resolve) => { releaseControls = resolve; });
    healthProbeMocks.checkHealthEnvironment.mockImplementation(() => controls.then(() => ({
      ok: true,
      reachableTargets: 2,
      checkedTargets: 2,
    })));
    networkMocks.testProxyUrl.mockResolvedValue({
      ok: true,
      targetOk: true,
      status: 204,
      elapsedMs: 8,
    });
    const { GET, POST } = await loadRoute();

    const firstPromise = POST(makePost());
    const secondPromise = POST(makePost());
    await waitUntil(() => healthProbeMocks.checkHealthEnvironment.mock.calls.length === 2);
    releaseControls();
    const responses = await Promise.all([firstPromise, secondPromise]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    const accepted = responses.findIndex((response) => response.status === 202);

    expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
    expect(dbMocks.getProxyPools).toHaveBeenCalledOnce();
    await waitForTerminal(GET, bodies[accepted].jobId);
  });

  it("retries one explicitly retryable timeout and persists only the recovered success", async () => {
    networkMocks.testProxyUrl
      .mockResolvedValueOnce({
        ok: false,
        status: 504,
        elapsedMs: 10_000,
        error: "Proxy test timed out",
        failureKind: "timeout",
        errorCode: "ETIMEDOUT",
        retryable: true,
        proxyFailure: true,
        inconclusive: false,
      })
      .mockResolvedValueOnce({
        ok: true,
        targetOk: true,
        status: 204,
        elapsedMs: 24,
        error: null,
      });
    const { GET, POST } = await loadRoute();

    const start = await (await POST(makePost())).json();
    const terminal = await waitForTerminal(GET, start.jobId);

    expect(networkMocks.testProxyUrl).toHaveBeenCalledTimes(2);
    expect(networkMocks.testProxyUrl.mock.calls[1][0]).toMatchObject({
      testUrl: "https://cloudflare.com/cdn-cgi/trace",
    });
    expect(terminal).toMatchObject({
      status: "completed",
      completed: 1,
      successful: 1,
      failed: 0,
      internalErrors: 0,
      persisted: 1,
      retried: 1,
      stats: { averageAttemptMs: 10024, retried: 1 },
    });
    expect(persistedUpdates()).toEqual([
      expect.objectContaining({
        id: pool.id,
        testStatus: "active",
        lastError: null,
        latencyMs: 24,
      }),
    ]);
  });

  it("marks one conclusive error only after its retryable timeout is exhausted", async () => {
    networkMocks.testProxyUrl.mockResolvedValue({
      ok: false,
      status: 504,
      elapsedMs: 10_000,
      error: "Proxy test timed out",
      failureKind: "timeout",
      errorCode: "ETIMEDOUT",
      retryable: true,
      proxyFailure: true,
      inconclusive: false,
    });
    const { GET, POST } = await loadRoute();

    const start = await (await POST(makePost())).json();
    const terminal = await waitForTerminal(GET, start.jobId);

    expect(networkMocks.testProxyUrl).toHaveBeenCalledTimes(2);
    expect(terminal).toMatchObject({
      status: "completed",
      completed: 1,
      successful: 0,
      failed: 1,
      canDisableFailed: true,
      persisted: 1,
    });
    expect(persistedUpdates()).toEqual([
      expect.objectContaining({
        id: pool.id,
        testStatus: "error",
        lastError: "Proxy test timed out",
      }),
    ]);
  });

  it("accepts a complete exchange as valid even when the target endpoint returns an error status", async () => {
    networkMocks.testProxyUrl.mockResolvedValue({
      ok: true,
      targetOk: false,
      status: 503,
      statusText: "Service Unavailable",
      elapsedMs: 31,
      error: null,
    });
    const { GET, POST } = await loadRoute();

    const start = await (await POST(makePost())).json();
    const terminal = await waitForTerminal(GET, start.jobId);

    expect(networkMocks.testProxyUrl).toHaveBeenCalledOnce();
    expect(terminal).toMatchObject({ successful: 1, failed: 0, persisted: 1 });
    expect(persistedUpdates()).toEqual([
      expect.objectContaining({ id: pool.id, testStatus: "active", lastError: null }),
    ]);
  });

  it("does not overwrite stored health for an inconclusive checker or local-infrastructure failure", async () => {
    networkMocks.testProxyUrl.mockResolvedValue({
      ok: false,
      status: 500,
      elapsedMs: 4,
      error: "local socket resources exhausted",
      failureKind: "local-resource",
      errorCode: "EMFILE",
      retryable: false,
      proxyFailure: false,
      inconclusive: true,
    });
    const { GET, POST } = await loadRoute();

    const start = await (await POST(makePost())).json();
    const terminal = await waitForTerminal(GET, start.jobId);

    expect(networkMocks.testProxyUrl).toHaveBeenCalledOnce();
    expect(terminal).toMatchObject({
      completed: 1,
      successful: 0,
      failed: 0,
      canDisableFailed: false,
      persisted: 0,
    });
    expect(dbMocks.bulkUpdateProxyPoolHealth).not.toHaveBeenCalled();
  });

  it("does not turn an unexpected checker exception into a proxy error", async () => {
    networkMocks.testProxyUrl.mockRejectedValue(new Error("checker dependency unavailable"));
    const { GET, POST } = await loadRoute();

    const start = await (await POST(makePost())).json();
    const terminal = await waitForTerminal(GET, start.jobId);

    expect(terminal).toMatchObject({
      completed: 1,
      successful: 0,
      failed: 0,
      internalErrors: 1,
      canDisableFailed: false,
      persisted: 0,
    });
    expect(dbMocks.bulkUpdateProxyPoolHealth).not.toHaveBeenCalled();
  });

  it("does not retry a conclusive nonretryable proxy failure", async () => {
    networkMocks.testProxyUrl.mockResolvedValue({
      ok: false,
      status: 407,
      elapsedMs: 12,
      error: "Proxy authentication required",
      failureKind: "proxy-auth",
      errorCode: "HTTP_407",
      retryable: false,
      proxyFailure: true,
      inconclusive: false,
    });
    const { GET, POST } = await loadRoute();

    const start = await (await POST(makePost())).json();
    const terminal = await waitForTerminal(GET, start.jobId);

    expect(networkMocks.testProxyUrl).toHaveBeenCalledOnce();
    expect(terminal).toMatchObject({ failed: 1, canDisableFailed: true, persisted: 1 });
    expect(persistedUpdates()).toEqual([
      expect.objectContaining({ id: pool.id, testStatus: "error" }),
    ]);
  });

  it("does not commit deferred failures when the final environment control fails", async () => {
    healthProbeMocks.checkHealthEnvironment
      .mockResolvedValueOnce({ ok: true, reachableTargets: 2, checkedTargets: 2 })
      .mockResolvedValueOnce({ ok: false, reachableTargets: 0, checkedTargets: 2 });
    networkMocks.testProxyUrl.mockResolvedValue({
      ok: false,
      status: 407,
      elapsedMs: 12,
      error: "Proxy authentication required",
      failureKind: "proxy-auth",
      retryable: false,
      proxyFailure: true,
      inconclusive: false,
    });
    const { GET, POST } = await loadRoute();

    const start = await (await POST(makePost())).json();
    const terminal = await waitForTerminal(GET, start.jobId);

    expect(terminal).toMatchObject({
      status: "failed",
      failed: 1,
      persisted: 0,
      canDisableFailed: false,
      environmentHealthy: false,
    });
    expect(terminal.error).toMatch(/control targets are unreachable/i);
    expect(dbMocks.bulkUpdateProxyPoolHealth).not.toHaveBeenCalled();
  });

  it("blocks disabling results produced by a legacy classifier version", async () => {
    globalThis.__proxyPoolHealthJobStateV2 = {
      activeJobId: null,
      jobs: new Map([["legacy-job", {
        id: "legacy-job",
        status: "completed",
        classificationVersion: 2,
        failed: 1,
      }]]),
    };
    const { POST } = await loadRoute();

    const response = await POST(makePost({ action: "disable-failed", jobId: "legacy-job" }));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatch(/legacy one-shot classifier/i);
    expect(dbMocks.disableProxyPoolsFromHealthJob).not.toHaveBeenCalled();
  });

  it("cancels an in-flight retry without persisting either attempt", async () => {
    let attempts = 0;
    networkMocks.testProxyUrl.mockImplementation(({ signal }) => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.resolve({
          ok: false,
          status: 504,
          elapsedMs: 10_000,
          error: "Proxy test timed out",
          failureKind: "timeout",
          errorCode: "ETIMEDOUT",
          retryable: true,
          proxyFailure: true,
          inconclusive: false,
        });
      }
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({
          ok: false,
          status: 499,
          elapsedMs: 1,
          cancelled: true,
          error: "Health check cancelled",
          failureKind: "cancelled",
          retryable: false,
          proxyFailure: false,
          inconclusive: true,
        }), { once: true });
      });
    });
    const { DELETE, GET, POST } = await loadRoute();

    const start = await (await POST(makePost())).json();
    await waitUntil(() => attempts === 2);
    await DELETE(new Request(
      `http://localhost/api/proxy-pools/batch-test?jobId=${encodeURIComponent(start.jobId)}`,
      { method: "DELETE" }
    ));
    const terminal = await waitForTerminal(GET, start.jobId);

    expect(terminal).toMatchObject({
      status: "cancelled",
      completed: 1,
      successful: 0,
      failed: 0,
      cancelled: 1,
      persisted: 0,
    });
    expect(dbMocks.bulkUpdateProxyPoolHealth).not.toHaveBeenCalled();
  });
});
