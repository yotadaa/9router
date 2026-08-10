import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  httpAgents: [],
  socksAgents: [],
  requests: [],
  dispatcherDestroy: vi.fn(),
  socksAgentDestroy: vi.fn(),
  undiciFetch: vi.fn(),
  httpRequest: vi.fn(),
  httpsRequest: vi.fn(),
}));

vi.mock("undici", () => ({
  ProxyAgent: class MockProxyAgent {
    constructor(options) {
      this.options = options;
      mocks.httpAgents.push(this);
    }

    async destroy() {
      mocks.dispatcherDestroy(this);
    }
  },
  fetch: mocks.undiciFetch,
}));

vi.mock("socks-proxy-agent", () => ({
  SocksProxyAgent: class MockSocksProxyAgent {
    constructor(proxy, options) {
      this.proxy = proxy;
      this.options = options;
      mocks.socksAgents.push(this);
    }

    destroy() {
      mocks.socksAgentDestroy(this);
    }
  },
}));

vi.mock("node:http", () => ({ request: mocks.httpRequest }));
vi.mock("node:https", () => ({ request: mocks.httpsRequest }));

import { testProxyUrl } from "@/lib/network/proxyTest.js";

function successfulNodeRequest(
  statusCode = 204,
  statusMessage = "No Content",
  { complete = true } = {}
) {
  return (target, options, onResponse) => {
    const listeners = new Map();
    const response = new EventEmitter();
    response.statusCode = statusCode;
    response.statusMessage = statusMessage;
    response.complete = false;
    response.resume = vi.fn(() => queueMicrotask(() => {
      response.complete = complete;
      response.emit(complete ? "end" : "aborted");
      response.emit("close");
    }));
    const request = {
      destroy: vi.fn(),
      end: vi.fn(() => queueMicrotask(() => onResponse(response))),
      once: vi.fn((event, listener) => {
        listeners.set(event, listener);
        return request;
      }),
    };
    mocks.requests.push({ target, options, request, response, listeners });
    return request;
  };
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.httpAgents.length = 0;
  mocks.socksAgents.length = 0;
  mocks.requests.length = 0;
  mocks.undiciFetch.mockResolvedValue({
    ok: true,
    status: 204,
    statusText: "No Content",
    redirected: false,
    body: null,
  });
  mocks.httpRequest.mockImplementation(successfulNodeRequest());
  mocks.httpsRequest.mockImplementation(successfulNodeRequest());
});

describe("testProxyUrl transport selection", () => {
  it.each(["http", "https"])("uses an Undici dispatcher for %s proxies", async (protocol) => {
    const result = await testProxyUrl({
      proxyUrl: `${protocol}://alice:secret@proxy.test:8080`,
      testUrl: "https://target.test/health",
      timeoutMs: 500,
    });

    expect(result).toMatchObject({ ok: true, status: 204, url: "https://target.test/health" });
    expect(mocks.httpAgents).toHaveLength(1);
    expect(mocks.httpAgents[0].options.uri).toBe(`${protocol}://alice:secret@proxy.test:8080/`);
    expect(mocks.undiciFetch).toHaveBeenCalledWith(
      expect.objectContaining({ href: "https://target.test/health" }),
      expect.objectContaining({ method: "HEAD", dispatcher: mocks.httpAgents[0] })
    );
    expect(mocks.dispatcherDestroy).toHaveBeenCalledWith(mocks.httpAgents[0]);
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
  });

  it.each(["socks4", "socks4a", "socks5", "socks5h"])(
    "uses SocksProxyAgent with node:https for %s proxies",
    async (protocol) => {
      const result = await testProxyUrl({
        proxyUrl: `${protocol}://alice:secret@proxy.test:1080`,
        testUrl: "https://target.test/health",
        timeoutMs: 750,
      });

      expect(result).toMatchObject({ ok: true, status: 204, url: "https://target.test/health" });
      expect(mocks.socksAgents).toHaveLength(1);
      expect(mocks.socksAgents[0].proxy.protocol).toBe(`${protocol}:`);
      expect(mocks.socksAgents[0].options).toEqual({ timeout: 750 });
      expect(mocks.httpsRequest).toHaveBeenCalledTimes(1);
      expect(mocks.requests[0].options).toMatchObject({
        method: "HEAD",
        agent: mocks.socksAgents[0],
      });
      expect(mocks.socksAgentDestroy).toHaveBeenCalledWith(mocks.socksAgents[0]);
      expect(mocks.requests[0].request.destroy).not.toHaveBeenCalled();
      expect(mocks.undiciFetch).not.toHaveBeenCalled();
    }
  );

  it("enforces the HTTP proxy deadline and destroys its dispatcher", async () => {
    vi.useFakeTimers();
    mocks.undiciFetch.mockImplementation((target, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("This operation was aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }));

    const pending = testProxyUrl({
      proxyUrl: "http://proxy.test:8080",
      timeoutMs: 25,
    });
    await vi.advanceTimersByTimeAsync(25);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      status: 504,
      failureKind: "timeout",
      retryable: true,
      proxyFailure: true,
    });
    expect(mocks.dispatcherDestroy).toHaveBeenCalledWith(mocks.httpAgents[0]);
  });

  it("cancels a defensive HTTP response body before dispatcher cleanup", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    mocks.undiciFetch.mockResolvedValue({
      ok: true,
      status: 204,
      statusText: "No Content",
      redirected: false,
      body: { cancel },
    });

    await expect(testProxyUrl({
      proxyUrl: "https://proxy.test:8443",
    })).resolves.toMatchObject({ ok: true, status: 204 });

    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.dispatcherDestroy.mock.invocationCallOrder[0]);
  });

  it("uses node:http for an HTTP target reached through SOCKS", async () => {
    const result = await testProxyUrl({
      proxyUrl: "socks5://proxy.test:1080",
      testUrl: "http://target.test/health",
    });

    expect(result.ok).toBe(true);
    expect(mocks.httpRequest).toHaveBeenCalledTimes(1);
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
  });

  it.each([403, 429, 503])(
    "treats a complete target HTTP %s response as reachable while preserving targetOk",
    async (status) => {
      mocks.undiciFetch.mockResolvedValue({
        ok: false,
        status,
        statusText: "Target response",
        redirected: false,
        body: null,
      });

      const result = await testProxyUrl({
        proxyUrl: "http://proxy.test:8080",
      });

      expect(result).toMatchObject({
        ok: true,
        targetOk: false,
        status,
        error: null,
        proxyFailure: false,
        inconclusive: false,
      });
    }
  );

  it("uses the same transport-reachability criterion for SOCKS target responses", async () => {
    mocks.httpsRequest.mockImplementation(successfulNodeRequest(503, "Service Unavailable"));

    const result = await testProxyUrl({
      proxyUrl: "socks5h://proxy.test:1080",
    });

    expect(result).toMatchObject({
      ok: true,
      targetOk: false,
      status: 503,
      proxyFailure: false,
    });
  });

  it("does not declare a SOCKS response healthy until the HTTP message ends completely", async () => {
    const response = new EventEmitter();
    response.statusCode = 204;
    response.statusMessage = "No Content";
    response.complete = false;
    response.resume = vi.fn();
    mocks.httpsRequest.mockImplementation((target, options, onResponse) => {
      const listeners = new Map();
      const request = {
        destroy: vi.fn(),
        end: vi.fn(() => queueMicrotask(() => onResponse(response))),
        once: vi.fn((event, listener) => {
          listeners.set(event, listener);
          return request;
        }),
      };
      mocks.requests.push({ target, options, request, response, listeners });
      return request;
    });

    let settled = false;
    const pending = testProxyUrl({ proxyUrl: "socks5://proxy.test:1080" })
      .then((result) => {
        settled = true;
        return result;
      });
    await new Promise((resolve) => queueMicrotask(resolve));
    await new Promise((resolve) => queueMicrotask(resolve));

    expect(settled).toBe(false);
    response.complete = true;
    response.emit("end");
    response.emit("close");

    await expect(pending).resolves.toMatchObject({ ok: true, targetOk: true, status: 204 });
    expect(mocks.requests[0].request.destroy).not.toHaveBeenCalled();
  });

  it("rejects a SOCKS response whose headers arrive before a truncated message", async () => {
    mocks.httpsRequest.mockImplementation(successfulNodeRequest(
      204,
      "No Content",
      { complete: false }
    ));

    const result = await testProxyUrl({
      proxyUrl: "socks5://proxy.test:1080",
    });

    expect(result).toMatchObject({
      ok: false,
      targetOk: false,
      status: 502,
      failureKind: "protocol",
      errorCode: "ERR_HTTP_INCOMPLETE_RESPONSE",
      retryable: true,
      proxyFailure: true,
    });
    expect(mocks.requests[0].request.destroy).toHaveBeenCalled();
  });

  it("times out a stalled SOCKS request and destroys both request and agent", async () => {
    vi.useFakeTimers();
    mocks.httpsRequest.mockImplementation((target, options) => {
      const request = {
        destroy: vi.fn(),
        end: vi.fn(),
        once: vi.fn(() => request),
      };
      mocks.requests.push({ target, options, request, listeners: new Map() });
      return request;
    });

    const pending = testProxyUrl({
      proxyUrl: "socks5h://proxy.test:1080",
      timeoutMs: 25,
    });
    await vi.advanceTimersByTimeAsync(25);
    const result = await pending;

    expect(result).toMatchObject({ ok: false, status: 504, error: "Proxy test timed out" });
    expect(result).toMatchObject({
      failureKind: "timeout",
      retryable: true,
      proxyFailure: true,
      inconclusive: false,
    });
    expect(mocks.requests[0].request.destroy).toHaveBeenCalled();
    expect(mocks.socksAgentDestroy).toHaveBeenCalledWith(mocks.socksAgents[0]);
  });

  it("cancels an in-flight SOCKS request when the server job aborts", async () => {
    const controller = new AbortController();
    mocks.httpsRequest.mockImplementation((target, options) => {
      const request = {
        destroy: vi.fn(),
        end: vi.fn(),
        once: vi.fn(() => request),
      };
      mocks.requests.push({ target, options, request, listeners: new Map() });
      return request;
    });

    const pending = testProxyUrl({
      proxyUrl: "socks5://proxy.test:1080",
      signal: controller.signal,
    });
    controller.abort();
    const result = await pending;

    expect(result).toMatchObject({
      ok: false,
      status: 499,
      cancelled: true,
      error: "Health check cancelled",
      failureKind: "cancelled",
      retryable: false,
      proxyFailure: false,
      inconclusive: true,
    });
    expect(mocks.requests[0].request.destroy).toHaveBeenCalled();
    expect(mocks.socksAgentDestroy).toHaveBeenCalledWith(mocks.socksAgents[0]);
  });

  it("redacts proxy credentials from transport errors", async () => {
    mocks.httpsRequest.mockImplementation((target, options) => {
      const listeners = new Map();
      const request = {
        destroy: vi.fn(),
        end: vi.fn(() => queueMicrotask(() => listeners.get("error")?.(
          new Error("connect via socks5://alice:secret@proxy.test:1080/ failed for alice secret")
        ))),
        once: vi.fn((event, listener) => {
          listeners.set(event, listener);
          return request;
        }),
      };
      mocks.requests.push({ target, options, request, listeners });
      return request;
    });

    const result = await testProxyUrl({
      proxyUrl: "socks5://alice:secret@proxy.test:1080",
    });

    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("alice");
    expect(result.error).not.toContain("secret");
    expect(result.error).not.toContain("socks5://alice:secret@");
  });

  it("redacts credentials in nested Undici CONNECT errors and identifies proxy auth", async () => {
    const cause = new Error(
      "Proxy Authentication Required (407) for http://alice:secret@proxy.test:8080/"
    );
    cause.code = "UND_ERR_INVALID_ARG";
    mocks.undiciFetch.mockRejectedValue(new TypeError("fetch failed", { cause }));

    const result = await testProxyUrl({
      proxyUrl: "http://alice:secret@proxy.test:8080",
    });

    expect(result).toMatchObject({
      ok: false,
      status: 407,
      failureKind: "proxy-auth",
      retryable: false,
      proxyFailure: true,
    });
    expect(result.error).toContain("Proxy Authentication Required");
    expect(result.error).not.toContain("alice");
    expect(result.error).not.toContain("secret");
  });

  it("classifies nested Undici timeout errors as retryable timeouts", async () => {
    const cause = new Error("Connect Timeout Error");
    cause.code = "UND_ERR_CONNECT_TIMEOUT";
    mocks.undiciFetch.mockRejectedValue(new TypeError("fetch failed", { cause }));

    const result = await testProxyUrl({ proxyUrl: "http://proxy.test:8080" });

    expect(result).toMatchObject({
      ok: false,
      status: 504,
      failureKind: "timeout",
      errorCode: "UND_ERR_CONNECT_TIMEOUT",
      retryable: true,
      proxyFailure: true,
    });
  });

  it("marks local socket exhaustion as inconclusive instead of a proxy failure", async () => {
    const cause = new Error("No buffer space available");
    cause.code = "ENOBUFS";
    mocks.undiciFetch.mockRejectedValue(new TypeError("fetch failed", { cause }));

    const result = await testProxyUrl({ proxyUrl: "http://proxy.test:8080" });

    expect(result).toMatchObject({
      ok: false,
      status: 503,
      failureKind: "local-resource",
      errorCode: "ENOBUFS",
      retryable: false,
      proxyFailure: false,
      inconclusive: true,
    });
  });

  it("retries a refused connection once as a conclusive proxy failure", async () => {
    const cause = new Error("Connection refused");
    cause.code = "ECONNREFUSED";
    mocks.undiciFetch.mockRejectedValue(new TypeError("fetch failed", { cause }));

    const result = await testProxyUrl({ proxyUrl: "http://proxy.test:8080" });

    expect(result).toMatchObject({
      ok: false,
      status: 502,
      failureKind: "network",
      errorCode: "ECONNREFUSED",
      retryable: true,
      proxyFailure: true,
      inconclusive: false,
    });
  });

  it("does not blame a proxy for an unclassified generic transport failure", async () => {
    mocks.undiciFetch.mockRejectedValue(new TypeError("fetch failed"));

    const result = await testProxyUrl({ proxyUrl: "http://proxy.test:8080" });

    expect(result).toMatchObject({
      ok: false,
      status: 502,
      failureKind: "network",
      errorCode: null,
      retryable: true,
      proxyFailure: false,
      inconclusive: true,
    });
  });

  it("keeps TLS and certificate failures inconclusive for an alternate-target retry", async () => {
    const cause = new Error("unable to verify the first certificate");
    cause.code = "UNABLE_TO_VERIFY_LEAF_SIGNATURE";
    mocks.undiciFetch.mockRejectedValue(new TypeError("fetch failed", { cause }));

    const result = await testProxyUrl({ proxyUrl: "http://proxy.test:8080" });

    expect(result).toMatchObject({
      ok: false,
      status: 502,
      failureKind: "tls",
      errorCode: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      retryable: true,
      proxyFailure: false,
      inconclusive: true,
    });
  });

  it("rejects unsupported proxy and target schemes before opening a socket", async () => {
    await expect(testProxyUrl({ proxyUrl: "ftp://proxy.test:21" })).resolves.toMatchObject({
      ok: false,
      status: 400,
      error: "Unsupported proxy protocol: ftp:",
    });
    await expect(testProxyUrl({
      proxyUrl: "http://proxy.test:8080",
      testUrl: "file:///tmp/test",
    })).resolves.toMatchObject({
      ok: false,
      status: 400,
      error: "Test URL must use HTTP or HTTPS",
    });

    expect(mocks.undiciFetch).not.toHaveBeenCalled();
    expect(mocks.httpRequest).not.toHaveBeenCalled();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
  });
});
