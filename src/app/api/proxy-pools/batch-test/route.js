import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  bulkUpdateProxyPoolHealth,
  disableProxyPoolsFromHealthJob,
  getProxyPools,
  getProxyPoolsByIds,
} from "@/lib/db/index.js";
import { testProxyUrl } from "@/lib/network/proxyTest";
import { checkHealthEnvironment, testRelayUrl } from "@/lib/network/healthProbe";

const DEFAULT_CONCURRENCY = 10;
const MAX_CONCURRENCY = 64;
const MAX_STARTS_PER_SECOND = 25;
const MAX_SELECTED_IDS = 5_000;
const TEST_TIMEOUT_MS = 10_000;
const MAX_TEST_ATTEMPTS = 2;
const TRANSIENT_RETRY_DELAY_MS = 100;
const RETRY_TEST_URL = "https://cloudflare.com/cdn-cgi/trace";
const HEALTH_CLASSIFICATION_VERSION = 4;
const HEALTH_WRITE_BATCH_SIZE = 100;
const HEALTH_WRITE_FLUSH_INTERVAL_MS = 500;
const ENVIRONMENT_FAILURE_RECHECK_THRESHOLD = 256;
const RATE_WINDOW_MS = 15_000;
const COMPLETED_JOB_TTL_MS = 30 * 60 * 1_000;
const RUNNING_STATUSES = new Set(["loading", "queued", "running", "cancelling"]);
const RELAY_TYPES = new Set(["vercel", "cloudflare", "deno"]);

const healthState = globalThis.__proxyPoolHealthJobStateV2
  || (globalThis.__proxyPoolHealthJobStateV2 = {
    jobs: new Map(),
    activeJobId: null,
  });

// Hot reload keeps the in-memory job object and its old worker closure alive.
// Quarantine an older one-shot classifier immediately so it cannot keep
// writing ambiguous failures or later expose them to the disable action.
const legacyActiveJob = healthState.activeJobId
  ? healthState.jobs.get(healthState.activeJobId)
  : null;
if (
  legacyActiveJob
  && RUNNING_STATUSES.has(legacyActiveJob.status)
  && legacyActiveJob.classificationVersion !== HEALTH_CLASSIFICATION_VERSION
) {
  legacyActiveJob.cancelRequested = true;
  legacyActiveJob.status = "cancelling";
  legacyActiveJob.error = "Legacy one-shot health check stopped after classifier upgrade";
  if (Array.isArray(legacyActiveJob.pendingWrites)) legacyActiveJob.pendingWrites.length = 0;
  if (Array.isArray(legacyActiveJob.pendingFailureWrites)) {
    legacyActiveJob.pendingFailureWrites.length = 0;
  }
  legacyActiveJob.failedById?.clear?.();
  for (const controller of legacyActiveJob.controllers || []) controller.abort?.();
}

function sanitizeConcurrency(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_CONCURRENCY;
  return Math.max(1, Math.min(Math.floor(parsed), MAX_CONCURRENCY));
}

function sanitizeError(value, fallback = "Health check failed") {
  const message = typeof value === "string" && value.trim() ? value.trim() : fallback;
  return message
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+)@/gi, "$1***@")
    .slice(0, 500);
}

function pruneJobs() {
  const cutoff = Date.now() - COMPLETED_JOB_TTL_MS;
  for (const [jobId, job] of healthState.jobs) {
    if (RUNNING_STATUSES.has(job.status)) continue;
    if ((job.finishedAtMs || job.createdAtMs) < cutoff) {
      healthState.jobs.delete(jobId);
    }
  }
}

function getActiveJob() {
  if (!healthState.activeJobId) return null;
  const job = healthState.jobs.get(healthState.activeJobId);
  if (!job || !RUNNING_STATUSES.has(job.status)) {
    healthState.activeJobId = null;
    return null;
  }
  return job;
}

function buildJob({ scope, concurrency, includeInactive = false }) {
  const createdAtMs = Date.now();
  return {
    id: randomUUID(),
    scope,
    includeInactive,
    concurrency,
    classificationVersion: HEALTH_CLASSIFICATION_VERSION,
    maxStartsPerSecond: MAX_STARTS_PER_SECOND,
    status: "loading",
    createdAtMs,
    startedAtMs: null,
    finishedAtMs: null,
    total: 0,
    completed: 0,
    successful: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    internalErrors: 0,
    retried: 0,
    missing: 0,
    latencyTotalMs: 0,
    attemptDurationTotalMs: 0,
    minLatencyMs: null,
    maxLatencyMs: null,
    timedOut: 0,
    inFlight: 0,
    recentCompletionTimes: [],
    recentCompletionHead: 0,
    failedById: new Map(),
    pendingFailureWrites: [],
    pendingWrites: [],
    writeChain: Promise.resolve(),
    writeQueueDepth: 0,
    writeDurationMs: 0,
    persisted: 0,
    persistenceRevision: 0,
    lastPersistedAt: null,
    persistenceErrors: 0,
    controllers: new Set(),
    environmentHealthy: true,
    environmentChecks: 1,
    failuresSinceEnvironmentCheck: 0,
    environmentCheckPromise: null,
    cancelRequested: false,
    disableSummary: null,
    disableInProgress: false,
    error: null,
  };
}

function ensureJobTelemetry(job) {
  if (!Array.isArray(job.recentCompletionTimes)) job.recentCompletionTimes = [];
  if (!Number.isInteger(job.recentCompletionHead)
    || job.recentCompletionHead < 0
    || job.recentCompletionHead > job.recentCompletionTimes.length) {
    job.recentCompletionHead = 0;
  }
  if (!Number.isFinite(job.attemptDurationTotalMs)) job.attemptDurationTotalMs = 0;
  if (!Number.isFinite(job.timedOut)) job.timedOut = 0;
  if (!Number.isFinite(job.inFlight)) job.inFlight = 0;
  if (!Number.isFinite(job.writeQueueDepth)) job.writeQueueDepth = 0;
  if (!Number.isFinite(job.writeDurationMs)) job.writeDurationMs = 0;
  if (!Number.isFinite(job.persistenceRevision)) job.persistenceRevision = 0;
  if (!Number.isFinite(job.persisted)) {
    job.persisted = Math.max(
      0,
      Number(job.completed || 0)
        - Number(job.pendingWrites?.length || 0)
        - Number(job.persistenceErrors || 0)
    );
  }
  if (job.lastPersistedAt === undefined) job.lastPersistedAt = null;
}

function pruneRecentCompletions(job, nowMs) {
  ensureJobTelemetry(job);
  const cutoff = nowMs - RATE_WINDOW_MS;
  const times = job.recentCompletionTimes;
  let head = job.recentCompletionHead;

  // Advancing an index is O(n) across the lifetime of the queue. Array.shift()
  // would copy the remaining array for every expired item and can freeze a
  // large, browser-disconnected job when it is polled again.
  while (head < times.length && times[head] < cutoff) head += 1;

  if (head > 1_024 || head > times.length / 2) {
    job.recentCompletionTimes = times.slice(head);
    job.recentCompletionHead = 0;
  } else {
    job.recentCompletionHead = head;
  }

  return job.recentCompletionTimes.length - job.recentCompletionHead;
}

function getRecentRate(job, nowMs) {
  const recentCount = pruneRecentCompletions(job, nowMs);
  const elapsedMs = job.startedAtMs
    ? Math.max(1_000, Math.min(RATE_WINDOW_MS, nowMs - job.startedAtMs))
    : RATE_WINDOW_MS;
  return Number((recentCount / (elapsedMs / 1_000)).toFixed(1));
}

function snapshotJob(job) {
  const telemetryAvailable = Number.isFinite(job.maxStartsPerSecond);
  ensureJobTelemetry(job);
  const endedAtMs = job.finishedAtMs || Date.now();
  const durationMs = job.startedAtMs ? Math.max(0, endedAtMs - job.startedAtMs) : 0;
  const averageLatencyMs = job.successful > 0
    ? Math.round(job.latencyTotalMs / job.successful)
    : null;
  const attempted = job.successful + job.failed + job.internalErrors;
  const classificationReliable = job.classificationVersion === HEALTH_CLASSIFICATION_VERSION
    && job.environmentHealthy !== false;
  const averageAttemptMs = telemetryAvailable && attempted > 0
    ? Math.round(job.attemptDurationTotalMs / attempted)
    : null;
  const currentRatePerSecond = getRecentRate(job, endedAtMs);
  const remaining = Math.max(0, job.total - job.completed);
  const estimatedRemainingMs = currentRatePerSecond > 0
    ? Math.round((remaining / currentRatePerSecond) * 1_000)
    : null;

  return {
    jobId: job.id,
    status: job.status,
    scope: job.scope,
    includeInactive: job.includeInactive,
    total: job.total,
    completed: job.completed,
    successful: job.successful,
    failed: job.failed,
    skipped: job.skipped,
    cancelled: job.cancelled,
    internalErrors: job.internalErrors,
    retried: Number(job.retried) || 0,
    persistenceErrors: job.persistenceErrors,
    missing: job.missing,
    concurrency: job.concurrency,
    telemetryAvailable,
    maxStartsPerSecond: job.maxStartsPerSecond || MAX_STARTS_PER_SECOND,
    inFlight: telemetryAvailable ? job.inFlight : null,
    timedOut: telemetryAvailable ? job.timedOut : null,
    currentRatePerSecond,
    estimatedRemainingMs,
    persisted: job.persisted,
    queuedForPersistence: job.pendingWrites.length + job.writeQueueDepth,
    persistenceRevision: job.persistenceRevision,
    lastPersistedAt: job.lastPersistedAt,
    durationMs,
    progressPercent: job.total > 0
      ? Math.min(100, Math.round((job.completed / job.total) * 100))
      : 0,
    classificationReliable,
    environmentHealthy: job.environmentHealthy !== false,
    environmentChecks: Number(job.environmentChecks) || 0,
    canDisableFailed: classificationReliable
      && job.status === "completed"
      && job.failed > 0
      && !job.disableSummary,
    disableSummary: job.disableSummary,
    error: job.error,
    stats: {
      total: job.total,
      completed: job.completed,
      successful: job.successful,
      failed: job.failed,
      skipped: job.skipped,
      cancelled: job.cancelled,
      internalErrors: job.internalErrors,
      retried: Number(job.retried) || 0,
      persistenceErrors: job.persistenceErrors,
      concurrency: job.concurrency,
      timedOut: job.timedOut,
      currentRatePerSecond,
      averageLatencyMs,
      averageAttemptMs,
      minLatencyMs: job.minLatencyMs,
      maxLatencyMs: job.maxLatencyMs,
      totalLatencyMs: job.latencyTotalMs,
      writeDurationMs: job.writeDurationMs,
    },
  };
}

function jsonJob(job, status = 200) {
  return NextResponse.json(snapshotJob(job), {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function persistHealthBatch(job, batch, label) {
  if (batch.length === 0) return;
  ensureJobTelemetry(job);
  job.writeQueueDepth += batch.length;

  const operation = job.writeChain.then(async () => {
    const writeStartedAt = Date.now();
    try {
      const updated = Number(await bulkUpdateProxyPoolHealth(batch)) || 0;
      job.persisted += updated;
      if (updated > 0) {
        job.persistenceRevision += 1;
        job.lastPersistedAt = new Date().toISOString();
      }
    } finally {
      job.writeDurationMs += Date.now() - writeStartedAt;
      job.writeQueueDepth = Math.max(0, job.writeQueueDepth - batch.length);
    }
  });

  job.writeChain = operation.catch((error) => {
    job.persistenceErrors += batch.length;
    console.error(`[Proxy Health Check] Failed to persist ${label}:`, error);
  });
  await job.writeChain;
}

async function queueHealthWrite(job, update) {
  job.pendingWrites.push(update);
  if (job.pendingWrites.length < HEALTH_WRITE_BATCH_SIZE) return;

  const batch = job.pendingWrites.splice(0, HEALTH_WRITE_BATCH_SIZE);
  await persistHealthBatch(job, batch, `a ${batch.length}-row health batch`);
}

async function flushHealthWrites(job) {
  if (job.pendingWrites.length > 0) {
    const batch = job.pendingWrites.splice(0, job.pendingWrites.length);
    await persistHealthBatch(job, batch, `the final ${batch.length}-row health batch`);
  }
  await job.writeChain;
}

async function testPoolOnce(pool, signal, testUrl) {
  return RELAY_TYPES.has(pool.type)
    ? testRelayUrl({
      relayUrl: pool.proxyUrl,
      ...(testUrl ? { testUrl } : {}),
      timeoutMs: TEST_TIMEOUT_MS,
      signal,
    })
    : testProxyUrl({
      proxyUrl: pool.proxyUrl,
      ...(testUrl ? { testUrl } : {}),
      timeoutMs: TEST_TIMEOUT_MS,
      signal,
    });
}

async function testPoolWithRetry(pool, signal, waitForStart) {
  const startedAtMs = Date.now();
  const results = [];
  let reportedDurationMs = 0;
  let result;
  for (let attempt = 1; attempt <= MAX_TEST_ATTEMPTS; attempt += 1) {
    await waitForStart();
    if (signal.aborted) {
      result = {
        ok: false,
        status: 499,
        cancelled: true,
        retryable: false,
        proxyFailure: false,
        inconclusive: true,
        error: "Health check cancelled",
        elapsedMs: 0,
      };
      results.push(result);
      break;
    }

    const probeStartedAtMs = Date.now();
    result = await testPoolOnce(
      pool,
      signal,
      attempt > 1 ? RETRY_TEST_URL : undefined
    );
    results.push(result);
    reportedDurationMs += Math.max(
      0,
      Number(result?.elapsedMs) || (Date.now() - probeStartedAtMs)
    );
    if (
      signal.aborted
      || result?.cancelled
      || result?.retryable !== true
      || attempt === MAX_TEST_ATTEMPTS
    ) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS));
  }

  const succeeded = result?.ok === true;
  if (!succeeded && results.length > 1) {
    const hasInconclusiveAttempt = results.some((attemptResult) => (
      attemptResult?.inconclusive === true || attemptResult?.proxyFailure === false
    ));
    if (hasInconclusiveAttempt) {
      result = { ...result, inconclusive: true, proxyFailure: false };
    }
  }

  return {
    result,
    attempts: results.length,
    // Avg attempt measures time inside the network probes, excluding time spent
    // queued behind the server start-rate limiter. Real transports always
    // report elapsedMs; the wall clock is only a defensive fallback.
    totalElapsedMs: reportedDurationMs || Math.max(0, Date.now() - startedAtMs),
  };
}

async function verifyJobEnvironment(job, { force = false } = {}) {
  if (!force && job.failuresSinceEnvironmentCheck < ENVIRONMENT_FAILURE_RECHECK_THRESHOLD) {
    return job.environmentHealthy !== false;
  }
  if (job.environmentCheckPromise) return job.environmentCheckPromise;

  job.failuresSinceEnvironmentCheck = 0;
  job.environmentCheckPromise = (async () => {
    const control = await checkHealthEnvironment().catch(() => ({ ok: false }));
    job.environmentChecks = (Number(job.environmentChecks) || 0) + 1;
    if (control.ok) return true;

    job.environmentHealthy = false;
    job.error = "Health-check control targets are unreachable; proxy failures were not saved";
    job.cancelRequested = true;
    for (const activeController of job.controllers) activeController.abort();
    return false;
  })().finally(() => {
    job.environmentCheckPromise = null;
  });
  return job.environmentCheckPromise;
}

async function processPool(job, pool, waitForStart) {
  if (pool.isActive === false && !job.includeInactive) {
    job.skipped += 1;
    job.completed += 1;
    return;
  }

  const controller = new AbortController();
  job.controllers.add(controller);
  const testedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  let result;
  let attemptDurationMs = 0;
  let internalFailure = false;
  ensureJobTelemetry(job);
  job.inFlight += 1;

  try {
    const checked = await testPoolWithRetry(pool, controller.signal, waitForStart);
    result = checked.result;
    attemptDurationMs = checked.totalElapsedMs;
    job.retried += Math.max(0, checked.attempts - 1);
  } catch (error) {
    internalFailure = true;
    result = {
      ok: false,
      elapsedMs: 0,
      error: sanitizeError(error?.message, "Internal health-check error"),
    };
  } finally {
    job.controllers.delete(controller);
    job.inFlight = Math.max(0, job.inFlight - 1);
  }

  if (job.cancelRequested || result?.cancelled) {
    job.cancelled += 1;
    job.completed += 1;
    return;
  }

  const probeLatencyMs = Math.max(0, Number(result?.elapsedMs) || (Date.now() - startedAtMs));
  attemptDurationMs = Math.max(attemptDurationMs, probeLatencyMs);
  const succeeded = result?.ok === true;
  const inconclusive = !succeeded && (
    internalFailure
    || result?.inconclusive === true
    || result?.proxyFailure === false
    || typeof result?.ok !== "boolean"
  );
  const lastError = succeeded
    ? null
    : sanitizeError(result?.error, `Proxy test failed with status ${result?.status || "unknown"}`);
  const latencyMs = succeeded ? probeLatencyMs : attemptDurationMs;
  job.attemptDurationTotalMs += attemptDurationMs;
  if (result?.status === 504 || /timed out/i.test(lastError || "")) {
    job.timedOut += 1;
  }

  if (inconclusive) {
    job.internalErrors += 1;
  } else if (succeeded) {
    job.successful += 1;
    job.latencyTotalMs += latencyMs;
    job.minLatencyMs = job.minLatencyMs === null ? latencyMs : Math.min(job.minLatencyMs, latencyMs);
    job.maxLatencyMs = job.maxLatencyMs === null ? latencyMs : Math.max(job.maxLatencyMs, latencyMs);
  } else {
    job.failed += 1;
    job.failedById.set(pool.id, {
      lastTestedAt: testedAt,
      expectedProxyUrl: pool.proxyUrl,
    });
  }
  job.completed += 1;
  const completedAtMs = Date.now();
  job.recentCompletionTimes.push(completedAtMs);
  pruneRecentCompletions(job, completedAtMs);

  // An infrastructure/checker failure is not evidence that the proxy changed
  // health. Preserve its last conclusive state and keep it out of disable lists.
  if (inconclusive) return;

  const healthUpdate = {
    id: pool.id,
    expectedProxyUrl: pool.proxyUrl,
    expectedUpdatedAt: pool.updatedAt,
    testStatus: succeeded ? "active" : "error",
    lastTestedAt: testedAt,
    lastError,
    latencyMs,
  };

  if (!succeeded) {
    // Do not poison stored health during a host/target outage. Confirm the
    // checker environment periodically and commit failures only after the job
    // finishes with a healthy control path. Valid results remain live.
    job.pendingFailureWrites.push(healthUpdate);
    job.failuresSinceEnvironmentCheck += 1;
    await verifyJobEnvironment(job);
    return;
  }

  await queueHealthWrite(job, healthUpdate);
}

function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value || "")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function expectedAttemptCost(pool) {
  const latencyMs = Number(pool?.latencyMs);
  if (Number.isFinite(latencyMs) && latencyMs >= 0) {
    return Math.min(TEST_TIMEOUT_MS, latencyMs);
  }
  if (/timed out/i.test(pool?.lastError || "")) return TEST_TIMEOUT_MS;
  const protocol = (() => {
    try { return new URL(pool?.proxyUrl).protocol; } catch { return ""; }
  })();
  return protocol.startsWith("socks") ? TEST_TIMEOUT_MS * 0.6 : 1_000;
}

function scheduleHealthPools(pools) {
  return [...pools].sort((left, right) => {
    const costDelta = expectedAttemptCost(right) - expectedAttemptCost(left);
    return costDelta || (stableHash(left?.id) - stableHash(right?.id));
  });
}

function createStartRateLimiter(maxStartsPerSecond) {
  const spacingMs = Math.ceil(1_000 / maxStartsPerSecond);
  let nextStartAt = Date.now();
  let chain = Promise.resolve();

  return () => {
    chain = chain.then(async () => {
      const now = Date.now();
      const scheduledAt = Math.max(now, nextStartAt);
      nextStartAt = scheduledAt + spacingMs;
      const waitMs = scheduledAt - now;
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    });
    return chain;
  };
}

async function runHealthJob(job, pools) {
  job.status = "running";
  job.startedAtMs = Date.now();
  const scheduledPools = scheduleHealthPools(pools);
  const waitForStart = createStartRateLimiter(job.maxStartsPerSecond || MAX_STARTS_PER_SECOND);
  let nextIndex = 0;
  const persistenceTimer = setInterval(() => {
    if (job.pendingWrites.length > 0) void flushHealthWrites(job);
  }, HEALTH_WRITE_FLUSH_INTERVAL_MS);
  persistenceTimer.unref?.();

  // Multiple server-side workers overlap network I/O. CPU worker threads add
  // transfer overhead here and cannot make SQLite's single writer parallel,
  // so health persistence stays safely serialized in transaction chunks.
  const worker = async () => {
    while (!job.cancelRequested) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= scheduledPools.length) return;
      await processPool(job, scheduledPools[index], waitForStart);
    }
  };

  try {
    const workerCount = Math.min(job.concurrency, pools.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    await flushHealthWrites(job);

    if (!job.cancelRequested && job.persistenceErrors === 0 && job.failed > 0) {
      const environmentHealthy = await verifyJobEnvironment(job, { force: true });
      if (environmentHealthy && !job.cancelRequested && job.pendingFailureWrites.length > 0) {
        const confirmedFailures = job.pendingFailureWrites.splice(0, job.pendingFailureWrites.length);
        await persistHealthBatch(
          job,
          confirmedFailures,
          `the ${confirmedFailures.length}-row confirmed failure transaction`
        );
      }
    }

    if (job.environmentHealthy === false) {
      job.status = "failed";
      job.pendingFailureWrites.length = 0;
      job.failedById.clear();
    } else if (job.persistenceErrors > 0) {
      job.status = "failed";
      job.error = `Failed to persist ${job.persistenceErrors} proxy health result(s)`;
      job.pendingFailureWrites.length = 0;
      job.failedById.clear();
    } else if (job.cancelRequested) {
      job.status = "cancelled";
      job.pendingFailureWrites.length = 0;
      job.failedById.clear();
    } else {
      job.status = "completed";
    }
    console.log(
      `[Proxy Health Check] Job ${job.id} ${job.status}: ${job.successful} healthy, ${job.failed} failed, ${job.internalErrors} inconclusive, ${job.skipped} skipped`
    );
  } catch (error) {
    job.status = "failed";
    job.error = "Health check job failed on the server";
    console.error(`[Proxy Health Check] Job ${job.id} failed:`, error);
  } finally {
    clearInterval(persistenceTimer);
    job.finishedAtMs = Date.now();
    job.controllers.clear();
    if (healthState.activeJobId === job.id) healthState.activeJobId = null;
  }
}

async function parseBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function disableFailedJobResults(body) {
  const jobId = typeof body?.jobId === "string" ? body.jobId : "";
  const job = healthState.jobs.get(jobId);
  if (!job) {
    return NextResponse.json({ error: "Health check job not found" }, { status: 404 });
  }
  if (job.status !== "completed") {
    return NextResponse.json(
      { error: "Failed proxies can only be disabled after the health check completes" },
      { status: 409 }
    );
  }
  if (job.classificationVersion !== HEALTH_CLASSIFICATION_VERSION) {
    return NextResponse.json(
      {
        error: "This health check used the legacy one-shot classifier. Re-run it before disabling failed proxies.",
      },
      { status: 409 }
    );
  }
  if (job.environmentHealthy !== true) {
    return NextResponse.json(
      { error: "The health-check environment was not verified; failed proxies cannot be disabled" },
      { status: 409 }
    );
  }
  if (job.disableSummary) {
    return NextResponse.json({ success: true, jobId, ...job.disableSummary });
  }
  if (job.disableInProgress) {
    return NextResponse.json({ error: "Disable operation is already in progress" }, { status: 409 });
  }

  job.disableInProgress = true;
  try {
    const failures = [...job.failedById].map(([id, failure]) => ({ id, ...failure }));
    job.disableSummary = await disableProxyPoolsFromHealthJob(failures);
    job.failedById.clear();
    return NextResponse.json({ success: true, jobId, ...job.disableSummary });
  } finally {
    job.disableInProgress = false;
  }
}

// POST starts an asynchronous server job, or confirms disabling a completed
// job's still-current failures. The browser never receives the failed ID list.
export async function POST(request) {
  pruneJobs();
  const body = await parseBody(request);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON in request body" }, { status: 400 });
  }
  if (body.action === "disable-failed") {
    return disableFailedJobResults(body);
  }

  const activeJob = getActiveJob();
  if (activeJob) {
    return jsonJob(activeJob, 409);
  }

  const scope = body.scope === "selected" ? "selected" : "all";
  const requestedIds = scope === "selected"
    ? [...new Set(
      (Array.isArray(body.poolIds) ? body.poolIds : [])
        .filter((id) => typeof id === "string" && id.length > 0)
    )]
    : [];

  if (scope === "selected" && requestedIds.length === 0) {
    return NextResponse.json({ error: "No proxy pools selected" }, { status: 400 });
  }
  if (requestedIds.length > MAX_SELECTED_IDS) {
    return NextResponse.json(
      { error: `At most ${MAX_SELECTED_IDS.toLocaleString()} explicit proxy IDs are allowed; use scope 'all' for a full check` },
      { status: 413 }
    );
  }

  const environment = await checkHealthEnvironment().catch(() => ({ ok: false }));
  if (!environment.ok) {
    return NextResponse.json(
      {
        error: "Health check cannot start because both control targets are unreachable from the server",
      },
      { status: 503 }
    );
  }
  const racedActiveJob = getActiveJob();
  if (racedActiveJob) {
    return jsonJob(racedActiveJob, 409);
  }

  const includeInactive = scope === "all" && body.includeInactive === true;
  const job = buildJob({
    scope,
    concurrency: includeInactive ? MAX_CONCURRENCY : sanitizeConcurrency(body.concurrency),
    includeInactive,
  });
  healthState.jobs.set(job.id, job);
  healthState.activeJobId = job.id;

  try {
    const pools = scope === "selected"
      ? await getProxyPoolsByIds(requestedIds)
      : await getProxyPools();
    job.missing = Math.max(0, requestedIds.length - pools.length);
    job.total = pools.length;
    job.concurrency = Math.min(job.concurrency, Math.max(1, pools.length));

    if (pools.length === 0) {
      healthState.jobs.delete(job.id);
      healthState.activeJobId = null;
      return NextResponse.json({ error: "No proxy pools to test" }, { status: 400 });
    }

    job.status = "queued";
    void runHealthJob(job, pools);
    console.log(
      `[Proxy Health Check] Started server job ${job.id} for ${pools.length} pools with ${job.concurrency} concurrent checks`
    );
    return jsonJob(job, 202);
  } catch (error) {
    healthState.jobs.delete(job.id);
    healthState.activeJobId = null;
    console.error("[Proxy Health Check] Failed to prepare job:", error);
    return NextResponse.json({ error: "Failed to prepare proxy health check" }, { status: 500 });
  }
}

// GET returns a compact polling snapshot only; it never serializes per-proxy
// results, URLs, credentials, or failed IDs into browser memory.
export async function GET(request) {
  pruneJobs();
  const { searchParams } = new URL(request.url);
  const requestedJobId = searchParams.get("jobId") || healthState.activeJobId;
  const job = requestedJobId ? healthState.jobs.get(requestedJobId) : null;
  if (!job) {
    return NextResponse.json({ error: "Health check job not found" }, { status: 404 });
  }
  // Also checkpoints already-completed results from jobs started by an older
  // hot-reloaded module, so a running local job gains live persistence safely.
  if (RUNNING_STATUSES.has(job.status) && job.pendingWrites?.length > 0) {
    await flushHealthWrites(job);
  }
  return jsonJob(job);
}

export async function DELETE(request) {
  const { searchParams } = new URL(request.url);
  const jobId = searchParams.get("jobId") || healthState.activeJobId;
  const job = jobId ? healthState.jobs.get(jobId) : null;
  if (!job) {
    return NextResponse.json({ error: "Health check job not found" }, { status: 404 });
  }
  if (!RUNNING_STATUSES.has(job.status)) return jsonJob(job);

  job.cancelRequested = true;
  job.status = "cancelling";
  for (const controller of job.controllers) controller.abort();
  return jsonJob(job, 202);
}
