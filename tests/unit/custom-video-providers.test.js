/**
 * Unit tests: custom-video provider nodes (user-defined OpenAI-compatible
 * video job gateways on dashboard/media-providers/video)
 *
 * Covers:
 *  - getVideoConfig resolves custom-video-* ids from the connection snapshot
 *  - Both job API shapes: xai (POST {base}/{action}) and sora (POST {base})
 *  - Poll URL is GET {base}/{requestId} for both shapes
 *  - Bearer auth from the connection key; upstream JSON passed through verbatim
 *  - Registry providers keep their static videoConfig
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleVideoProxyCore, getVideoConfig } from "../../open-sse/handlers/videoCore.js";

const originalFetch = global.fetch;

const nodeId = "custom-video-abc123";
const creds = (baseUrl, videoApi) => ({
  apiKey: "sk-custom-video",
  providerSpecificData: { prefix: "myvid", baseUrl, videoApi, nodeName: "My Video GW" },
});

describe("getVideoConfig", () => {
  it("builds config from the connection snapshot for custom-video nodes", () => {
    const cfg = getVideoConfig(nodeId, creds("https://gw.example.com/v1/videos", "sora"));
    expect(cfg).toEqual({ baseUrl: "https://gw.example.com/v1/videos", videoApi: "sora" });
  });

  it("defaults the shape to xai when videoApi is missing", () => {
    const cfg = getVideoConfig(nodeId, creds("https://gw.example.com/videos", undefined));
    expect(cfg.videoApi).toBe("xai");
  });

  it("returns null for a custom-video node without a baseUrl snapshot", () => {
    expect(getVideoConfig(nodeId, { apiKey: "k" })).toBeNull();
    expect(getVideoConfig(nodeId, undefined)).toBeNull();
  });

  it("still returns the registry config for built-in providers (xai)", () => {
    const cfg = getVideoConfig("xai");
    expect(cfg?.baseUrl).toBe("https://api.x.ai/v1/videos");
  });

  it("returns null for unknown providers", () => {
    expect(getVideoConfig("no-such-provider")).toBeNull();
  });
});

describe("handleVideoProxyCore with custom-video nodes", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const jobAccepted = () =>
    new Response(JSON.stringify({ request_id: "job_123" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  it("xai shape: POSTs to {base}/generations with Bearer key", async () => {
    global.fetch.mockResolvedValueOnce(jobAccepted());

    const result = await handleVideoProxyCore({
      provider: nodeId,
      action: "generations",
      rawBody: JSON.stringify({ model: "veo-3", prompt: "waves" }),
      contentType: "application/json",
      credentials: creds("https://gw.example.com/videos", "xai"),
      log: null,
    });

    expect(result.success).toBe(true);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe("https://gw.example.com/videos/generations");
    expect(options.method).toBe("POST");
    expect(options.headers["Authorization"]).toBe("Bearer sk-custom-video");
  });

  it("sora shape: POSTs to {base} directly", async () => {
    global.fetch.mockResolvedValueOnce(jobAccepted());

    const result = await handleVideoProxyCore({
      provider: nodeId,
      action: "generations",
      rawBody: JSON.stringify({ model: "sora-2", prompt: "waves" }),
      contentType: "application/json",
      credentials: creds("https://gw.example.com/v1/videos", "sora"),
      log: null,
    });

    expect(result.success).toBe(true);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe("https://gw.example.com/v1/videos");
    expect(options.method).toBe("POST");
  });

  it("polls GET {base}/{requestId} and passes the status JSON through", async () => {
    const pollBody = JSON.stringify({ status: "pending", progress: 42 });
    global.fetch.mockResolvedValueOnce(
      new Response(pollBody, { status: 200, headers: { "Content-Type": "application/json" } })
    );

    const result = await handleVideoProxyCore({
      provider: nodeId,
      requestId: "job_123",
      credentials: creds("https://gw.example.com/videos", "sora"),
      log: null,
    });

    expect(result.success).toBe(true);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe("https://gw.example.com/videos/job_123");
    expect(options.method).toBe("GET");
    expect(await result.response.text()).toBe(pollBody);
  });

  it("rejects custom-video nodes with no connection baseUrl", async () => {
    const result = await handleVideoProxyCore({
      provider: nodeId,
      action: "generations",
      rawBody: "{}",
      contentType: "application/json",
      credentials: { apiKey: "k" },
      log: null,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("does not support video generation");
  });

  it("built-in xai flow is unchanged (POST api.x.ai/v1/videos/generations)", async () => {
    global.fetch.mockResolvedValueOnce(jobAccepted());

    const result = await handleVideoProxyCore({
      provider: "xai",
      action: "generations",
      rawBody: JSON.stringify({ model: "grok-imagine-video", prompt: "x" }),
      contentType: "application/json",
      credentials: { apiKey: "xai-key" },
      log: null,
    });

    expect(result.success).toBe(true);
    const [url] = global.fetch.mock.calls[0];
    expect(url).toBe("https://api.x.ai/v1/videos/generations");
  });
});
