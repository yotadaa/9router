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

function makePost(body) {
  return new Request("http://localhost/api/proxy-pools/batch-test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makePools(count, prefix = "pool") {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    name: `${prefix} ${index}`,
    proxyUrl: `http://user:secret@${prefix}-${index}.test:8080`,
    type: "http",
    isActive: true,
    updatedAt: `2026-08-09T10:00:${String(index).padStart(2, "0")}.000Z`,
  }));
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

async function waitForTerminal(GET, jobId) {
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
  dbMocks.getProxyPools.mockReset().mockResolvedValue([]);
  dbMocks.getProxyPoolsByIds.mockReset().mockResolvedValue([]);
  networkMocks.testProxyUrl.mockReset().mockResolvedValue({
    ok: true,
    status: 200,
    elapsedMs: 12,
    error: null,
  });
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

describe("server-side proxy health jobs", () => {
  it("loads scope all on the server, clamps concurrency, and returns compact snapshots", async () => {
    const pools = makePools(80, "all-scope");
    dbMocks.getProxyPools.mockResolvedValue(pools);
    const { GET, POST } = await loadRoute();

    const startResponse = await POST(makePost({
      scope: "all",
      poolIds: ["browser-must-not-drive-all-scope"],
      concurrency: 999,
    }));
    const start = await startResponse.json();

    expect(startResponse.status).toBe(202);
    expect(start).toMatchObject({
      jobId: expect.any(String),
      scope: "all",
      total: 80,
      concurrency: 64,
    });
    expect(dbMocks.getProxyPools).toHaveBeenCalledTimes(1);
    expect(dbMocks.getProxyPoolsByIds).not.toHaveBeenCalled();
    expect(start).not.toHaveProperty("results");
    expect(start).not.toHaveProperty("failedIds");
    expect(start).not.toHaveProperty("failedById");

    const completed = await waitForTerminal(GET, start.jobId);
    expect(completed).toMatchObject({
      status: "completed",
      total: 80,
      completed: 80,
      successful: 80,
      failed: 0,
      concurrency: 64,
      stats: {
        total: 80,
        successful: 80,
        failed: 0,
        concurrency: 64,
      },
    });
    expect(completed).not.toHaveProperty("results");
    expect(completed).not.toHaveProperty("failedIds");
    expect(completed).not.toHaveProperty("failedById");
    expect(JSON.stringify(completed)).not.toContain("secret");
    expect(JSON.stringify(completed)).not.toContain("all-scope-0.test");
  });

  it("falls back to finite server concurrency for a non-finite request", async () => {
    dbMocks.getProxyPools.mockResolvedValue(makePools(15, "finite"));
    const { GET, POST } = await loadRoute();

    const response = await POST(makePost({ scope: "all", concurrency: "Infinity" }));
    const start = await response.json();

    expect(response.status).toBe(202);
    expect(start.concurrency).toBe(10);
    expect(Number.isFinite(start.concurrency)).toBe(true);
    await waitForTerminal(GET, start.jobId);
  });

  it("tests inactive records during an explicit complete check and returns only aggregate latency stats", async () => {
    const pools = [
      {
        ...makePools(1, "active-reachable")[0],
        proxyUrl: "http://user:secret@active-reachable.test:8080",
      },
      {
        ...makePools(1, "inactive-reachable")[0],
        proxyUrl: "http://user:secret@inactive-reachable.test:8080",
        isActive: false,
      },
      {
        ...makePools(1, "inactive-failed")[0],
        proxyUrl: "http://user:secret@inactive-failed.test:8080",
        isActive: false,
      },
    ];
    dbMocks.getProxyPools.mockResolvedValue(pools);
    networkMocks.testProxyUrl.mockImplementation(async ({ proxyUrl }) => {
      if (proxyUrl.includes("inactive-failed")) {
        return { ok: false, status: 500, elapsedMs: 50, error: "connection refused" };
      }
      return {
        ok: true,
        status: 200,
        elapsedMs: proxyUrl.includes("inactive-reachable") ? 30 : 10,
        error: null,
      };
    });
    const { GET, POST } = await loadRoute();

    const startResponse = await POST(makePost({
      scope: "all",
      includeInactive: true,
      concurrency: 1,
    }));
    const start = await startResponse.json();
    const completed = await waitForTerminal(GET, start.jobId);

    expect(startResponse.status).toBe(202);
    expect(dbMocks.getProxyPools).toHaveBeenCalledTimes(1);
    expect(networkMocks.testProxyUrl).toHaveBeenCalledTimes(3);
    expect(networkMocks.testProxyUrl.mock.calls.map(([options]) => options.proxyUrl))
      .toEqual(expect.arrayContaining(pools.map((pool) => pool.proxyUrl)));

    expect(completed).toMatchObject({
      status: "completed",
      total: 3,
      completed: 3,
      successful: 2,
      failed: 1,
      skipped: 0,
      concurrency: 3,
      stats: {
        total: 3,
        successful: 2,
        failed: 1,
        skipped: 0,
        concurrency: 3,
        averageLatencyMs: 20,
        minLatencyMs: 10,
        maxLatencyMs: 30,
        totalLatencyMs: 40,
      },
    });

    const persistedUpdates = dbMocks.bulkUpdateProxyPoolHealth.mock.calls.flatMap(
      ([updates]) => updates
    );
    expect(persistedUpdates).toHaveLength(3);
    expect(persistedUpdates.map((update) => update.id)).toEqual(expect.arrayContaining([
      "active-reachable-0",
      "inactive-reachable-0",
      "inactive-failed-0",
    ]));

    for (const aggregate of [start, completed]) {
      expect(aggregate).not.toHaveProperty("results");
      expect(aggregate).not.toHaveProperty("failedIds");
      expect(aggregate).not.toHaveProperty("failedById");
      expect(JSON.stringify(aggregate)).not.toContain("secret");
      expect(JSON.stringify(aggregate)).not.toContain("reachable.test");
      expect(JSON.stringify(aggregate)).not.toContain("failed.test");
    }
  });

  it("time-flushes valid results while deferring failures until the environment is confirmed", async () => {
    const pools = makePools(10, "timed-flush");
    dbMocks.getProxyPools.mockResolvedValue(pools);
    let callIndex = 0;
    let releaseHeldChecks;
    const heldChecks = new Promise((resolve) => { releaseHeldChecks = resolve; });
    const earlyResults = [
      { ok: true, status: 200, elapsedMs: 10, error: null },
      { ok: false, status: 500, elapsedMs: 20, error: "connection refused" },
      { ok: false, status: 504, elapsedMs: 30, error: "Proxy test timed out" },
      { ok: true, status: 200, elapsedMs: 40, error: null },
      { ok: true, status: 200, elapsedMs: 50, error: null },
    ];
    networkMocks.testProxyUrl.mockImplementation(async () => {
      const index = callIndex;
      callIndex += 1;
      if (index < earlyResults.length) return earlyResults[index];
      await heldChecks;
      return { ok: true, status: 200, elapsedMs: 60, error: null };
    });
    const { GET, POST } = await loadRoute();

    const startResponse = await POST(makePost({ scope: "all", concurrency: 10 }));
    const start = await startResponse.json();
    await waitUntil(() => callIndex === 10);
    // Do not poll GET here: GET intentionally checkpoints pending writes too.
    // Observing the DB mock directly proves the interval persisted the three
    // conclusive successes while failures stayed deferred and five checks held.
    await waitUntil(() => (
      dbMocks.bulkUpdateProxyPoolHealth.mock.calls
        .flatMap(([updates]) => updates)
        .length === 3
    ));
    const liveWriteBatches = dbMocks.bulkUpdateProxyPoolHealth.mock.calls.map(
      ([updates]) => [...updates]
    );
    const liveResponse = await GET(new Request(
      `http://localhost/api/proxy-pools/batch-test?jobId=${encodeURIComponent(start.jobId)}`
    ));
    const live = await liveResponse.json();
    releaseHeldChecks();
    const completed = await waitForTerminal(GET, start.jobId);

    expect(startResponse.status).toBe(202);
    expect(liveWriteBatches.flat()).toHaveLength(3);
    expect(liveWriteBatches.every((batch) => batch.length < 100)).toBe(true);
    expect(live).toMatchObject({
      status: "running",
      total: 10,
      completed: 5,
      successful: 3,
      failed: 2,
      timedOut: 1,
      persisted: 3,
      queuedForPersistence: 0,
      persistenceRevision: 1,
      lastPersistedAt: expect.any(String),
      currentRatePerSecond: expect.any(Number),
      stats: {
        completed: 5,
        successful: 3,
        failed: 2,
        timedOut: 1,
        averageLatencyMs: 33,
        averageAttemptMs: 30,
        minLatencyMs: 10,
        maxLatencyMs: 50,
        currentRatePerSecond: expect.any(Number),
        writeDurationMs: expect.any(Number),
      },
    });
    expect(live.currentRatePerSecond).toBeGreaterThan(0);
    expect(live.stats.currentRatePerSecond).toBeGreaterThan(0);
    expect(completed).toMatchObject({
      status: "completed",
      total: 10,
      completed: 10,
      successful: 8,
      failed: 2,
      timedOut: 1,
      persisted: 10,
    });
    expect(completed.persistenceRevision).toBeGreaterThan(live.persistenceRevision);

    for (const aggregate of [live, completed]) {
      expect(aggregate).not.toHaveProperty("results");
      expect(aggregate).not.toHaveProperty("failedIds");
      expect(aggregate).not.toHaveProperty("failedById");
      expect(JSON.stringify(aggregate)).not.toContain("secret");
      expect(JSON.stringify(aggregate)).not.toContain("timed-flush-0.test");
    }
  });

  it("uses full server worker capacity for a complete check even when lower concurrency is requested", async () => {
    const pools = makePools(80, "parallel-complete");
    dbMocks.getProxyPools.mockResolvedValue(pools);
    let inFlight = 0;
    let peakInFlight = 0;
    let started = 0;
    let releaseWorkers;
    const workerGate = new Promise((resolve) => { releaseWorkers = resolve; });
    networkMocks.testProxyUrl.mockImplementation(async () => {
      inFlight += 1;
      started += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      if (started === 64) releaseWorkers();
      await workerGate;
      inFlight -= 1;
      return { ok: true, status: 200, elapsedMs: 5, error: null };
    });
    const { GET, POST } = await loadRoute();

    const startResponse = await POST(makePost({
      scope: "all",
      includeInactive: true,
      concurrency: 1,
    }));
    const start = await startResponse.json();
    const completed = await waitForTerminal(GET, start.jobId);

    expect(start).toMatchObject({ total: 80, concurrency: 64 });
    expect(completed).toMatchObject({
      status: "completed",
      total: 80,
      successful: 80,
      concurrency: 64,
    });
    expect(peakInFlight).toBe(64);
  });

  it("stops a running server job, aborts in-flight checks, and keeps saved work", async () => {
    dbMocks.getProxyPools.mockResolvedValue(makePools(100, "stoppable"));
    let started = 0;
    networkMocks.testProxyUrl.mockImplementation(({ signal }) => new Promise((resolve) => {
      started += 1;
      signal.addEventListener("abort", () => resolve({
        ok: false,
        cancelled: true,
        elapsedMs: 1,
        error: "cancelled",
      }), { once: true });
    }));
    const { DELETE, GET, POST } = await loadRoute();

    const startResponse = await POST(makePost({ scope: "all", concurrency: 64 }));
    const start = await startResponse.json();
    await waitUntil(() => started === 64);

    const stopResponse = await DELETE(new Request(
      `http://localhost/api/proxy-pools/batch-test?jobId=${encodeURIComponent(start.jobId)}`,
      { method: "DELETE" }
    ));
    const stopping = await stopResponse.json();
    const terminal = await waitForTerminal(GET, start.jobId);

    expect(stopResponse.status).toBe(202);
    expect(stopping.status).toBe("cancelling");
    expect(terminal).toMatchObject({
      status: "cancelled",
      total: 100,
      completed: 64,
      cancelled: 64,
      persisted: 0,
    });
    expect(started).toBe(64);
    expect(dbMocks.bulkUpdateProxyPoolHealth).not.toHaveBeenCalled();
  });

  it("persists health only, keeps failures private, and disables them only after confirmation", async () => {
    const pools = [
      ...makePools(1, "healthy"),
      ...makePools(1, "failed"),
    ];
    dbMocks.getProxyPools.mockResolvedValue(pools);
    networkMocks.testProxyUrl.mockImplementation(async ({ proxyUrl }) => (
      proxyUrl.includes("failed-")
        ? { ok: false, status: 500, elapsedMs: 27, error: "connection refused" }
        : { ok: true, status: 200, elapsedMs: 9, error: null }
    ));
    dbMocks.disableProxyPoolsFromHealthJob.mockResolvedValue({
      disabled: 1,
      stale: 0,
      alreadyInactive: 0,
      missing: 0,
    });
    const { GET, POST } = await loadRoute();

    const startResponse = await POST(makePost({ scope: "all", concurrency: 2 }));
    const start = await startResponse.json();
    const completed = await waitForTerminal(GET, start.jobId);

    expect(completed).toMatchObject({
      status: "completed",
      successful: 1,
      failed: 1,
      canDisableFailed: true,
    });
    expect(completed).not.toHaveProperty("results");
    expect(completed).not.toHaveProperty("failedIds");
    expect(dbMocks.disableProxyPoolsFromHealthJob).not.toHaveBeenCalled();

    const persistedUpdates = dbMocks.bulkUpdateProxyPoolHealth.mock.calls.flatMap(
      ([updates]) => updates
    );
    expect(persistedUpdates).toHaveLength(2);
    expect(persistedUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "healthy-0", testStatus: "active" }),
      expect.objectContaining({ id: "failed-0", testStatus: "error" }),
    ]));
    expect(persistedUpdates.every((update) => !("isActive" in update))).toBe(true);

    const disableResponse = await POST(makePost({
      action: "disable-failed",
      jobId: start.jobId,
    }));
    const disableBody = await disableResponse.json();

    expect(disableResponse.status).toBe(200);
    expect(dbMocks.disableProxyPoolsFromHealthJob).toHaveBeenCalledTimes(1);
    expect(dbMocks.disableProxyPoolsFromHealthJob).toHaveBeenCalledWith([
      {
        id: "failed-0",
        lastTestedAt: expect.any(String),
        expectedProxyUrl: pools[1].proxyUrl,
      },
    ]);
    expect(disableBody).toMatchObject({
      success: true,
      jobId: start.jobId,
      disabled: 1,
      stale: 0,
    });
    expect(disableBody).not.toHaveProperty("failedIds");
  });
});
