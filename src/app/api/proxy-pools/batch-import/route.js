import { NextResponse } from "next/server";
import { bulkCreateProxyPools, getProxyPools } from "@/lib/db/index.js";
import {
  countPhysicalLinesUpTo,
  deduplicateProxyEntries,
  parseProxyBatch,
} from "@/lib/proxyPools/batchImport.js";

const MAX_INPUT_CHARACTERS = 20_000_000;
const MAX_IMPORT_LINES = 100_000;
const MAX_PARSING_ERROR_SAMPLES = 100;

// Serialize the read/dedupe/write critical section across requests in this
// local server process. This prevents two tabs from importing the same URLs
// between the existing-row snapshot and the transaction.
const lockState = globalThis.__proxyPoolBatchImportLock
  || (globalThis.__proxyPoolBatchImportLock = { tail: Promise.resolve() });

async function runImportExclusively(task) {
  const previous = lockState.tail;
  let release;
  lockState.tail = new Promise((resolve) => { release = resolve; });

  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}

function buildSummary({ totalLines, created = 0, duplicatesSkipped = 0, failedParsing = 0 }) {
  return {
    totalLines,
    created,
    duplicatesSkipped,
    failed: 0,
    failedParsing,
  };
}

export async function POST(request) {
  const startedAt = Date.now();

  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const textInput = typeof body?.text === "string" ? body.text : "";
    if (!textInput.trim()) {
      return NextResponse.json({ error: "No proxy data provided" }, { status: 400 });
    }
    if (textInput.length > MAX_INPUT_CHARACTERS) {
      return NextResponse.json(
        { error: "Proxy import is too large" },
        { status: 413 }
      );
    }
    if (countPhysicalLinesUpTo(textInput, MAX_IMPORT_LINES) > MAX_IMPORT_LINES) {
      return NextResponse.json(
        { error: `A maximum of ${MAX_IMPORT_LINES.toLocaleString()} physical lines can be imported at once` },
        { status: 413 }
      );
    }

    console.log(`[Batch Import] Starting transactional import (${textInput.length.toLocaleString()} characters)`);

    const parsed = parseProxyBatch(textInput);
    console.log(`[Batch Import] Parsed ${parsed.entries.length} entries with ${parsed.parsingErrors.length} errors`);

    // Keep imports atomic: malformed input never produces a partially-created batch.
    if (parsed.parsingErrors.length > 0) {
      return NextResponse.json(
        {
          error: `Found ${parsed.parsingErrors.length} invalid proxy line(s); no proxies were imported`,
          parsingErrors: parsed.parsingErrors.slice(0, MAX_PARSING_ERROR_SAMPLES),
          parsingErrorCount: parsed.parsingErrors.length,
          summary: buildSummary({
            totalLines: parsed.totalLines,
            failedParsing: parsed.parsingErrors.length,
          }),
        },
        { status: 400 }
      );
    }

    // The authenticated outer request already passed the dashboard guard. Read
    // and write the local database directly instead of self-fetching this API.
    const { created, duplicatesSkipped } = await runImportExclusively(async () => {
      const existingPools = await getProxyPools();
      const deduplicated = deduplicateProxyEntries(parsed.entries, existingPools);

      console.log(
        `[Batch Import] ${deduplicated.duplicatesSkipped} duplicate(s), ${deduplicated.entries.length} new proxy pool(s)`
      );

      // buildProxyPool selects persisted fields, so the parser-only lineNumber
      // property is intentionally ignored without cloning all 40k entries.
      const inserted = await bulkCreateProxyPools(deduplicated.entries);
      if (inserted !== deduplicated.entries.length) {
        throw new Error(`Bulk insert count mismatch: expected ${deduplicated.entries.length}, created ${inserted}`);
      }

      return { created: inserted, duplicatesSkipped: deduplicated.duplicatesSkipped };
    });

    const durationMs = Date.now() - startedAt;
    const averageImportTime = created > 0
      ? Number((durationMs / created).toFixed(2))
      : 0;

    console.log(
      `[Batch Import] Complete: ${created} created, ${duplicatesSkipped} duplicate(s) skipped in ${durationMs}ms`
    );

    return NextResponse.json({
      success: true,
      summary: buildSummary({
        totalLines: parsed.totalLines,
        created,
        duplicatesSkipped,
      }),
      meta: {
        durationMs,
        averageImportTime,
        throughputPerSecond: durationMs > 0 ? Math.round((created * 1000) / durationMs) : created,
        writeStrategy: "single-transaction",
      },
    });
  } catch (error) {
    console.error("[Batch Import] Transaction failed:", error);
    return NextResponse.json(
      {
        error: "Failed to import proxy batch; no proxies from this transaction were created",
        details: process.env.NODE_ENV === "development" ? error?.message : undefined,
      },
      { status: 500 }
    );
  }
}
