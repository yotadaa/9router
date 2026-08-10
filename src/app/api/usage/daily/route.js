import { NextResponse } from "next/server";
import { getUsageDaily } from "@/lib/db/index.js";

/**
 * GET /api/usage/daily
 *
 * Compact per-day usage rows for the overview activity calendar.
 * Query: optional `days=1..400` window (omit for all rows).
 * Response: [{ dateKey, requests, tokens, cost, byProvider, byModel }] asc,
 * where tokens = promptTokens + completionTokens for that day.
 */
export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const daysParam = searchParams.get("days");
    let maxDays = null;
    if (daysParam != null && daysParam !== "") {
      maxDays = Number(daysParam);
      if (!Number.isFinite(maxDays) || maxDays < 1 || maxDays > 400) {
        return NextResponse.json(
          { error: "Invalid 'days' param (must be a number between 1 and 400)" },
          { status: 400 },
        );
      }
      maxDays = Math.floor(maxDays);
    }
    const rows = await getUsageDaily(maxDays);
    return NextResponse.json(rows);
  } catch (error) {
    console.error("Error fetching daily usage:", error);
    return NextResponse.json(
      { error: "Failed to fetch daily usage" },
      { status: 500 },
    );
  }
}
