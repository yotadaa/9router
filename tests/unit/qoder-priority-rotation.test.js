import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: db.getProviderConnections,
  updateProviderConnection: db.updateProviderConnection,
  validateApiKey: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(),
  pickProxyPoolId: vi.fn(),
}));

const { isQoderLimitReached, markAccountUnavailable } = await import("../../src/sse/services/auth.js");

describe("Qoder limit priority rotation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.updateProviderConnection.mockResolvedValue({});
  });

  it("recognizes Qoder quota-limit messages as well as HTTP 429", () => {
    expect(isQoderLimitReached(429, "too many requests")).toBe(true);
    expect(isQoderLimitReached(403, "daily quota limit reached")).toBe(true);
    expect(isQoderLimitReached(401, "token expired")).toBe(false);
  });

  it("moves only a Qoder connection with exhausted quota to the last priority", async () => {
    db.getProviderConnections.mockResolvedValue([
      { id: "qoder-main", priority: 1, name: "Main" },
      { id: "qoder-next", priority: 2, name: "Next" },
      { id: "qoder-third", priority: 3, name: "Third" },
    ]);

    const result = await markAccountUnavailable(
      "qoder-main",
      429,
      "daily quota limit reached",
      "qoder",
      "qmodel_38max",
    );

    expect(result.shouldFallback).toBe(true);
    expect(db.updateProviderConnection).toHaveBeenCalledWith(
      "qoder-main",
      expect.objectContaining({
        priority: 4,
        errorCode: 429,
        modelLock_qmodel_38max: expect.any(String),
      }),
    );
  });

  it("does not change priority for another provider's rate limit", async () => {
    db.getProviderConnections.mockResolvedValue([
      { id: "other-main", priority: 1, name: "Main" },
      { id: "other-next", priority: 2, name: "Next" },
    ]);

    await markAccountUnavailable("other-main", 429, "rate limit reached", "openai", "gpt-test");

    expect(db.updateProviderConnection).toHaveBeenCalledWith(
      "other-main",
      expect.not.objectContaining({ priority: expect.anything() }),
    );
  });
});
