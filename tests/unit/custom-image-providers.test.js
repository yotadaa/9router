/**
 * Unit tests: custom-image provider nodes (user-defined OpenAI-compatible
 * Text to Image gateways on dashboard/media-providers/image)
 *
 * Covers:
 *  - Adapter registry returns the customImageNode adapter for custom-image-* ids
 *  - isImageProvider recognizes custom-image node ids
 *  - customImageNode adapter: baseUrl resolution from credentials snapshot,
 *    trailing-slash + /images/generations normalization, headers, body shape
 *  - End-to-end: handleImageGenerationCore routes a custom node request to the
 *    connection's baseUrl and passes through OpenAI-shaped responses
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getImageAdapter, isImageProvider } from "../../open-sse/handlers/imageProviders/index.js";
import customImageNode from "../../open-sse/handlers/imageProviders/customImageNode.js";
import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";

const originalFetch = global.fetch;

const nodeId = "custom-image-abc123";
const creds = (baseUrl) => ({
  apiKey: "sk-custom",
  providerSpecificData: { prefix: "myimg", baseUrl, nodeName: "My Gateway" },
});

describe("custom-image adapter registry", () => {
  it("returns the node adapter for custom-image-* ids", () => {
    expect(getImageAdapter(nodeId)).toBe(customImageNode);
    expect(getImageAdapter("custom-image-zzz")).toBe(customImageNode);
  });

  it("isImageProvider recognizes custom-image node ids", () => {
    expect(isImageProvider(nodeId)).toBe(true);
  });

  it("does not confuse other prefixes with custom-image", () => {
    expect(getImageAdapter("custom-embedding-abc")).toBeNull();
    expect(getImageAdapter("openai-compatible-chat-x")).toBeNull();
    expect(isImageProvider("custom-embedding-abc")).toBe(false);
  });

  it("built-in adapters still resolve normally", () => {
    expect(getImageAdapter("xai")).toBeTruthy();
    expect(getImageAdapter("openai")).toBeTruthy();
  });
});

describe("customImageNode adapter", () => {
  it("builds {baseUrl}/images/generations from the credentials snapshot", () => {
    expect(customImageNode.buildUrl("flux-1-dev", creds("https://ha.ntu.my.id/v1")))
      .toBe("https://ha.ntu.my.id/v1/images/generations");
  });

  it("strips trailing slashes and a pasted /images/generations suffix", () => {
    expect(customImageNode.buildUrl("m", creds("https://gw.example.com/")))
      .toBe("https://gw.example.com/images/generations");
    expect(customImageNode.buildUrl("m", creds("https://gw.example.com/v1/images/generations")))
      .toBe("https://gw.example.com/v1/images/generations");
  });

  it("falls back to the OpenAI default when no baseUrl is snapshotted", () => {
    expect(customImageNode.buildUrl("m", {})).toBe("https://api.openai.com/v1/images/generations");
    expect(customImageNode.buildUrl("m", undefined)).toBe("https://api.openai.com/v1/images/generations");
  });

  it("sends Bearer auth from the connection key", () => {
    const headers = customImageNode.buildHeaders(creds("https://gw.example.com"));
    expect(headers["Authorization"]).toBe("Bearer sk-custom");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("builds an OpenAI images body (defaults + known optional params, nothing else)", () => {
    const body = customImageNode.buildBody("flux-1-dev", {
      prompt: "cat", n: 2, quality: "hd", style: "vivid", response_format: "b64_json", bogus: 1,
    });
    expect(body).toEqual({
      model: "flux-1-dev", prompt: "cat", n: 2, size: "1024x1024",
      quality: "hd", style: "vivid", response_format: "b64_json",
    });
  });
});

describe("handleImageGenerationCore with a custom-image node", () => {
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

  it("posts to the node's baseUrl and passes the OpenAI-shaped response through", async () => {
    global.fetch.mockResolvedValueOnce(okResponse());

    const result = await handleImageGenerationCore({
      body: { model: "flux-1-dev", prompt: "a red panda" },
      modelInfo: { provider: nodeId, model: "flux-1-dev" },
      credentials: creds("https://ha.ntu.my.id/v1"),
      log: null,
    });

    expect(result.success).toBe(true);
    const [calledUrl, options] = global.fetch.mock.calls[0];
    expect(calledUrl).toBe("https://ha.ntu.my.id/v1/images/generations");
    expect(options.headers["Authorization"]).toBe("Bearer sk-custom");
    expect(JSON.parse(options.body)).toMatchObject({ model: "flux-1-dev", prompt: "a red panda", n: 1 });
  });

  it("rejects unknown providers as before (custom-embedding is not an image provider)", async () => {
    const result = await handleImageGenerationCore({
      body: { prompt: "test" },
      modelInfo: { provider: "custom-embedding-x", model: "m" },
      credentials: { apiKey: "k" },
      log: null,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("does not support image generation");
  });
});
