import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { SocksProxyAgent } from "socks-proxy-agent";
import { ProxyAgent, fetch as undiciFetch } from "undici";

const DEFAULT_TEST_URL = "https://connectivitycheck.gstatic.com/generate_204";
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_TIMEOUT_MS = 30000;
const HTTP_PROXY_PROTOCOLS = new Set(["http:", "https:"]);
const SOCKS_PROXY_PROTOCOLS = new Set([
  "socks:",
  "socks4:",
  "socks4a:",
  "socks5:",
  "socks5h:",
]);
const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
const LOCAL_RESOURCE_CODES = new Set([
  "EADDRNOTAVAIL",
  "ENOBUFS",
  "EMFILE",
  "ENFILE",
]);
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_SOCKET",
]);
const DNS_CODES = new Set(["EAI_AGAIN", "ENOTFOUND"]);

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function normalizeTimeout(timeoutMs) {
  const value = Number(timeoutMs);
  return Number.isFinite(value) && value > 0
    ? Math.min(value, MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
}

function elapsedSince(startedAt) {
  return startedAt ? Math.max(0, Date.now() - startedAt) : 0;
}

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

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function redactProxyCredentials(value, proxy) {
  let safeValue = String(value || "Unknown error");
  if (!proxy) return safeValue;

  const safeAddress = `${proxy.protocol}//${proxy.hostname}${proxy.port ? `:${proxy.port}` : ""}`;
  const encodedUser = proxy.username || "";
  const encodedPassword = proxy.password || "";
  const decodedUser = safeDecode(encodedUser);
  const decodedPassword = safeDecode(encodedPassword);
  const sensitiveValues = [
    proxy.href,
    encodedUser && `${encodedUser}:${encodedPassword}@`,
    decodedUser && `${decodedUser}:${decodedPassword}@`,
    encodedUser,
    encodedPassword,
    decodedUser,
    decodedPassword,
  ].filter(Boolean);

  safeValue = safeValue.split(proxy.href).join(safeAddress);
  for (const sensitive of sensitiveValues) {
    safeValue = safeValue.split(sensitive).join("[redacted]");
  }
  return safeValue;
}

function getErrorCode(error) {
  for (const item of getErrorChain(error)) {
    if (typeof item?.code === "string" && item.code) return item.code;
  }
  return null;
}

function getSafeErrorMessage(error, proxy) {
  const chain = getErrorChain(error);
  const messages = chain
    .map((item) => item?.message)
    .filter((message, index, all) => (
      typeof message === "string" && message.trim() && all.indexOf(message) === index
    ));
  let message = messages[0] || String(error || "Unknown error");

  // Fetch often wraps the useful CONNECT/socket error in a generic TypeError.
  if (/^(fetch|request) failed$/i.test(message) && messages[1]) {
    message = `${message}: ${messages[1]}`;
  }

  const code = getErrorCode(error);
  message = redactProxyCredentials(message, proxy);
  if (code && !message.includes(code)) message = `${message} (${code})`;
  return message;
}

function errorSearchText(error) {
  return getErrorChain(error)
    .flatMap((item) => [item?.name, item?.code, item?.message])
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function classifyFailure(error, { cancelled = false, timedOut = false } = {}) {
  const errorCode = getErrorCode(error);
  const text = errorSearchText(error);

  if (cancelled) {
    return {
      status: 499,
      failureKind: "cancelled",
      errorCode,
      retryable: false,
      proxyFailure: false,
    };
  }
  if (timedOut || TIMEOUT_CODES.has(errorCode) || /timed?\s*out|timeout/.test(text)) {
    return {
      status: 504,
      failureKind: "timeout",
      errorCode,
      retryable: true,
      proxyFailure: true,
    };
  }
  if (LOCAL_RESOURCE_CODES.has(errorCode)) {
    return {
      status: 503,
      failureKind: "local-resource",
      errorCode,
      // Retrying while this process is short on sockets/file descriptors only
      // amplifies the local failure and says nothing about the proxy endpoint.
      retryable: false,
      proxyFailure: false,
    };
  }
  if (/proxy[^\n]*(authentication|required|407)|407[^\n]*proxy/.test(text)) {
    return {
      status: 407,
      failureKind: "proxy-auth",
      errorCode,
      retryable: false,
      proxyFailure: true,
    };
  }
  if (DNS_CODES.has(errorCode)) {
    return {
      status: 502,
      failureKind: "dns",
      errorCode,
      retryable: errorCode === "EAI_AGAIN",
      proxyFailure: false,
    };
  }
  if (
    /^ERR_TLS_|^CERT_|^DEPTH_ZERO_/.test(errorCode || "")
    || errorCode === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
    || /certificate|tls handshake|ssl/.test(text)
  ) {
    return {
      status: 502,
      failureKind: "tls",
      errorCode,
      // A certificate/TLS failure can come from the target, local trust store,
      // system clock, or interception. Let the server job try its alternate
      // HTTPS target, but do not treat either failure as proof the proxy is bad.
      retryable: true,
      proxyFailure: false,
    };
  }
  if (TRANSIENT_NETWORK_CODES.has(errorCode)) {
    return {
      status: 502,
      failureKind: "network",
      errorCode,
      retryable: true,
      proxyFailure: true,
    };
  }
  if (errorCode === "ECONNREFUSED") {
    return {
      status: 502,
      failureKind: "network",
      errorCode,
      // A single refusal may be a transient accept-queue/restart race. The
      // server job caps this at one retry against its independent target.
      retryable: true,
      proxyFailure: true,
    };
  }
  return {
    status: 502,
    failureKind: "network",
    errorCode,
    retryable: true,
    // Generic wrappers such as Undici's bare "fetch failed" do not identify
    // whether the proxy, target, DNS, or local network caused the failure.
    proxyFailure: false,
  };
}

function failureResult({
  error,
  proxy,
  startedAt,
  cancelled = false,
  timedOut = false,
  errorMessage,
  classification,
}) {
  const details = classification || classifyFailure(error, { cancelled, timedOut });
  return {
    ok: false,
    targetOk: false,
    status: details.status,
    cancelled: details.failureKind === "cancelled",
    error: errorMessage || getSafeErrorMessage(error, proxy),
    elapsedMs: elapsedSince(startedAt),
    failureKind: details.failureKind,
    errorCode: details.errorCode || null,
    retryable: details.retryable,
    proxyFailure: details.proxyFailure,
    inconclusive: !details.proxyFailure,
  };
}

function configurationFailure(error, { proxyFailure = true, startedAt } = {}) {
  return failureResult({
    error: new Error(error),
    startedAt,
    errorMessage: error,
    classification: {
      status: 400,
      failureKind: "configuration",
      errorCode: null,
      retryable: false,
      proxyFailure,
    },
  });
}

function completedTargetResult({ status, statusText, target, elapsedMs, redirected = false }) {
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    return failureResult({
      error: new Error("Invalid target HTTP response status"),
      startedAt: Date.now() - elapsedMs,
      errorMessage: "Invalid target HTTP response status",
      classification: {
        status: 502,
        failureKind: "protocol",
        errorCode: null,
        retryable: true,
        proxyFailure: true,
      },
    });
  }

  return {
    // A complete end-to-end HTTP exchange proves that the proxy transport is
    // reachable. targetOk separately reports whether the target returned 2xx.
    ok: true,
    targetOk: status >= 200 && status < 300,
    status,
    statusText: statusText || "",
    url: target.href,
    redirected,
    elapsedMs,
    error: null,
    failureKind: null,
    errorCode: null,
    retryable: false,
    proxyFailure: false,
    inconclusive: false,
  };
}

function parseHttpTarget(testUrl) {
  try {
    const target = new URL(testUrl);
    if (!HTTP_PROXY_PROTOCOLS.has(target.protocol)) {
      return { error: "Test URL must use HTTP or HTTPS" };
    }
    return { target };
  } catch {
    return { error: "Invalid test URL" };
  }
}

function parseSupportedProxy(proxyUrl) {
  try {
    const proxy = new URL(proxyUrl);
    if (!proxy.hostname) return { error: "Invalid proxy URL" };
    if (!HTTP_PROXY_PROTOCOLS.has(proxy.protocol) && !SOCKS_PROXY_PROTOCOLS.has(proxy.protocol)) {
      return { error: `Unsupported proxy protocol: ${proxy.protocol || "unknown"}` };
    }
    return { proxy };
  } catch {
    return { error: "Invalid proxy URL" };
  }
}

async function testHttpProxy({ proxy, target, timeoutMs, startedAt, signal }) {
  let dispatcher;
  let response;
  let cancelled = false;
  let timedOut = false;
  const controller = new AbortController();
  const abortFromParent = () => {
    cancelled = true;
    controller.abort();
  };
  signal?.addEventListener("abort", abortFromParent, { once: true });
  if (signal?.aborted) abortFromParent();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();

  try {
    if (cancelled) {
      return failureResult({
        proxy,
        startedAt,
        cancelled: true,
        errorMessage: "Health check cancelled",
      });
    }

    try {
      dispatcher = new ProxyAgent({ uri: proxy.href });
    } catch {
      return configurationFailure("Invalid HTTP proxy configuration", { startedAt });
    }

    response = await undiciFetch(target, {
      method: "HEAD",
      dispatcher,
      signal: controller.signal,
      // Any completed HTTPS response proves reachability. Do not follow a
      // target redirect and accidentally turn one probe into several requests.
      redirect: "manual",
      headers: { "User-Agent": "9Router" },
    });

    return completedTargetResult({
      status: Number(response.status),
      statusText: response.statusText,
      target,
      elapsedMs: elapsedSince(startedAt),
      redirected: response.redirected === true,
    });
  } catch (error) {
    return failureResult({
      error,
      proxy,
      startedAt,
      cancelled: cancelled || signal?.aborted === true,
      timedOut,
      errorMessage: cancelled || signal?.aborted === true
        ? "Health check cancelled"
        : timedOut
          ? "Proxy test timed out"
          : undefined,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromParent);
    try {
      await response?.body?.cancel?.();
    } catch {
      // HEAD responses normally have no body; ignore defensive cleanup errors.
    }
    try {
      await dispatcher?.destroy?.();
    } catch {
      // The request result is already known; cleanup errors should not replace it.
    }
  }
}

async function testSocksProxy({ proxy, target, timeoutMs, startedAt, signal }) {
  let agent;
  let request;
  let timer;
  let abortFromParent;
  let forceDestroyRequest = true;
  let cancelled = false;
  let timedOut = false;
  const controller = new AbortController();

  try {
    try {
      agent = new SocksProxyAgent(proxy, { timeout: timeoutMs });
    } catch {
      return configurationFailure("Invalid SOCKS proxy configuration", { startedAt });
    }

    const requestFn = target.protocol === "https:" ? httpsRequest : httpRequest;

    return await new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const finishError = (error, options = {}) => finish(failureResult({
        error,
        proxy,
        startedAt,
        cancelled: options.cancelled ?? cancelled,
        timedOut: options.timedOut ?? timedOut,
        errorMessage: options.errorMessage,
        classification: options.classification,
      }));

      abortFromParent = () => {
        cancelled = true;
        controller.abort();
        request?.destroy?.();
        finishError(null, { cancelled: true, errorMessage: "Health check cancelled" });
      };
      signal?.addEventListener("abort", abortFromParent, { once: true });
      if (signal?.aborted) {
        abortFromParent();
        return;
      }

      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        request?.destroy?.();
        finishError(null, { timedOut: true, errorMessage: "Proxy test timed out" });
      }, timeoutMs);
      timer.unref?.();

      try {
        request = requestFn(target, {
          method: "HEAD",
          agent,
          signal: controller.signal,
          headers: { "User-Agent": "9Router" },
        }, (responseMessage) => {
          const status = Number(responseMessage.statusCode) || 0;
          const completeResponse = () => {
            if (responseMessage.complete !== true) {
              finishError(new Error("Target HTTP response ended before it was complete"), {
                classification: {
                  status: 502,
                  failureKind: "protocol",
                  errorCode: "ERR_HTTP_INCOMPLETE_RESPONSE",
                  retryable: true,
                  proxyFailure: true,
                },
              });
              return;
            }

            forceDestroyRequest = false;
            finish(completedTargetResult({
              status,
              statusText: responseMessage.statusMessage,
              target,
              elapsedMs: elapsedSince(startedAt),
            }));
          };
          const incompleteResponse = (error) => finishError(
            error instanceof Error
              ? error
              : new Error("Target HTTP response ended before it was complete"),
            {
              classification: {
                status: 502,
                failureKind: "protocol",
                errorCode: "ERR_HTTP_INCOMPLETE_RESPONSE",
                retryable: true,
                proxyFailure: true,
              },
            }
          );

          responseMessage.once("end", completeResponse);
          responseMessage.once("aborted", incompleteResponse);
          responseMessage.once("error", incompleteResponse);
          responseMessage.once("close", () => {
            if (!settled && responseMessage.complete !== true) incompleteResponse();
          });
          responseMessage.resume();
        });

        request.once("error", (error) => finishError(error));
        request.end();
      } catch (error) {
        finishError(error);
      }
    });
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromParent);
    if (forceDestroyRequest) request?.destroy?.();
    agent?.destroy?.();
  }
}

export async function testProxyUrl({ proxyUrl, testUrl, timeoutMs, signal } = {}) {
  const normalizedProxyUrl = normalizeString(proxyUrl);
  if (!normalizedProxyUrl) {
    return configurationFailure("proxyUrl is required");
  }

  const normalizedTestUrl = normalizeString(testUrl) || DEFAULT_TEST_URL;
  const proxyResult = parseSupportedProxy(normalizedProxyUrl);
  if (proxyResult.error) {
    return configurationFailure(proxyResult.error);
  }

  const targetResult = parseHttpTarget(normalizedTestUrl);
  if (targetResult.error) {
    return configurationFailure(targetResult.error, { proxyFailure: false });
  }

  const normalizedTimeoutMs = normalizeTimeout(timeoutMs);
  const startedAt = Date.now();
  const args = {
    proxy: proxyResult.proxy,
    target: targetResult.target,
    timeoutMs: normalizedTimeoutMs,
    startedAt,
    signal,
  };

  return SOCKS_PROXY_PROTOCOLS.has(proxyResult.proxy.protocol)
    ? testSocksProxy(args)
    : testHttpProxy(args);
}
