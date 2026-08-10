import { NextResponse } from "next/server";
import { bulkUpdateProxyPoolHealth, getProxyPoolById } from "@/models";
import { testProxyUrl } from "@/lib/network/proxyTest";
import { checkHealthEnvironment, testRelayUrl } from "@/lib/network/healthProbe";

const RETRY_TEST_URL = "https://cloudflare.com/cdn-cgi/trace";
const TRANSIENT_RETRY_DELAY_MS = 100;

async function testWithConfirmation(runAttempt) {
  const results = [];
  let result = await runAttempt();
  results.push(result);

  if (result?.ok !== true && result?.retryable === true && !result?.cancelled) {
    await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS));
    result = await runAttempt(RETRY_TEST_URL);
    results.push(result);
  }

  if (result?.ok !== true && results.some((attempt) => (
    attempt?.inconclusive === true || attempt?.proxyFailure === false
  ))) {
    result = { ...result, inconclusive: true, proxyFailure: false };
  }

  return {
    result,
    attempts: results.length,
    totalElapsedMs: results.reduce(
      (total, attempt) => total + Math.max(0, Number(attempt?.elapsedMs) || 0),
      0
    ),
  };
}

function testStandardProxyWithConfirmation(proxyUrl) {
  return testWithConfirmation((testUrl) => testProxyUrl({
    proxyUrl,
    ...(testUrl ? { testUrl } : {}),
  }));
}

function testRelayWithConfirmation(relayUrl) {
  return testWithConfirmation((testUrl) => testRelayUrl({
    relayUrl,
    ...(testUrl ? { testUrl } : {}),
  }));
}

// POST /api/proxy-pools/[id]/test - Test proxy pool entry
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const proxyPool = await getProxyPoolById(id);

    if (!proxyPool) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    const startTime = Date.now();
    const isRelay = proxyPool.type === "vercel"
      || proxyPool.type === "cloudflare"
      || proxyPool.type === "deno";
    const checked = isRelay
      ? await testRelayWithConfirmation(proxyPool.proxyUrl)
      : await testStandardProxyWithConfirmation(proxyPool.proxyUrl);
    const result = checked.result;
    const measuredLatencyMs = Date.now() - startTime;
    const latencyMs = result.ok && Number.isFinite(result.elapsedMs)
      ? result.elapsedMs
      : Math.max(checked.totalElapsedMs, measuredLatencyMs);
    let inconclusive = result.ok !== true && (
      result?.inconclusive === true || result?.proxyFailure === false
    );
    let environmentHealthy = true;
    if (result.ok !== true && !inconclusive) {
      const environment = await checkHealthEnvironment().catch(() => ({ ok: false }));
      environmentHealthy = environment.ok === true;
      if (!environmentHealthy) inconclusive = true;
    }

    const now = new Date().toISOString();

    const persisted = inconclusive ? 0 : await bulkUpdateProxyPoolHealth([{
      id,
      expectedProxyUrl: proxyPool.proxyUrl,
      expectedUpdatedAt: proxyPool.updatedAt,
      testStatus: result.ok ? "active" : "error",
      lastTestedAt: now,
      lastError: result.ok ? null : (result.error || `Proxy test failed with status ${result.status}`),
      latencyMs,
    }]);

    return NextResponse.json({
      ok: result.ok,
      status: result.status,
      statusText: result.statusText || null,
      error: result.error || null,
      elapsedMs: latencyMs,
      latencyMs,
      attempts: checked.attempts,
      targetOk: result.targetOk ?? null,
      inconclusive,
      environmentHealthy,
      failureKind: result.failureKind || null,
      testedAt: now,
      persisted: persisted === 1,
    });
  } catch {
    // Avoid logging an exception that might contain a credential-bearing proxy URL.
    console.error("Error testing proxy pool");
    return NextResponse.json({ error: "Failed to test proxy pool" }, { status: 500 });
  }
}
