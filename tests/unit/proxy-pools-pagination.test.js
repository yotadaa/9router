import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const repositoryState = vi.hoisted(() => ({ adapter: null }));

vi.mock("@/lib/db/driver.js", () => ({
  getAdapter: vi.fn(async () => repositoryState.adapter),
}));

const routeMocks = vi.hoisted(() => ({
  createProxyPool: vi.fn(),
  getProviderConnections: vi.fn(),
  getProxyPools: vi.fn(),
  getProxyPoolsByIds: vi.fn(),
  getProxyPoolsPage: vi.fn(),
}));

vi.mock("@/models", () => ({
  createProxyPool: routeMocks.createProxyPool,
  getProviderConnections: routeMocks.getProviderConnections,
  getProxyPools: routeMocks.getProxyPools,
}));

vi.mock("@/lib/db/index.js", () => ({
  getProxyPoolsByIds: routeMocks.getProxyPoolsByIds,
  getProxyPoolsPage: routeMocks.getProxyPoolsPage,
}));

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

import { createBetterSqliteAdapter } from "@/lib/db/adapters/betterSqliteAdapter.js";
import { buildCreateTableSql, TABLES } from "@/lib/db/schema.js";
import {
  bulkCreateProxyPools,
  bulkUpdateProxyPoolHealth,
  disableProxyPoolsFromHealthJob,
  getProxyPoolById,
  getProxyPoolsPage,
  updateProxyPool,
} from "@/lib/db/repos/proxyPoolsRepo.js";
import { GET } from "@/app/api/proxy-pools/route.js";

let tempDir;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-proxy-pagination-"));
  repositoryState.adapter = createBetterSqliteAdapter(path.join(tempDir, "pagination.sqlite"));
  repositoryState.adapter.exec(buildCreateTableSql("proxyPools", TABLES.proxyPools));
  for (const indexSql of TABLES.proxyPools.indexes || []) {
    repositoryState.adapter.exec(indexSql);
  }
});

afterAll(() => {
  repositoryState.adapter?.close?.();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  routeMocks.createProxyPool.mockReset();
  routeMocks.getProviderConnections.mockReset().mockResolvedValue([]);
  routeMocks.getProxyPools.mockReset().mockResolvedValue([]);
  routeMocks.getProxyPoolsByIds.mockReset().mockResolvedValue([]);
  routeMocks.getProxyPoolsPage.mockReset();
});

describe("proxy pool repository pagination", () => {
  beforeAll(async () => {
    await bulkCreateProxyPools(Array.from({ length: 205 }, (_, index) => ({
      id: `pool-${String(index).padStart(3, "0")}`,
      name: `Proxy ${String(204 - index).padStart(3, "0")}`,
      proxyUrl: `http://proxy-${index}.test:8080`,
      isActive: index % 4 !== 0,
      testStatus: index % 3 === 0 ? "error" : "active",
    })));
  });

  it("returns bounded pages, clamps an oversized page and page size, and reports global counts", async () => {
    const result = await getProxyPoolsPage({
      page: 999,
      pageSize: 10_000,
      sort: "name-asc",
    });

    expect(result).toMatchObject({
      page: 3,
      pageSize: 100,
      total: 205,
      active: 153,
      filteredTotal: 205,
      totalPages: 3,
    });
    expect(result.proxyPools).toHaveLength(5);
    expect(result.proxyPools.map((pool) => pool.name)).toEqual([
      "Proxy 200",
      "Proxy 201",
      "Proxy 202",
      "Proxy 203",
      "Proxy 204",
    ]);
  });

  it("applies filters to page counts while retaining global total and active counts", async () => {
    const result = await getProxyPoolsPage({
      filter: { isActive: false },
      page: 0,
      pageSize: 20,
      sort: "name-desc",
    });

    expect(result).toMatchObject({
      page: 1,
      pageSize: 20,
      total: 205,
      active: 153,
      filteredTotal: 52,
      totalPages: 3,
    });
    expect(result.proxyPools).toHaveLength(20);
    expect(result.proxyPools.every((pool) => pool.isActive === false)).toBe(true);
    expect(result.proxyPools.map((pool) => pool.name)).toEqual(
      [...result.proxyPools.map((pool) => pool.name)].sort().reverse()
    );
  });

  it("sorts the complete dataset by latest health condition before pagination", async () => {
    const validFirst = await getProxyPoolsPage({
      page: 1,
      pageSize: 20,
      sort: "valid-first",
    });
    const errorsFirst = await getProxyPoolsPage({
      page: 1,
      pageSize: 20,
      sort: "errors-first",
    });

    expect(validFirst.proxyPools).toHaveLength(20);
    expect(validFirst.proxyPools.every((pool) => pool.testStatus === "active")).toBe(true);
    expect(errorsFirst.proxyPools).toHaveLength(20);
    expect(errorsFirst.proxyPools.every((pool) => pool.testStatus === "error")).toBe(true);
  });

  it("sorts measured valid proxies by latency and leaves unmeasured records behind them", async () => {
    const fast = await getProxyPoolById("pool-001");
    const slow = await getProxyPoolById("pool-002");
    const fastFailure = await getProxyPoolById("pool-003");
    await bulkUpdateProxyPoolHealth([
      {
        id: fast.id,
        expectedProxyUrl: fast.proxyUrl,
        expectedUpdatedAt: fast.updatedAt,
        testStatus: "active",
        lastTestedAt: "2026-08-10T00:01:00.000Z",
        lastError: null,
        latencyMs: 25,
      },
      {
        id: slow.id,
        expectedProxyUrl: slow.proxyUrl,
        expectedUpdatedAt: slow.updatedAt,
        testStatus: "active",
        lastTestedAt: "2026-08-10T00:02:00.000Z",
        lastError: null,
        latencyMs: 400,
      },
      {
        id: fastFailure.id,
        expectedProxyUrl: fastFailure.proxyUrl,
        expectedUpdatedAt: fastFailure.updatedAt,
        testStatus: "error",
        lastTestedAt: "2026-08-10T00:03:00.000Z",
        lastError: "connection refused",
        latencyMs: 5,
      },
    ]);

    const fastest = await getProxyPoolsPage({ page: 1, pageSize: 2, sort: "latency-asc" });
    const slowest = await getProxyPoolsPage({ page: 1, pageSize: 2, sort: "latency-desc" });

    expect(fastest.proxyPools.map((pool) => pool.id)).toEqual(["pool-001", "pool-002"]);
    expect(slowest.proxyPools.map((pool) => pool.id)).toEqual(["pool-002", "pool-001"]);
    expect(fastest.proxyPools.every((pool) => pool.testStatus === "active")).toBe(true);
  });

  it("searches names, IDs, and proxy addresses while treating wildcard characters literally", async () => {
    const byName = await getProxyPoolsPage({
      filter: { isActive: true, testStatus: "active", search: "proxy 203" },
      page: 1,
      pageSize: 20,
      sort: "latency-asc",
    });
    const byId = await getProxyPoolsPage({
      filter: { isActive: true, testStatus: "active", search: "POOL-002" },
      page: 1,
      pageSize: 20,
      sort: "name-asc",
    });
    const literalWildcard = await getProxyPoolsPage({
      filter: { search: "_" },
      page: 1,
      pageSize: 20,
    });
    const byAddress = await getProxyPoolsPage({
      filter: { isActive: true, testStatus: "active", search: "proxy-203.test" },
      page: 1,
      pageSize: 20,
    });

    expect(byName.proxyPools.map((pool) => pool.id)).toEqual(["pool-001"]);
    expect(byName.filteredTotal).toBe(1);
    expect(byId.proxyPools.map((pool) => pool.id)).toEqual(["pool-002"]);
    expect(byAddress.proxyPools.map((pool) => pool.id)).toEqual(["pool-203"]);
    expect(literalWildcard).toMatchObject({ filteredTotal: 0, proxyPools: [] });
  });

  it("does not change isActive during health persistence and requires a current confirmed failure to disable", async () => {
    await bulkCreateProxyPools([{
      id: "health-confirmation-guard",
      name: "Health confirmation guard",
      proxyUrl: "http://health-confirmation.test:8080",
      isActive: true,
    }]);
    const lastTestedAt = "2026-08-09T15:00:00.000Z";
    const beforeHealth = await getProxyPoolById("health-confirmation-guard");

    await bulkUpdateProxyPoolHealth([{
      id: "health-confirmation-guard",
      expectedProxyUrl: beforeHealth.proxyUrl,
      expectedUpdatedAt: beforeHealth.updatedAt,
      testStatus: "error",
      lastTestedAt,
      lastError: "connection refused",
      latencyMs: 13,
      isActive: false,
    }]);

    expect(await getProxyPoolById("health-confirmation-guard")).toMatchObject({
      isActive: true,
      testStatus: "error",
      lastTestedAt,
    });

    await expect(disableProxyPoolsFromHealthJob([{
      id: "health-confirmation-guard",
      lastTestedAt: "2026-08-09T14:59:59.000Z",
      expectedProxyUrl: beforeHealth.proxyUrl,
    }])).resolves.toEqual({
      disabled: 0,
      stale: 1,
      alreadyInactive: 0,
      missing: 0,
    });
    expect((await getProxyPoolById("health-confirmation-guard")).isActive).toBe(true);

    await expect(disableProxyPoolsFromHealthJob([{
      id: "health-confirmation-guard",
      lastTestedAt,
      expectedProxyUrl: beforeHealth.proxyUrl,
    }])).resolves.toEqual({
      disabled: 1,
      stale: 0,
      alreadyInactive: 0,
      missing: 0,
    });
    expect((await getProxyPoolById("health-confirmation-guard")).isActive).toBe(false);
  });

  it("rejects a health result when the proxy was edited or retested after its snapshot", async () => {
    await bulkCreateProxyPools([{
      id: "health-optimistic-guard",
      name: "Health optimistic guard",
      proxyUrl: "http://before-edit.test:8080",
      isActive: true,
    }]);
    const snapshot = await getProxyPoolById("health-optimistic-guard");

    await updateProxyPool("health-optimistic-guard", {
      proxyUrl: "http://after-edit.test:8080",
      testStatus: "active",
      lastTestedAt: "2026-08-09T16:00:00.000Z",
    });

    await expect(bulkUpdateProxyPoolHealth([{
      id: "health-optimistic-guard",
      expectedProxyUrl: snapshot.proxyUrl,
      expectedUpdatedAt: snapshot.updatedAt,
      testStatus: "error",
      lastTestedAt: "2026-08-09T15:00:00.000Z",
      lastError: "stale failure",
      latencyMs: 100,
    }])).resolves.toBe(0);

    expect(await getProxyPoolById("health-optimistic-guard")).toMatchObject({
      proxyUrl: "http://after-edit.test:8080",
      testStatus: "active",
      lastTestedAt: "2026-08-09T16:00:00.000Z",
    });
  });
});

describe("GET /api/proxy-pools pagination compatibility", () => {
  it("returns only bounded health fields for visible IDs without exposing proxy credentials", async () => {
    routeMocks.getProxyPoolsByIds.mockResolvedValue([
      {
        id: "visible-a",
        name: "Sensitive proxy name",
        proxyUrl: "http://alice:secret@proxy-a.test:8080",
        noProxy: "internal.test",
        isActive: true,
        testStatus: "active",
        lastTestedAt: "2026-08-10T01:00:00.000Z",
        lastError: null,
        latencyMs: 17,
      },
      {
        id: "visible-b",
        name: "Failed proxy",
        proxyUrl: "socks5://bob:password@proxy-b.test:1080",
        isActive: false,
        testStatus: "error",
        lastTestedAt: "2026-08-10T01:00:01.000Z",
        lastError: "connection refused",
        latencyMs: 42,
      },
    ]);

    const response = await GET(new Request(
      "http://localhost/api/proxy-pools?healthIds=visible-a,visible-a,visible-b"
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(routeMocks.getProxyPoolsByIds).toHaveBeenCalledWith(["visible-a", "visible-b"]);
    expect(routeMocks.getProxyPoolsPage).not.toHaveBeenCalled();
    expect(routeMocks.getProxyPools).not.toHaveBeenCalled();
    expect(routeMocks.getProviderConnections).not.toHaveBeenCalled();
    expect(body).toEqual({
      health: [
        {
          id: "visible-a",
          testStatus: "active",
          lastTestedAt: "2026-08-10T01:00:00.000Z",
          lastError: null,
          latencyMs: 17,
        },
        {
          id: "visible-b",
          testStatus: "error",
          lastTestedAt: "2026-08-10T01:00:01.000Z",
          lastError: "connection refused",
          latencyMs: 42,
        },
      ],
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("bob");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("proxy-a.test");
    expect(serialized).not.toContain("proxy-b.test");
  });

  it("accepts at most 100 visible health IDs and rejects larger refreshes before querying", async () => {
    const allowedIds = Array.from({ length: 100 }, (_, index) => `visible-${index}`);
    routeMocks.getProxyPoolsByIds.mockImplementation(async (ids) => ids.map((id) => ({
      id,
      testStatus: "unknown",
      lastTestedAt: null,
      lastError: null,
      latencyMs: null,
    })));

    const allowedResponse = await GET(new Request(
      `http://localhost/api/proxy-pools?healthIds=${allowedIds.join(",")}`
    ));
    const allowedBody = await allowedResponse.json();

    expect(allowedResponse.status).toBe(200);
    expect(routeMocks.getProxyPoolsByIds).toHaveBeenCalledWith(allowedIds);
    expect(allowedBody.health).toHaveLength(100);

    routeMocks.getProxyPoolsByIds.mockClear();
    const tooManyIds = [...allowedIds, "visible-100"];
    const rejectedResponse = await GET(new Request(
      `http://localhost/api/proxy-pools?healthIds=${tooManyIds.join(",")}`
    ));
    const rejectedBody = await rejectedResponse.json();

    expect(rejectedResponse.status).toBe(413);
    expect(rejectedBody.error).toContain("At most 100");
    expect(routeMocks.getProxyPoolsByIds).not.toHaveBeenCalled();
  });

  it("preserves the legacy unpaginated response when page parameters are absent", async () => {
    routeMocks.getProxyPools.mockResolvedValue([
      { id: "legacy-a", name: "A" },
      { id: "legacy-b", name: "B" },
    ]);
    routeMocks.getProviderConnections.mockResolvedValue([
      { providerSpecificData: { proxyPoolId: "legacy-a" } },
      { providerSpecificData: { proxyPoolId: "legacy-a" } },
    ]);

    const response = await GET(new Request(
      "http://localhost/api/proxy-pools?includeUsage=true"
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(routeMocks.getProxyPools).toHaveBeenCalledWith({});
    expect(routeMocks.getProxyPoolsPage).not.toHaveBeenCalled();
    expect(body).toEqual({
      proxyPools: [
        { id: "legacy-a", name: "A", boundConnectionCount: 2 },
        { id: "legacy-b", name: "B", boundConnectionCount: 0 },
      ],
    });
    expect(body).not.toHaveProperty("pagination");
  });

  it("uses the paginated repository only when requested and enriches just that page", async () => {
    routeMocks.getProxyPoolsPage.mockResolvedValue({
      proxyPools: [{ id: "page-pool", name: "Page pool" }],
      page: 2,
      pageSize: 25,
      total: 205,
      active: 153,
      filteredTotal: 153,
      totalPages: 7,
    });
    routeMocks.getProviderConnections.mockResolvedValue([
      { providerSpecificData: { proxyPoolId: "page-pool" } },
      { providerSpecificData: { proxyPoolId: "off-page-pool" } },
    ]);

    const response = await GET(new Request(
      "http://localhost/api/proxy-pools?page=2&pageSize=25&sort=name-asc&isActive=true&includeUsage=true"
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(routeMocks.getProxyPoolsPage).toHaveBeenCalledWith({
      filter: { isActive: true },
      page: 2,
      pageSize: 25,
      sort: "name-asc",
    });
    expect(routeMocks.getProxyPools).not.toHaveBeenCalled();
    expect(body).toEqual({
      proxyPools: [{
        id: "page-pool",
        name: "Page pool",
        boundConnectionCount: 1,
      }],
      pagination: {
        page: 2,
        pageSize: 25,
        total: 205,
        active: 153,
        filteredTotal: 153,
        totalPages: 7,
      },
    });
  });

  it("forces picker validity filters and returns only bounded credential-free fields", async () => {
    routeMocks.getProxyPoolsPage.mockResolvedValue({
      proxyPools: [{
        id: "fast-valid-pool",
        name: "Fast valid pool",
        type: "http",
        isActive: true,
        testStatus: "active",
        latencyMs: 18,
        lastTestedAt: "2026-08-10T02:00:00.000Z",
        proxyUrl: "http://alice:secret@fast-valid.test:8080",
        noProxy: "localhost",
      }],
      page: 2,
      pageSize: 20,
      total: 40_000,
      active: 39_000,
      filteredTotal: 21,
      totalPages: 2,
    });

    const response = await GET(new Request(
      "http://localhost/api/proxy-pools?view=picker&page=2&pageSize=20&search=fast&sort=latency-asc&isActive=false&testStatus=error&includeUsage=true"
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(routeMocks.getProxyPoolsPage).toHaveBeenCalledWith({
      filter: { isActive: true, testStatus: "active", search: "fast" },
      page: 2,
      pageSize: 20,
      sort: "latency-asc",
    });
    expect(routeMocks.getProviderConnections).not.toHaveBeenCalled();
    expect(body.proxyPools).toEqual([{
      id: "fast-valid-pool",
      name: "Fast valid pool",
      type: "http",
      isActive: true,
      testStatus: "active",
      latencyMs: 18,
      lastTestedAt: "2026-08-10T02:00:00.000Z",
    }]);
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(JSON.stringify(body)).not.toContain("proxyUrl");
    expect(body.pagination).toMatchObject({ page: 2, pageSize: 20, filteredTotal: 21 });
  });
});
