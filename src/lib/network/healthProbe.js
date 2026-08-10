import { fetch as undiciFetch } from "undici";

const DEFAULT_TIMEOUT_MS = 10_000;
const CONTROL_TIMEOUT_MS = 5_000;
const MAX_RELAY_BODY_BYTES = 8 * 1024;
const LOCAL_RESOURCE_CODES = new Set(["EADDRNOTAVAIL", "ENOBUFS", "EMFILE", "ENFILE"]);
const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
const RELAY_ENDPOINT_FAILURE_CODES = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

const PRIMARY_PROBE = {
  url: "https://connectivitycheck.gstatic.com/generate_204",
  targetOrigin: "https://connectivitycheck.gstatic.com",
  targetPath: "/generate_204",
  validate: ({ status }) => status === 204,
  expected: "HTTP 204 from the Google connectivity endpoint",
};

const FALLBACK_PROBE = {
  url: "https://cloudflare.com/cdn-cgi/trace",
  targetOrigin: "https://cloudflare.com",
  targetPath: "/cdn-cgi/trace",
  validate: ({ status, body }) => (
    status === 200
    && /^fl=/m.test(body)
    && /^ip=/m.test(body)
    && /^colo=/m.test(body)
  ),
  expected: "a signed-format Cloudflare trace response",
};

function getErrorChain(error) {
  const chain = [];
  const seen = new Set();
  let current = error;
  while (current && !seen.has(current) && chain.length < 6) {
    seen.add(current);
    chain.push(current);
    current = current?.cause;
  }
  return chain;
}

function getErrorCode(error) {
  return getErrorChain(error).find((item) => typeof item?.code === "string")?.code || null;
}

function selectProbe(testUrl) {
  return String(testUrl || "").includes("cloudflare.com/cdn-cgi/trace")
    ? FALLBACK_PROBE
    : PRIMARY_PROBE;
}

function relayFailure({
  status = 502,
  error,
  failureKind,
  errorCode = null,
  retryable,
  proxyFailure,
  elapsedMs,
  cancelled = false,
}) {
  return {
    ok: false,
    targetOk: false,
    status,
    error,
    elapsedMs: Math.max(0, Number(elapsedMs) || 0),
    cancelled,
    failureKind,
    errorCode,
    retryable,
    proxyFailure,
    inconclusive: !proxyFailure,
  };
}

function classifyRelayException(error, { cancelled, timedOut, elapsedMs }) {
  const errorCode = getErrorCode(error);
  if (cancelled) {
    return relayFailure({
      status: 499,
      error: "Health check cancelled",
      failureKind: "cancelled",
      errorCode,
      retryable: false,
      proxyFailure: false,
      elapsedMs,
      cancelled: true,
    });
  }
  if (timedOut || TIMEOUT_CODES.has(errorCode)) {
    return relayFailure({
      status: 504,
      error: "Relay test timed out",
      failureKind: "timeout",
      errorCode,
      retryable: true,
      proxyFailure: true,
      elapsedMs,
    });
  }
  if (LOCAL_RESOURCE_CODES.has(errorCode)) {
    return relayFailure({
      status: 503,
      error: `Local socket resources are unavailable${errorCode ? ` (${errorCode})` : ""}`,
      failureKind: "local-resource",
      errorCode,
      retryable: false,
      proxyFailure: false,
      elapsedMs,
    });
  }
  if (RELAY_ENDPOINT_FAILURE_CODES.has(errorCode)) {
    return relayFailure({
      status: 502,
      error: `Relay endpoint is unreachable (${errorCode})`,
      failureKind: "relay-endpoint",
      errorCode,
      retryable: true,
      proxyFailure: true,
      elapsedMs,
    });
  }

  // DNS, TLS, and generic fetch wrappers can originate from the relay host,
  // either sentinel target, or this computer. Retry once, but preserve the
  // previous relay health if neither attempt provides conclusive evidence.
  return relayFailure({
    status: 502,
    error: `Relay transport could not be verified${errorCode ? ` (${errorCode})` : ""}`,
    failureKind: "relay-transport",
    errorCode,
    retryable: true,
    proxyFailure: false,
    elapsedMs,
  });
}

async function readBoundedBody(response, maxBytes = MAX_RELAY_BODY_BYTES) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytesRead = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value?.byteLength || 0;
      if (bytesRead > maxBytes) {
        const error = new Error("Relay sentinel response exceeded the safe body limit");
        error.code = "ERR_RELAY_RESPONSE_TOO_LARGE";
        throw error;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    try { await reader.cancel(); } catch { /* already consumed or aborted */ }
    reader.releaseLock?.();
  }
}

export async function testRelayUrl({ relayUrl, testUrl, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  let parsedRelay;
  try {
    parsedRelay = new URL(relayUrl);
    if (!new Set(["http:", "https:"]).has(parsedRelay.protocol)) throw new Error();
  } catch {
    return relayFailure({
      status: 400,
      error: "Invalid relay URL",
      failureKind: "configuration",
      retryable: false,
      proxyFailure: true,
      elapsedMs: 0,
    });
  }

  const probe = selectProbe(testUrl);
  const controller = new AbortController();
  const startedAt = Date.now();
  let timedOut = false;
  let response;
  const abortFromParent = () => controller.abort();
  signal?.addEventListener("abort", abortFromParent, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  timer.unref?.();

  try {
    response = await undiciFetch(parsedRelay, {
      method: "GET",
      headers: {
        "x-relay-target": probe.targetOrigin,
        "x-relay-path": probe.targetPath,
        "cache-control": "no-store",
        "User-Agent": "9Router-HealthCheck/2.0",
      },
      signal: controller.signal,
      redirect: "manual",
    });
    const body = probe === FALLBACK_PROBE ? await readBoundedBody(response) : "";
    const elapsedMs = Date.now() - startedAt;
    if (!probe.validate({ status: Number(response.status), body })) {
      return relayFailure({
        status: Number(response.status) || 502,
        error: `Relay did not return ${probe.expected}`,
        failureKind: "relay-verification",
        errorCode: `HTTP_${Number(response.status) || 0}`,
        retryable: true,
        proxyFailure: true,
        elapsedMs,
      });
    }

    return {
      ok: true,
      targetOk: true,
      status: Number(response.status),
      statusText: response.statusText || "",
      elapsedMs,
      error: null,
      failureKind: null,
      errorCode: null,
      retryable: false,
      proxyFailure: false,
      inconclusive: false,
    };
  } catch (error) {
    return classifyRelayException(error, {
      cancelled: signal?.aborted === true,
      timedOut,
      elapsedMs: Date.now() - startedAt,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromParent);
    try { await response?.body?.cancel?.(); } catch { /* consumed or aborted */ }
  }
}

async function directControlProbe(probe, timeoutMs) {
  const controller = new AbortController();
  let response;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    response = await undiciFetch(probe.url, {
      method: "GET",
      signal: controller.signal,
      redirect: "manual",
      headers: { "User-Agent": "9Router-HealthCheck-Control/2.0" },
    });
    const body = probe === FALLBACK_PROBE ? await readBoundedBody(response) : "";
    return probe.validate({ status: Number(response.status), body });
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    try { await response?.body?.cancel?.(); } catch { /* HEAD or aborted */ }
  }
}

export async function checkHealthEnvironment({ timeoutMs = CONTROL_TIMEOUT_MS } = {}) {
  const results = await Promise.all([
    directControlProbe(PRIMARY_PROBE, timeoutMs),
    directControlProbe(FALLBACK_PROBE, timeoutMs),
  ]);
  return {
    ok: results.some(Boolean),
    reachableTargets: results.filter(Boolean).length,
    checkedTargets: results.length,
  };
}
