import { NextResponse } from "next/server";
import { createProxyPool, getProviderConnections, getProxyPools } from "@/models";
import { getProxyPoolsByIds, getProxyPoolsPage } from "@/lib/db/index.js";

function toBoolean(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

const VALID_PROXY_TYPES = ["http", "vercel", "cloudflare", "deno"];
const VALID_TEST_STATUSES = new Set(["active", "error", "unknown"]);
const PICKER_VIEW = "picker";

function normalizeProxyPoolInput(body = {}) {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const proxyUrl = typeof body?.proxyUrl === "string" ? body.proxyUrl.trim() : "";
  const noProxy = typeof body?.noProxy === "string" ? body.noProxy.trim() : "";
  const isActive = body?.isActive === undefined ? true : body.isActive === true;
  const strictProxy = body?.strictProxy === true;
  const type = VALID_PROXY_TYPES.includes(body?.type) ? body.type : "http";

  if (!name) {
    return { error: "Name is required" };
  }

  if (!proxyUrl) {
    return { error: "Proxy URL is required" };
  }

  return { name, proxyUrl, noProxy, isActive, strictProxy, type };
}

function buildUsageMap(connections = []) {
  const usageMap = new Map();

  for (const connection of connections) {
    const proxyPoolId = connection?.providerSpecificData?.proxyPoolId;
    if (!proxyPoolId) continue;

    usageMap.set(proxyPoolId, (usageMap.get(proxyPoolId) || 0) + 1);
  }

  return usageMap;
}

function toPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function withUsage(proxyPools, usageMap) {
  return proxyPools.map((pool) => ({
    ...pool,
    boundConnectionCount: usageMap.get(pool.id) || 0,
  }));
}

function toPickerPool(pool) {
  return {
    id: pool.id,
    name: pool.name,
    type: pool.type,
    isActive: pool.isActive === true,
    testStatus: pool.testStatus,
    latencyMs: Number.isFinite(pool.latencyMs) ? pool.latencyMs : null,
    lastTestedAt: pool.lastTestedAt || null,
  };
}

// GET /api/proxy-pools - List proxy pools
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const isActive = toBoolean(searchParams.get("isActive"));
    const includeUsage = searchParams.get("includeUsage") === "true";
    const view = searchParams.get("view");
    const pickerView = view === PICKER_VIEW;
    const paginate = pickerView || searchParams.has("page") || searchParams.has("pageSize");
    const healthIdsParam = searchParams.get("healthIds");

    if (healthIdsParam !== null) {
      const healthIds = [...new Set(
        healthIdsParam.split(",").map((id) => id.trim()).filter(Boolean)
      )];
      if (healthIds.length > 100) {
        return NextResponse.json(
          { error: "At most 100 visible proxy health records can be refreshed at once" },
          { status: 413 }
        );
      }
      const pools = healthIds.length > 0 ? await getProxyPoolsByIds(healthIds) : [];
      return NextResponse.json({
        health: pools.map((pool) => ({
          id: pool.id,
          testStatus: pool.testStatus,
          lastTestedAt: pool.lastTestedAt || null,
          lastError: pool.lastError || null,
          latencyMs: Number.isFinite(pool.latencyMs) ? pool.latencyMs : null,
        })),
      }, { headers: { "Cache-Control": "no-store" } });
    }

    const filter = {};
    if (pickerView) {
      // Picker results are always safe choices: administratively enabled and
      // backed by a conclusive successful health check.
      filter.isActive = true;
      filter.testStatus = "active";
    } else if (isActive !== undefined) {
      filter.isActive = isActive;
    }
    const requestedTestStatus = searchParams.get("testStatus");
    if (!pickerView && VALID_TEST_STATUSES.has(requestedTestStatus)) {
      filter.testStatus = requestedTestStatus;
    }
    const search = (searchParams.get("search") || "").trim().slice(0, 100);
    if (search) filter.search = search;

    if (paginate) {
      const result = await getProxyPoolsPage({
        filter,
        page: toPositiveInteger(searchParams.get("page"), 1),
        pageSize: toPositiveInteger(searchParams.get("pageSize"), 100),
        sort: searchParams.get("sort") || "active-first",
      });

      let proxyPools = pickerView
        ? result.proxyPools.map(toPickerPool)
        : result.proxyPools;
      if (includeUsage && !pickerView) {
        const connections = await getProviderConnections();
        proxyPools = withUsage(proxyPools, buildUsageMap(connections));
      }

      return NextResponse.json({
        proxyPools,
        pagination: {
          page: result.page,
          pageSize: result.pageSize,
          total: result.total,
          active: result.active,
          filteredTotal: result.filteredTotal,
          totalPages: result.totalPages,
        },
      }, { headers: { "Cache-Control": "no-store" } });
    }

    const proxyPools = await getProxyPools(filter);

    if (!includeUsage) {
      return NextResponse.json({ proxyPools });
    }

    const connections = await getProviderConnections();
    const usageMap = buildUsageMap(connections);

    const enrichedProxyPools = withUsage(proxyPools, usageMap);

    return NextResponse.json({ proxyPools: enrichedProxyPools });
  } catch (error) {
    console.log("Error fetching proxy pools:", error);
    return NextResponse.json({ error: "Failed to fetch proxy pools" }, { status: 500 });
  }
}

// POST /api/proxy-pools - Create proxy pool
export async function POST(request) {
  try {
    const body = await request.json();
    const normalized = normalizeProxyPoolInput(body);

    if (normalized.error) {
      return NextResponse.json({ error: normalized.error }, { status: 400 });
    }

    const proxyPool = await createProxyPool(normalized);
    return NextResponse.json({ proxyPool }, { status: 201 });
  } catch (error) {
    console.log("Error creating proxy pool:", error);
    return NextResponse.json({ error: "Failed to create proxy pool" }, { status: 500 });
  }
}
