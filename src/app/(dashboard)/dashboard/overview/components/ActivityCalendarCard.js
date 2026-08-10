"use client";

import { useMemo } from "react";
import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import { SegmentedControl } from "@/shared/components";
import { fmtTokens, fmtCost2, fmt, shortDate } from "@/shared/utils/format";
import {
  metricValue,
  buildGridDays,
  rangeCutoffKey,
} from "../lib/heatmapUtils";
import ActivityHeatmap, { LEVEL_CLASSES } from "./ActivityHeatmap";

const METRIC_OPTIONS = [
  { value: "tokens", label: "Tokens" },
  { value: "requests", label: "Requests" },
  { value: "cost", label: "Cost" },
];

const RANGE_OPTIONS = [
  { value: 3, label: "3M" },
  { value: 6, label: "6M" },
  { value: 12, label: "12M" },
];

/**
 * "Activity" card: GitHub-style contribution heatmap of gateway usage with
 * metric (tokens/requests/cost) and range (3/6/12 months) toggles.
 * All computation is client-side — `days` holds every fetched daily row.
 */
export default function ActivityCalendarCard({
  days,
  metric,
  onMetricChange,
  rangeMonths,
  onRangeChange,
  selectedDate,
  onSelectDate,
  refetching = false,
}) {
  const { gridDays, rangeDays, daysByDate, max, totals } = useMemo(() => {
    const cutoff = rangeCutoffKey(rangeMonths);
    const rangeDays = (days || []).filter((d) => d.dateKey >= cutoff);
    const daysByDate = new Map(rangeDays.map((d) => [d.dateKey, d]));
    const max = rangeDays.reduce(
      (m, d) => Math.max(m, metricValue(d, metric)),
      0
    );
    const totals = rangeDays.reduce(
      (acc, d) => ({
        tokens: acc.tokens + (d.tokens || 0),
        requests: acc.requests + (d.requests || 0),
        cost: acc.cost + (d.cost || 0),
      }),
      { tokens: 0, requests: 0, cost: 0 }
    );
    return { gridDays: buildGridDays(rangeMonths), rangeDays, daysByDate, max, totals };
  }, [days, metric, rangeMonths]);

  const subtitle =
    rangeDays.length === 0
      ? "No activity in range"
      : `${fmtTokens(totals.tokens)} tokens · ${fmt(totals.requests)} requests · ${fmtCost2(totals.cost)} · ${shortDate(rangeDays[0].dateKey)} – ${shortDate(rangeDays[rangeDays.length - 1].dateKey)}`;

  return (
    <Card
      title="Activity"
      subtitle={subtitle}
      action={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <SegmentedControl
            options={METRIC_OPTIONS}
            value={metric}
            onChange={onMetricChange}
            size="sm"
          />
          <SegmentedControl
            options={RANGE_OPTIONS}
            value={rangeMonths}
            onChange={onRangeChange}
            size="sm"
          />
        </div>
      }
    >
      {rangeDays.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
          <span className="material-symbols-outlined text-text-muted text-4xl opacity-40">
            calendar_month
          </span>
          <p className="text-text-muted text-sm">
            No activity yet — requests routed through the gateway will appear
            here.
          </p>
        </div>
      ) : (
        <>
          <ActivityHeatmap
            gridDays={gridDays}
            daysByDate={daysByDate}
            metric={metric}
            max={max}
            selectedDate={selectedDate}
            onSelectDate={onSelectDate}
            refetching={refetching}
          />
          <div className="mt-3 flex items-center justify-between">
            <div className="text-text-muted flex items-center gap-1.5 text-[10px]">
              <span>Less</span>
              <span className="flex items-center gap-[2px]">
                {LEVEL_CLASSES.map((cls) => (
                  <span
                    key={cls}
                    aria-hidden="true"
                    className={`h-3 w-3 rounded-[3px] ${cls}`}
                  />
                ))}
              </span>
              <span>More</span>
            </div>
            <span className="text-text-muted text-[10px]">
              Click a day for details
            </span>
          </div>
        </>
      )}
    </Card>
  );
}

ActivityCalendarCard.propTypes = {
  days: PropTypes.arrayOf(
    PropTypes.shape({
      dateKey: PropTypes.string.isRequired,
      requests: PropTypes.number,
      tokens: PropTypes.number,
      cost: PropTypes.number,
      byProvider: PropTypes.object,
      byModel: PropTypes.object,
    })
  ).isRequired,
  metric: PropTypes.oneOf(["tokens", "requests", "cost"]).isRequired,
  onMetricChange: PropTypes.func.isRequired,
  rangeMonths: PropTypes.oneOf([3, 6, 12]).isRequired,
  onRangeChange: PropTypes.func.isRequired,
  selectedDate: PropTypes.string,
  onSelectDate: PropTypes.func,
  refetching: PropTypes.bool,
};
