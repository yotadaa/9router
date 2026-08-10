import { NextResponse } from "next/server";
import { recalculateUsageCosts } from "@/lib/localDb";

/**
 * POST /api/usage/recalculate-costs
 *
 * Recomputes the cost column of every usageHistory row using the current
 * model pricing configuration, then rebuilds the usageDaily aggregates.
 * Call this after adding/changing model pricing so historical requests
 * reflect the configured rates on the Usage dashboard.
 */
export async function POST() {
  try {
    const result = await recalculateUsageCosts();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("Failed to recalculate usage costs:", error);
    return NextResponse.json(
      { ok: false, error: "Failed to recalculate usage costs" },
      { status: 500 },
    );
  }
}
