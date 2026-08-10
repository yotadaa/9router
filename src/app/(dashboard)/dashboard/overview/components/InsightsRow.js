"use client";

import { useMemo } from "react";
import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import { fmt, fmtCost2, fmtTokens, shortDate } from "@/shared/utils/format";

/** Σ tokens / requests / cost + best day over a list of daily rows. */
function summarize(rows) {
  let tokens = 0;
  let requests = 0;
  let cost = 0;
  let activeDays = 0;
  let best = null;
  for (const d of rows) {
    tokens += d.tokens || 0;
    requests += d.requests || 0;
    cost += d.cost || 0;
    if ((d.requests || 0) > 0) activeDays += 1;
    if (!best || (d.tokens || 0) > (best.tokens || 0)) best = d;
  }
  return { tokens, requests, cost, activeDays, best };
}

function InsightRow({ label, value }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 text-sm">
      <span className="text-text-muted truncate">{label}</span>
      <span className="text-text-main shrink-0 font-medium">{value}</span>
    </div>
  );
}

InsightRow.propTypes = {
  label: PropTypes.string,
  value: PropTypes.node,
};

/**
 * Three insight cards: streaks, the selected calendar range, and lifetime.
 * All totals derived from the days arrays (pure client-side aggregation).
 */
export default function InsightsRow({ days, streaks, rangeDays, rangeMonths }) {
  const range = useMemo(() => summarize(Array.isArray(rangeDays) ? rangeDays : []), [rangeDays]);
  const lifetime = useMemo(() => summarize(Array.isArray(days) ? days : []), [days]);

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      <Card title="Streaks" padding="xs">
        <div className="flex flex-col gap-1.5">
          <InsightRow label="Current streak" value={`${fmt(streaks?.current || 0)} days`} />
          <InsightRow
            label="Longest streak"
            value={`${fmt(streaks?.longest || 0)} days${
              streaks?.longestStart && streaks?.longestEnd
                ? ` (${shortDate(streaks.longestStart)} → ${shortDate(streaks.longestEnd)})`
                : ""
            }`}
          />
          <InsightRow
            label="Busiest day"
            value={
              streaks?.busiestDay?.dateKey
                ? `${fmtTokens(streaks.busiestDay.value || 0)} on ${shortDate(streaks.busiestDay.dateKey)}`
                : "—"
            }
          />
        </div>
      </Card>

      <Card title={`Last ${rangeMonths} months`} padding="xs">
        <div className="flex flex-col gap-1.5">
          <InsightRow label="Tokens" value={fmtTokens(range.tokens)} />
          <InsightRow label="Requests" value={fmt(range.requests)} />
          <InsightRow label="Est. cost" value={fmtCost2(range.cost)} />
          <InsightRow
            label="Active days"
            value={`${fmt(range.activeDays)}/${fmt(rangeDays?.length || 0)} days`}
          />
          <InsightRow
            label="Best day"
            value={range.best?.dateKey ? `${shortDate(range.best.dateKey)} · ${fmtTokens(range.best.tokens || 0)}` : "—"}
          />
        </div>
      </Card>

      <Card title="Lifetime" padding="xs">
        <div className="flex flex-col gap-1.5">
          <InsightRow label="Tokens" value={fmtTokens(lifetime.tokens)} />
          <InsightRow label="Requests" value={fmt(lifetime.requests)} />
          <InsightRow label="Est. cost" value={fmtCost2(lifetime.cost)} />
          <InsightRow
            label="First activity"
            value={days?.length ? shortDate(days[0].dateKey) : "—"}
          />
        </div>
      </Card>
    </div>
  );
}

InsightsRow.propTypes = {
  days: PropTypes.array.isRequired,
  streaks: PropTypes.object,
  rangeDays: PropTypes.array.isRequired,
  rangeMonths: PropTypes.number.isRequired,
};
