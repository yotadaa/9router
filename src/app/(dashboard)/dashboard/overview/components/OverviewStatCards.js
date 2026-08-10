"use client";

import { useMemo } from "react";
import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import { fmt, fmtCost2, fmtTokens, shortDate } from "@/shared/utils/format";

/**
 * Overview stat tiles — lifetime totals + today deltas + streaks.
 * Same grid/tile pattern as dashboard/usage OverviewCards.
 * days = ALL daily rows (pre-aggregated by /api/usage/daily).
 */
export default function OverviewStatCards({
  days,
  todayStats,
  lifetimeStats,
  streaks,
  loading,
}) {
  const sums = useMemo(() => {
    const rows = Array.isArray(days) ? days : [];
    let tokens = 0;
    let cost = 0;
    let activeCount = 0;
    for (const d of rows) {
      tokens += d.tokens || 0;
      cost += d.cost || 0;
      if ((d.requests || 0) > 0) activeCount += 1;
    }
    return { tokens, cost, activeCount };
  }, [days]);

  const providerCount = lifetimeStats
    ? Object.keys(lifetimeStats.byProvider || {}).length
    : 0;
  const todayTokens =
    (todayStats?.totalPromptTokens || 0) + (todayStats?.totalCompletionTokens || 0);

  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 sm:gap-4">
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm uppercase font-semibold">Lifetime Requests</span>
        <span className="truncate text-2xl font-bold">
          {loading ? "…" : fmt(lifetimeStats?.totalRequests)}
        </span>
        <span className="text-xs text-text-muted truncate">
          {loading ? "…" : `${fmt(providerCount)} providers active`}
        </span>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm uppercase font-semibold">Lifetime Tokens</span>
        <span className="truncate text-2xl font-bold text-primary">
          {loading ? "…" : fmtTokens(sums.tokens)}
        </span>
        <span className="text-xs text-text-muted truncate">
          {loading ? "…" : `${fmtTokens(todayTokens)} today`}
        </span>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm uppercase font-semibold">Est. Cost</span>
        <span className="truncate text-2xl font-bold text-warning">
          {loading ? "…" : `~${fmtCost2(sums.cost)}`}
        </span>
        <span className="text-xs text-text-muted truncate">
          {loading ? "…" : `${fmtCost2(todayStats?.totalCost || 0)} today`}
        </span>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm uppercase font-semibold">Active Days</span>
        <span className="truncate text-2xl font-bold text-info">
          {loading ? "…" : `${fmt(sums.activeCount)} / ${fmt(days?.length || 0)}`}
        </span>
        <span className="text-xs text-text-muted truncate">
          {loading ? "…" : `${fmt(streaks?.current || 0)}-day streak`}
        </span>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm uppercase font-semibold">Busiest Day</span>
        <span className="truncate text-2xl font-bold text-success">
          {loading ? "…" : fmtTokens(streaks?.busiestDay?.value || 0)}
        </span>
        <span className="text-xs text-text-muted truncate">
          {loading ? "…" : shortDate(streaks?.busiestDay?.dateKey) || "—"}
        </span>
      </Card>
    </div>
  );
}

OverviewStatCards.propTypes = {
  days: PropTypes.array.isRequired,
  todayStats: PropTypes.object,
  lifetimeStats: PropTypes.object,
  streaks: PropTypes.object,
  loading: PropTypes.bool,
};
