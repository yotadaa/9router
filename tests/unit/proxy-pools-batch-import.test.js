import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getProxyPools: vi.fn(),
  bulkCreateProxyPools: vi.fn(),
}));

vi.mock("@/lib/db/index.js", () => dbMocks);

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "content-type": "application/json" },
      });
    },
  },
}));

import {
  countPhysicalLinesUpTo,
  deduplicateProxyEntries,
  normalizeProxyUrlForComparison,
  parseProxyBatch,
} from "@/lib/proxyPools/batchImport.js";
import { POST } from "@/app/api/proxy-pools/batch-import/route.js";

function makeRequest(text) {
  return new Request("http://localhost/api/proxy-pools/batch-import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

beforeEach(() => {
  dbMocks.getProxyPools.mockReset().mockResolvedValue([]);
  dbMocks.bulkCreateProxyPools.mockReset().mockImplementation(async (entries) => entries.length);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("proxy pool batch import parsing", () => {
  it("canonicalizes URL structure without lowercasing credentials", () => {
    expect(normalizeProxyUrlForComparison("HTTP://User:Pass@EXAMPLE.COM:80"))
      .toBe("http://User:Pass@example.com/");
    expect(normalizeProxyUrlForComparison("http://user:Pass@example.com/"))
      .not.toBe("http://User:Pass@example.com/");
  });

  it("reports physical line numbers and supports both documented formats", () => {
    const parsed = parseProxyBatch([
      "http://user:pass@example.com:8080",
      "",
      "proxy.test:3128:alice:secret",
      "invalid-line",
    ].join("\n"));

    expect(parsed.totalLines).toBe(3);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[1]).toMatchObject({
      lineNumber: 3,
      proxyUrl: "http://alice:secret@proxy.test:3128/",
    });
    expect(parsed.parsingErrors).toEqual([
      expect.objectContaining({ lineNumber: 4 }),
    ]);
  });

  it("rejects unsupported proxy protocols", () => {
    const parsed = parseProxyBatch("ftp://proxy.test:21");

    expect(parsed.entries).toHaveLength(0);
    expect(parsed.parsingErrors).toEqual([
      expect.objectContaining({ lineNumber: 1, error: "Unsupported proxy protocol: ftp:" }),
    ]);
  });

  it("stops physical line counting once the safety limit is exceeded", () => {
    expect(countPhysicalLinesUpTo("one\ntwo\nthree", 2)).toBe(3);
    expect(countPhysicalLinesUpTo("one\ntwo", 2)).toBe(2);
  });

  it("counts duplicates from storage and earlier lines in the same input", () => {
    const parsed = parseProxyBatch([
      "http://User:Pass@example.com/",
      "HTTP://Other:Pass@EXAMPLE.COM:80",
      "http://Other:Pass@example.com/",
      "http://user:Pass@example.com/",
    ].join("\n"));

    const result = deduplicateProxyEntries(parsed.entries, [
      { proxyUrl: "HTTP://User:Pass@EXAMPLE.COM:80" },
    ]);

    expect(result.duplicatesSkipped).toBe(2);
    expect(result.entries.map((entry) => entry.proxyUrl)).toEqual([
      "http://Other:Pass@example.com/",
      "http://user:Pass@example.com/",
    ]);
  });
});

describe("POST /api/proxy-pools/batch-import", () => {
  it("uses one bulk database call and never self-fetches the proxy API", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("batch import must not call fetch");
    });
    vi.stubGlobal("fetch", fetchSpy);

    dbMocks.getProxyPools.mockResolvedValue([
      { proxyUrl: "HTTP://User:Pass@EXAMPLE.COM:80" },
    ]);

    const response = await POST(makeRequest([
      "http://User:Pass@example.com/",
      "HTTP://Other:Pass@EXAMPLE.COM:80",
      "http://Other:Pass@example.com/",
      "proxy.test:3128:alice:secret",
    ].join("\n")));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(dbMocks.bulkCreateProxyPools).toHaveBeenCalledTimes(1);
    expect(dbMocks.bulkCreateProxyPools.mock.calls[0][0]).toHaveLength(2);
    expect(body).toMatchObject({
      success: true,
      summary: {
        totalLines: 4,
        created: 2,
        duplicatesSkipped: 2,
        failed: 0,
        failedParsing: 0,
      },
      meta: {
        writeStrategy: "single-transaction",
      },
    });
  });

  it("rejects the whole batch before reading or writing the database when a line is invalid", async () => {
    const response = await POST(makeRequest("http://ok.test:8080\ninvalid-line"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      summary: {
        totalLines: 2,
        created: 0,
        failedParsing: 1,
      },
      parsingErrorCount: 1,
    });
    expect(dbMocks.getProxyPools).not.toHaveBeenCalled();
    expect(dbMocks.bulkCreateProxyPools).not.toHaveBeenCalled();
  });

  it("rejects more than 100k physical lines before reading the database", async () => {
    const response = await POST(makeRequest(`${"x\n".repeat(100000)}x`));

    expect(response.status).toBe(413);
    expect(dbMocks.getProxyPools).not.toHaveBeenCalled();
    expect(dbMocks.bulkCreateProxyPools).not.toHaveBeenCalled();
  });

  it("returns a server error instead of a false success when the transaction fails", async () => {
    dbMocks.bulkCreateProxyPools.mockRejectedValue(new Error("database unavailable"));

    const response = await POST(makeRequest("http://proxy.test:8080"));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toContain("no proxies from this transaction were created");
  });
});
