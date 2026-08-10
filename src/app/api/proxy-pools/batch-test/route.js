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
const LATENCY_HISTOGRAM_BUCKETS = TEST_TIMEOUT_MS + 1;
const RETRY_TEST_URL = "https://cloudflare.com/cdn-cgi/trace";
const HEALTH_CLASSIFICATION_VERSION = 8;
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
// Quarantine an older scheduler/classifier immediately so it cannot keep
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
  legacyActiveJob.error = "Older health check stopped after scheduler upgrade";
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
    phase: "initial",
    createdAtMs,
    startedAtMs: null,
    finishedAtMs: null,
    total: 0,
    completed: 0,
    initialStarted: 0,
    initialCompleted: 0,
    retryTotal: 0,
    retryCompleted: 0,
    retryCancelled: 0,
    successful: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    internalErrors: 0,
    retried: 0,
    missing: 0,
    latencyTotalMs: 0,
    attemptDurationTotalMs: 0,
    attemptCount: 0,
    minLatencyMs: null,
    maxLatencyMs: null,
    latencyHistogram: new Uint32Array(LATENCY_HISTOGRAM_BUCKETS),
    latencySampleCount: 0,
    latencyHistogramComplete: true,
    latencyHistogramFinalized: false,
    medianLatencyMs: null,
    timedOut: 0,
    inFlight: 0,
    recentCompletionTimes: [],
    recentCompletionHead: 0,
    recentInitialCompletionTimes: [],
    recentInitialCompletionHead: 0,
    rateWindowStartedAtMs: null,
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
    initialPhaseDone: false,
  };
}

function ensureJobTelemetry(job) {
  if (!Array.isArray(job.recentCompletionTimes)) job.recentCompletionTimes = [];
  if (!Number.isInteger(job.recentCompletionHead)
    || job.recentCompletionHead < 0
    || job.recentCompletionHead > job.recentCompletionTimes.length) {
    job.recentCompletionHead = 0;
  }
  if (!Array.isArray(job.recentInitialCompletionTimes)) {
    job.recentInitialCompletionTimes = [];
  }
  if (!Number.isInteger(job.recentInitialCompletionHead)
    || job.recentInitialCompletionHead < 0
    || job.recentInitialCompletionHead > job.recentInitialCompletionTimes.length) {
    job.recentInitialCompletionHead = 0;
  }
  if (!Number.isFinite(job.rateWindowStartedAtMs)) {
    job.rateWindowStartedAtMs = Number(job.startedAtMs) || null;
  }
  if (!Number.isFinite(job.attemptDurationTotalMs)) job.attemptDurationTotalMs = 0;
  if (!Number.isFinite(job.attemptCount) || job.attemptCount < 0) {
    const finalizedAttempts = Number(job.successful || 0)
      + Number(job.failed || 0)
      + Number(job.internalErrors || 0)
      + Number(job.retried || 0);
    job.attemptCount = Math.max(0, finalizedAttempts);
  }
  if (!Number.isFinite(job.initialCompleted) || job.initialCompleted < 0) {
    job.initialCompleted = Number(job.completed) || 0;
  }
  if (!Number.isFinite(job.initialStarted) || job.initialStarted < 0) {
    job.initialStarted = Number(job.initialCompleted) || 0;
  }
  if (!Number.isFinite(job.retryTotal) || job.retryTotal < 0) {
    job.retryTotal = Number(job.retried) || 0;
  }
  if (!Number.isFinite(job.retryCompleted) || job.retryCompleted < 0) {
    job.retryCompleted = Number(job.retried) || 0;
  }
  if (!Number.isFinite(job.retryCancelled) || job.retryCancelled < 0) {
    job.retryCancelled = 0;
  }
  if (job.latencyHistogramFinalized === true) {
    if (!Number.isFinite(job.medianLatencyMs)) job.medianLatencyMs = null;
  } else {
    if (!(job.latencyHistogram instanceof Uint32Array)
      || job.latencyHistogram.length !== LATENCY_HISTOGRAM_BUCKETS) {
      job.latencyHistogram = new Uint32Array(LATENCY_HISTOGRAM_BUCKETS);
      job.latencySampleCount = 0;
      // An already-running pre-upgrade job cannot reconstruct earlier samples.
      job.latencyHistogramComplete = Number(job.successful || 0) === 0;
    }
    if (!Number.isFinite(job.latencySampleCount) || job.latencySampleCount < 0) {
      job.latencySampleCount = 0;
    }
    if (typeof job.latencyHistogramComplete !== "boolean") {
      job.latencyHistogramComplete = job.latencySampleCount === Number(job.successful || 0);
    }
  }
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

function recordSuccessfulLatency(job, latencyMs) {
  ensureJobTelemetry(job);
  if (job.latencyHistogramFinalized) return;
  const bucket = Math.max(
    0,
    Math.min(TEST_TIMEOUT_MS, Math.round(Number(latencyMs) || 0)),
  );
  job.latencyHistogram[bucket] += 1;
  job.latencySampleCount += 1;
}

function getMedianLatency(job) {
  if (job.latencyHistogramFinalized === true) {
    return Number.isFinite(job.medianLatencyMs) ? job.medianLatencyMs : null;
  }
  ensureJobTelemetry(job);
  const count = job.latencySampleCount;
  if (!job.latencyHistogramComplete || count <= 0) return null;

  const leftRank = Math.floor((count - 1) / 2);
  const rightRank = Math.floor(count / 2);
  let seen = 0;
  let leftValue = null;

  for (let latencyMs = 0; latencyMs < job.latencyHistogram.length; latencyMs += 1) {
    seen += job.latencyHistogram[latencyMs];
    if (leftValue === null && seen > leftRank) leftValue = latencyMs;
    if (seen > rightRank) return (leftValue + latencyMs) / 2;
  }

  return null;
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
  const rateStartedAtMs = job.rateWindowStartedAtMs || job.startedAtMs;
  const elapsedMs = rateStartedAtMs
    ? Math.max(1_000, Math.min(RATE_WINDOW_MS, nowMs - rateStartedAtMs))
    : RATE_WINDOW_MS;
  return Number((recentCount / (elapsedMs / 1_000)).toFixed(1));
}

function pruneRecentInitialCompletions(job, nowMs) {
  ensureJobTelemetry(job);
  const cutoff = nowMs - RATE_WINDOW_MS;
  const times = job.recentInitialCompletionTimes;
  let head = job.recentInitialCompletionHead;

  while (head < times.length && times[head] < cutoff) head += 1;
  if (head > 1_024 || head > times.length / 2) {
    job.recentInitialCompletionTimes = times.slice(head);
    job.recentInitialCompletionHead = 0;
  } else {
    job.recentInitialCompletionHead = head;
  }
  return job.recentInitialCompletionTimes.length - job.recentInitialCompletionHead;
}

function recordInitialCompletion(job) {
  ensureJobTelemetry(job);
  const completedAtMs = Date.now();
  job.recentInitialCompletionTimes.push(completedAtMs);
  pruneRecentInitialCompletions(job, completedAtMs);
}

function getRecentInitialRate(job, nowMs) {
  const recentCount = pruneRecentInitialCompletions(job, nowMs);
  const elapsedMs = job.startedAtMs
    ? Math.max(1_000, Math.min(RATE_WINDOW_MS, nowMs - job.startedAtMs))
    : RATE_WINDOW_MS;
  return recentCount / (elapsedMs / 1_000);
}

function resetRateWindow(job) {
  job.recentCompletionTimes = [];
  job.recentCompletionHead = 0;
  job.rateWindowStartedAtMs = Date.now();
}

function snapshotJob(job) {
  const telemetryAvailable = Number.isFinite(job.maxStartsPerSecond);
  ensureJobTelemetry(job);
  const endedAtMs = job.finishedAtMs || Date.now();
  const durationMs = job.startedAtMs ? Math.max(0, endedAtMs - job.startedAtMs) : 0;
  const averageLatencyMs = job.successful > 0
    ? Math.round(job.latencyTotalMs / job.successful)
    : null;
  const attemptCount = Number(job.attemptCount) || 0;
  const classificationReliable = job.classificationVersion === HEALTH_CLASSIFICATION_VERSION
    && job.environmentHealthy !== false;
  const averageAttemptMs = telemetryAvailable && attemptCount > 0
    ? Math.round(job.attemptDurationTotalMs / attemptCount)
    : null;
  const medianLatencyMs = telemetryAvailable ? getMedianLatency(job) : null;
  const currentRatePerSecond = getRecentRate(job, endedAtMs);
  const phase = typeof job.phase === "string" ? job.phase : "legacy";
  const initialStarted = Math.min(job.total, Math.max(0, Number(job.initialStarted) || 0));
  const initialCompleted = Math.min(job.total, Math.max(0, Number(job.initialCompleted) || 0));
  const retryTotal = Math.max(0, Number(job.retryTotal) || 0);
  const retryCompleted = Math.min(retryTotal, Math.max(0, Number(job.retryCompleted) || 0));
  const retryCancelled = Math.min(
    retryTotal - retryCompleted,
    Math.max(0, Number(job.retryCancelled) || 0)
  );
  const pendingRetries = Math.max(0, retryTotal - retryCompleted - retryCancelled);
  const remaining = phase === "retrying"
    ? pendingRetries
    : phase === "initial"
      ? Math.max(0, job.total - initialCompleted)
      : Math.max(0, job.total - job.completed);
  // A rolling primary-only rate reacts when the remaining cohort becomes a
  // timeout-heavy tail. Cumulative throughput would keep the ETA optimistic,
  // while the all-attempt checks/s metric would be inflated by retries.
  const initialCompletionRate = getRecentInitialRate(job, endedAtMs);
  const etaRate = phase === "initial" ? initialCompletionRate : currentRatePerSecond;
  const estimatedRemainingMs = etaRate > 0
    ? Math.round((remaining / etaRate) * 1_000)
    : null;

  return {
    jobId: job.id,
    status: job.status,
    phase,
    scope: job.scope,
    includeInactive: job.includeInactive,
    total: job.total,
    completed: job.completed,
    initialStarted,
    initialCompleted,
    retryTotal,
    retryCompleted,
    retryCancelled,
    pendingRetries,
    attemptCount,
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
      initialStarted,
      initialCompleted,
      retryTotal,
      retryCompleted,
      retryCancelled,
      pendingRetries,
      attemptCount,
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
      medianLatencyMs,
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

function cancelledAttemptResult() {
  return {
    ok: false,
    status: 499,
    cancelled: true,
    retryable: false,
    proxyFailure: false,
    inconclusive: true,
    error: "Health check cancelled",
    elapsedMs: 0,
  };
}

function isInconclusiveAttempt(result, internalFailure = false) {
  return result?.ok !== true && (
    internalFailure
    || result?.inconclusive === true
    || result?.proxyFailure === false
    || typeof result?.ok !== "boolean"
  );
}

function recordAttemptTelemetry(job, result, durationMs) {
  ensureJobTelemetry(job);
  job.attemptCount += 1;
  job.attemptDurationTotalMs += durationMs;
  const error = typeof result?.error === "string" ? result.error : "";
  if (result?.status === 504 || /timed out/i.test(error)) job.timedOut += 1;

  const completedAtMs = Date.now();
  job.recentCompletionTimes.push(completedAtMs);
  pruneRecentCompletions(job, completedAtMs);
}

async function runPoolAttempt(
  job,
  pool,
  waitForStart,
  acquireProbeSlot,
  { testUrl, onStart } = {}
) {
  const controller = new AbortController();
  job.controllers.add(controller);
  let attemptStarted = false;
  let probeStartedAtMs = null;
  let releaseProbeSlot = null;

  try {
    // Reserve one of the global network slots before entering the start-rate
    // gate. Doing this in the opposite order lets queued retries consume old
    // rate-limit timestamps and then burst when slow primaries release slots.
    releaseProbeSlot = await acquireProbeSlot(controller.signal);
    if (!releaseProbeSlot || job.cancelRequested || controller.signal.aborted) {
      return {
        result: cancelledAttemptResult(),
        durationMs: 0,
        internalFailure: false,
        attemptStarted: false,
        testedAt: new Date().toISOString(),
      };
    }

    const startAllowed = await waitForStart(controller.signal);
    if (!startAllowed || job.cancelRequested || controller.signal.aborted) {
      return {
        result: cancelledAttemptResult(),
        durationMs: 0,
        internalFailure: false,
        attemptStarted: false,
        testedAt: new Date().toISOString(),
      };
    }

    attemptStarted = true;
    probeStartedAtMs = Date.now();
    ensureJobTelemetry(job);
    job.inFlight += 1;
    onStart?.();

    let result;
    let internalFailure = false;
    try {
      result = await testPoolOnce(pool, controller.signal, testUrl);
    } catch (error) {
      internalFailure = true;
      result = {
        ok: false,
        elapsedMs: 0,
        retryable: false,
        proxyFailure: false,
        inconclusive: true,
        error: sanitizeError(error?.message, "Internal health-check error"),
      };
    }

    // Avg attempt measures only network-probe time, excluding the queue behind
    // the start-rate limiter. The transport-reported duration is preferred.
    const durationMs = Math.max(
      0,
      Number(result?.elapsedMs) || (Date.now() - probeStartedAtMs)
    );
    recordAttemptTelemetry(job, result, durationMs);
    return {
      result,
      durationMs,
      internalFailure,
      attemptStarted: true,
      testedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      result: {
        ok: false,
        elapsedMs: 0,
        retryable: false,
        proxyFailure: false,
        inconclusive: true,
        error: sanitizeError(error?.message, "Internal health-check error"),
      },
      durationMs: probeStartedAtMs === null ? 0 : Math.max(0, Date.now() - probeStartedAtMs),
      internalFailure: true,
      attemptStarted,
      testedAt: new Date().toISOString(),
    };
  } finally {
    job.controllers.delete(controller);
    if (attemptStarted) job.inFlight = Math.max(0, job.inFlight - 1);
    releaseProbeSlot?.();
  }
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

async function finalizePoolResult(
  job,
  pool,
  attempt,
  { priorInconclusive = false, totalAttemptDurationMs = attempt.durationMs } = {}
) {
  const { result, internalFailure, testedAt } = attempt;
  if (job.cancelRequested || result?.cancelled) {
    job.cancelled += 1;
    job.completed += 1;
    return;
  }

  const probeLatencyMs = Math.max(0, Number(result?.elapsedMs) || attempt.durationMs);
  const succeeded = result?.ok === true;
  const inconclusive = !succeeded && (
    priorInconclusive || isInconclusiveAttempt(result, internalFailure)
  );
  const lastError = succeeded
    ? null
    : sanitizeError(result?.error, `Proxy test failed with status ${result?.status || "unknown"}`);
  const latencyMs = succeeded ? probeLatencyMs : Math.max(probeLatencyMs, totalAttemptDurationMs);

  if (inconclusive) {
    job.internalErrors += 1;
  } else if (succeeded) {
    const aggregateLatencyMs = Math.max(
      0,
      Math.min(TEST_TIMEOUT_MS, Math.round(latencyMs)),
    );
    job.successful += 1;
    job.latencyTotalMs += aggregateLatencyMs;
    recordSuccessfulLatency(job, aggregateLatencyMs);
    job.minLatencyMs = job.minLatencyMs === null
      ? aggregateLatencyMs
      : Math.min(job.minLatencyMs, aggregateLatencyMs);
    job.maxLatencyMs = job.maxLatencyMs === null
      ? aggregateLatencyMs
      : Math.max(job.maxLatencyMs, aggregateLatencyMs);
  } else {
    job.failed += 1;
    job.failedById.set(pool.id, {
      lastTestedAt: testedAt,
      expectedProxyUrl: pool.proxyUrl,
    });
  }
  job.completed += 1;

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

async function processInitialPool(
  job,
  pool,
  waitForStart,
  acquireProbeSlot,
  retryCandidates,
  onInitialStart,
  onRetryQueued
) {
  if (pool.isActive === false && !job.includeInactive) {
    job.skipped += 1;
    job.completed += 1;
    job.initialCompleted += 1;
    recordInitialCompletion(job);
    return;
  }

  const attempt = await runPoolAttempt(
    job,
    pool,
    waitForStart,
    acquireProbeSlot,
    { onStart: onInitialStart }
  );
  job.initialCompleted += 1;
  recordInitialCompletion(job);

  if (job.cancelRequested || attempt.result?.cancelled) {
    await finalizePoolResult(job, pool, attempt);
    return;
  }

  if (
    !attempt.internalFailure
    && attempt.result?.ok === false
    && attempt.result?.retryable === true
  ) {
    retryCandidates.push({
      pool,
      firstDurationMs: attempt.durationMs,
      firstInconclusive: isInconclusiveAttempt(attempt.result),
      claimed: false,
      finalized: false,
    });
    job.retryTotal += 1;
    onRetryQueued();

    // A burst of first-pass conclusive failures may indicate that this server,
    // its network, or the probe targets are unhealthy. Recheck the environment,
    // but never persist or classify the provisional proxy result here.
    if (!isInconclusiveAttempt(attempt.result)) {
      job.failuresSinceEnvironmentCheck += 1;
      await verifyJobEnvironment(job);
    }
    return;
  }

  await finalizePoolResult(job, pool, attempt);
}

async function processRetryCandidate(job, candidate, waitForStart, acquireProbeSlot) {
  if (candidate.finalized) return;
  if (job.cancelRequested) {
    candidate.finalized = true;
    job.retryCancelled += 1;
    job.cancelled += 1;
    job.completed += 1;
    return;
  }

  const attempt = await runPoolAttempt(
    job,
    candidate.pool,
    waitForStart,
    acquireProbeSlot,
    { testUrl: RETRY_TEST_URL }
  );
  if (attempt.attemptStarted) {
    job.retried += 1;
    job.retryCompleted += 1;
  } else if (attempt.result?.cancelled) {
    job.retryCancelled += 1;
  }
  candidate.finalized = true;
  await finalizePoolResult(job, candidate.pool, attempt, {
    priorInconclusive: candidate.firstInconclusive,
    totalAttemptDurationMs: candidate.firstDurationMs + attempt.durationMs,
  });
}

function cancelUnfinishedRetryCandidates(job, retryCandidates) {
  for (const candidate of retryCandidates) {
    if (candidate.finalized) continue;
    candidate.finalized = true;
    job.retryCancelled += 1;
    job.cancelled += 1;
    job.completed += 1;
  }
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

  const waitUntilScheduled = (waitMs, signal) => {
    if (waitMs <= 0) return Promise.resolve(!signal?.aborted);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve(true);
      }, waitMs);
      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(false);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };

  return (signal) => {
    chain = chain.then(async () => {
      if (signal?.aborted) return false;
      const now = Date.now();
      const scheduledAt = Math.max(now, nextStartAt);
      nextStartAt = scheduledAt + spacingMs;
      const waitMs = scheduledAt - now;
      const reachedStart = await waitUntilScheduled(waitMs, signal);
      return reachedStart && !signal?.aborted;
    });
    return chain;
  };
}

function createProbeConcurrencyLimiter(limit) {
  let active = 0;
  const waiters = [];

  const makeRelease = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);

      while (waiters.length > 0) {
        const waiter = waiters.shift();
        waiter.signal?.removeEventListener("abort", waiter.onAbort);
        if (waiter.signal?.aborted) {
          waiter.resolve(null);
          continue;
        }
        active += 1;
        waiter.resolve(makeRelease());
        break;
      }
    };
  };

  return (signal) => {
    if (signal?.aborted) return Promise.resolve(null);
    if (active < limit) {
      active += 1;
      return Promise.resolve(makeRelease());
    }

    return new Promise((resolve) => {
      const waiter = {
        signal,
        resolve,
        onAbort: null,
      };
      waiter.onAbort = () => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        signal?.removeEventListener("abort", waiter.onAbort);
        resolve(null);
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      waiters.push(waiter);
    });
  };
}

function createAsyncSignal() {
  const waiters = new Set();

  return {
    wait() {
      return new Promise((resolve) => {
        waiters.add(resolve);
      });
    },
    notify() {
      const pending = [...waiters];
      waiters.clear();
      for (const resolve of pending) resolve();
    },
  };
}

async function settleWorkers(job, workerCount, worker) {
  const guardedWorker = async () => {
    try {
      await worker();
    } catch (error) {
      // Stop new work immediately, but do not let the job become terminal
      // until every sibling has observed cancellation and settled.
      job.cancelRequested = true;
      for (const controller of job.controllers) controller.abort();
      throw error;
    }
  };
  const outcomes = await Promise.allSettled(
    Array.from({ length: workerCount }, () => guardedWorker())
  );
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  if (rejected) throw rejected.reason;
}

async function runWorkerPhase(job, items, handler) {
  let nextIndex = 0;
  const worker = async () => {
    while (!job.cancelRequested) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      await handler(items[index]);
    }
  };
  const workerCount = Math.min(job.concurrency, items.length);
  await settleWorkers(job, workerCount, worker);
}

async function runOpportunisticRetryLoop({
  job,
  retryCandidates,
  waitForStart,
  acquireProbeSlot,
  allInitialStartedPromise,
  initialPhaseDonePromise,
  retrySignal,
}) {
  // A retry may overlap a still-running primary only after every eligible
  // unique record has reached the real network probe. Before that point a
  // retry would consume either a socket or a rate-limiter start that belongs
  // to an untouched record.
  const everyInitialStarted = await Promise.race([
    allInitialStartedPromise.then(() => true),
    initialPhaseDonePromise.then(() => false),
  ]);
  if (!everyInitialStarted || job.cancelRequested) return;

  let nextRetryIndex = 0;
  const worker = async () => {
    while (!job.cancelRequested) {
      if (nextRetryIndex < retryCandidates.length) {
        const candidate = retryCandidates[nextRetryIndex];
        nextRetryIndex += 1;
        candidate.claimed = true;
        await processRetryCandidate(
          job,
          candidate,
          waitForStart,
          acquireProbeSlot
        );
        continue;
      }

      // Once all primary workers have settled, no later candidate can appear.
      if (job.initialPhaseDone) return;
      await retrySignal.wait();
    }
  };

  await settleWorkers(job, job.concurrency, worker);
}

async function runHealthJob(job, pools) {
  job.status = "running";
  job.phase = "initial";
  job.startedAtMs = Date.now();
  job.rateWindowStartedAtMs = job.startedAtMs;
  const scheduledPools = scheduleHealthPools(pools);
  const waitForStart = createStartRateLimiter(job.maxStartsPerSecond || MAX_STARTS_PER_SECOND);
  const acquireProbeSlot = createProbeConcurrencyLimiter(job.concurrency);
  const retryCandidates = [];
  const retrySignal = createAsyncSignal();
  const eligiblePrimaryCount = scheduledPools.reduce(
    (count, pool) => count + (pool.isActive !== false || job.includeInactive ? 1 : 0),
    0
  );
  let resolveAllInitialStarted;
  const allInitialStartedPromise = new Promise((resolve) => {
    resolveAllInitialStarted = resolve;
  });
  if (eligiblePrimaryCount === 0) resolveAllInitialStarted();
  const onInitialStart = () => {
    job.initialStarted += 1;
    if (job.initialStarted === eligiblePrimaryCount) resolveAllInitialStarted();
  };
  let resolveInitialPhaseDone;
  const initialPhaseDonePromise = new Promise((resolve) => {
    resolveInitialPhaseDone = resolve;
  });
  const persistenceTimer = setInterval(() => {
    if (job.pendingWrites.length > 0) void flushHealthWrites(job);
  }, HEALTH_WRITE_FLUSH_INTERVAL_MS);
  persistenceTimer.unref?.();

  // Multiple server-side workers overlap network I/O. CPU worker threads add
  // transfer overhead here and cannot make SQLite's single writer parallel,
  // so health persistence stays safely serialized in transaction chunks.
  try {
    // Unique records always get first priority. Once the final eligible
    // primary has actually started, retries may use newly freed capacity while
    // the last slow primaries are still running. Both lanes share the same
    // socket semaphore and 25-starts/second limiter.
    const initialPhasePromise = runWorkerPhase(
      job,
      scheduledPools,
      (pool) => processInitialPool(
        job,
        pool,
        waitForStart,
        acquireProbeSlot,
        retryCandidates,
        onInitialStart,
        retrySignal.notify
      )
    );
    initialPhasePromise.then(
      () => {
        job.initialPhaseDone = true;
        retrySignal.notify();
        resolveInitialPhaseDone();
      },
      () => {
        job.initialPhaseDone = true;
        retrySignal.notify();
        resolveInitialPhaseDone();
      }
    );

    const retryLoopOutcomePromise = runOpportunisticRetryLoop({
      job,
      retryCandidates,
      waitForStart,
      acquireProbeSlot,
      allInitialStartedPromise,
      initialPhaseDonePromise,
      retrySignal,
    }).then(
      () => ({ error: null }),
      (error) => ({ error })
    );
    const initialOutcome = await initialPhasePromise.then(
      () => ({ error: null }),
      (error) => ({ error })
    );

    if (initialOutcome.error) {
      job.cancelRequested = true;
      for (const controller of job.controllers) controller.abort();
      retrySignal.notify();
    } else if (!job.cancelRequested && retryCandidates.some((candidate) => !candidate.finalized)) {
      job.phase = "retrying";
      resetRateWindow(job);
    }

    const retryLoopOutcome = await retryLoopOutcomePromise;
    if (job.cancelRequested) cancelUnfinishedRetryCandidates(job, retryCandidates);
    if (initialOutcome.error) throw initialOutcome.error;
    if (retryLoopOutcome.error) throw retryLoopOutcome.error;

    job.phase = "finalizing";
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
    retryCandidates.length = 0;
    console.log(
      `[Proxy Health Check] Job ${job.id} ${job.status}: ${job.successful} healthy, ${job.failed} failed, ${job.internalErrors} inconclusive, ${job.skipped} skipped`
    );
  } catch (error) {
    clearInterval(persistenceTimer);
    job.status = "failed";
    job.error = "Health check job failed on the server";
    job.pendingWrites.length = 0;
    job.pendingFailureWrites.length = 0;
    job.failedById.clear();
    for (const controller of job.controllers) controller.abort();
    // A timer-triggered success batch may already own the serialized write
    // chain. Let it settle before publishing the terminal snapshot so counters
    // and persistence revisions cannot mutate after completion.
    await job.writeChain;
    console.error(`[Proxy Health Check] Job ${job.id} failed:`, error);
  } finally {
    clearInterval(persistenceTimer);
    job.medianLatencyMs = getMedianLatency(job);
    job.latencyHistogram = null;
    job.latencyHistogramFinalized = true;
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
        error: "This health check used an older scheduler. Re-run it before disabling failed proxies.",
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
