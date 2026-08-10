/**
 * Unit tests: per-connection custom host for xAI media endpoints
 * (providerSpecificData.customBaseUrl — Text to Image + Web Search)
 *
 * Covers:
 *  - resolveCustomBaseUrl override semantics (base URL, bare host, verbatim path, invalid input)
 *  - createOpenAIAdapter.buildUrl honoring the override (and defaulting without it)
 *  - handleImageGenerationCore sends image requests to the custom host
 *  - handleChatSearch (xAI web search) sends /responses requests to the custom host
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveCustomBaseUrl, IMAGES_GENERATIONS_PATH, RESPONSES_PATH } from "../../open-sse/handlers/imageProviders/_base.js";
import createOpenAIAdapter from "../../open-sse/handlers/imageProviders/openai.js";
import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";
import { handleChatSearch } from "../../open-sse/handlers/search/chatSearch.js";

const originalFetch = global.fetch;

const DEFAULT_XAI_URL = "https://api.x.ai/v1/images/generations";
const DEFAULT_XAI_RESPONSES_URL = "https://api.x.ai/v1/responses";

const credsWith = (customBaseUrl) => ({
  apiKey: "test-key",
  providerSpecificData: { customBaseUrl },
});

describe("resolveCustomBaseUrl", () => {
  it("returns the default URL when no override is set", () => {
    expect(resolveCustomBaseUrl(DEFAULT_XAI_URL, IMAGES_GENERATIONS_PATH, undefined)).toBe(DEFAULT_XAI_URL);
    expect(resolveCustomBaseUrl(DEFAULT_XAI_URL, IMAGES_GENERATIONS_PATH, {})).toBe(DEFAULT_XAI_URL);
    expect(resolveCustomBaseUrl(DEFAULT_XAI_URL, IMAGES_GENERATIONS_PATH, { providerSpecificData: {} })).toBe(DEFAULT_XAI_URL);
  });

  it("ignores empty, whitespace-only, and invalid values", () => {
    expect(resolveCustomBaseUrl(DEFAULT_XAI_URL, IMAGES_GENERATIONS_PATH, credsWith(""))).toBe(DEFAULT_XAI_URL);
    expect(resolveCustomBaseUrl(DEFAULT_XAI_URL, IMAGES_GENERATIONS_PATH, credsWith("   "))).toBe(DEFAULT_XAI_URL);
    expect(resolveCustomBaseUrl(DEFAULT_XAI_URL, IMAGES_GENERATIONS_PATH, credsWith("not-a-url"))).toBe(DEFAULT_XAI_URL);
    expect(resolveCustomBaseUrl(DEFAULT_XAI_URL, IMAGES_GENERATIONS_PATH, credsWith(12345))).toBe(DEFAULT_XAI_URL);
  });

  it("appends the custom path to an OpenAI-compatible base URL", () => {
    expect(resolveCustomBaseUrl(DEFAULT_XAI_URL, IMAGES_GENERATIONS_PATH, credsWith("https://ha.ntu.my.id/v1/")))
      .toBe("https://ha.ntu.my.id/v1/images/generations");
    expect(resolveCustomBaseUrl(DEFAULT_XAI_RESPONSES_URL, RESPONSES_PATH, credsWith("https://ha.ntu.my.id/v1/")))
      .toBe("https://ha.ntu.my.id/v1/responses");
    expect(resolveCustomBaseUrl(DEFAULT_XAI_URL, IMAGES_GENERATIONS_PATH, credsWith("https://ha.ntu.my.id/v1")))
      .toBe("https://ha.ntu.my.id/v1/images/generations");
  });

  it("appends the custom path to a bare host", () => {
    expect(resolveCustomBaseUrl(DEFAULT_XAI_URL, IMAGES_GENERATIONS_PATH, credsWith("https://ha.ntu.my.id")))
      .toBe("https://ha.ntu.my.id/images/generations");
    expect(resolveCustomBaseUrl(DEFAULT_XAI_URL, IMAGES_GENERATIONS_PATH, credsWith("https://ha.ntu.my.id/")))
      .toBe("https://ha.ntu.my.id/images/generations");
  });

  it("uses a URL with a custom path verbatim", () => {
    expect(resolveCustomBaseUrl(DEFAULT_XAI_URL, IMAGES_GENERATIONS_PATH, credsWith("https://gw.example.com/api/v2")))
      .toBe("https://gw.example.com/api/v2");
    expect(resolveCustomBaseUrl(DEFAULT_XAI_URL, IMAGES_GENERATIONS_PATH, credsWith("https://gw.example.com/custom/ep/")))
      .toBe("https://gw.example.com/custom/ep/");
  });
});

describe("createOpenAIAdapter(xai).buildUrl", () => {
  it("defaults to the registry imageConfig.baseUrl", () => {
    const adapter = createOpenAIAdapter("xai");
    expect(adapter.buildUrl("grok-2-image-1212", { apiKey: "k" })).toBe(DEFAULT_XAI_URL);
    expect(adapter.buildUrl("grok-2-image-1212", undefined)).toBe(DEFAULT_XAI_URL);
  });

  it("honors providerSpecificData.customBaseUrl", () => {
    const adapter = createOpenAIAdapter("xai");
    expect(adapter.buildUrl("grok-2-image-1212", credsWith("https://ha.ntu.my.id/v1/")))
      .toBe("https://ha.ntu.my.id/v1/images/generations");
  });
});

describe("handleImageGenerationCore with custom host", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const okResponse = () =>
    new Response(
      JSON.stringify({ created: 123, data: [{ url: "https://example.com/img.png" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  it("sends xAI image requests to the custom host when configured", async () => {
    global.fetch.mockResolvedValueOnce(okResponse());

    const result = await handleImageGenerationCore({
      body: { model: "grok-2-image-1212", prompt: "a red panda" },
      modelInfo: { provider: "xai", model: "grok-2-image-1212" },
      credentials: credsWith("https://ha.ntu.my.id/v1/"),
      log: null,
    });

    expect(result.success).toBe(true);
    const [calledUrl] = global.fetch.mock.calls[0];
    expect(calledUrl).toBe("https://ha.ntu.my.id/v1/images/generations");
  });

  it("still targets api.x.ai when no custom host is set", async () => {
    global.fetch.mockResolvedValueOnce(okResponse());

    const result = await handleImageGenerationCore({
      body: { model: "grok-2-image-1212", prompt: "a red panda" },
      modelInfo: { provider: "xai", model: "grok-2-image-1212" },
      credentials: { apiKey: "test-key" },
      log: null,
    });

    expect(result.success).toBe(true);
    const [calledUrl] = global.fetch.mock.calls[0];
    expect(calledUrl).toBe(DEFAULT_XAI_URL);
  });
});

describe("handleChatSearch (xAI web search) with custom host", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const okSearchResponse = () =>
    new Response(
      JSON.stringify({
        output: [{ content: [{ text: "an answer", annotations: [{ url: "https://example.com" }] }] }],
        usage: { total_tokens: 42 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  it("sends xAI web search to the custom host /responses when configured", async () => {
    global.fetch.mockResolvedValueOnce(okSearchResponse());

    const result = await handleChatSearch({
      provider: "xai",
      query: "weather today",
      credentials: credsWith("https://ha.ntu.my.id/v1/"),
      log: null,
    });

    expect(result.success).toBe(true);
    const [calledUrl] = global.fetch.mock.calls[0];
    expect(calledUrl).toBe("https://ha.ntu.my.id/v1/responses");
  });

  it("still targets api.x.ai when no custom host is set", async () => {
    global.fetch.mockResolvedValueOnce(okSearchResponse());

    const result = await handleChatSearch({
      provider: "xai",
      query: "weather today",
      credentials: { apiKey: "test-key" },
      log: null,
    });

    expect(result.success).toBe(true);
    const [calledUrl] = global.fetch.mock.calls[0];
    expect(calledUrl).toBe(DEFAULT_XAI_RESPONSES_URL);
  });
});
