"use client";

import { useMemo, useState } from "react";
import PropTypes from "prop-types";
import { cn } from "@/shared/utils/cn";
import { fmt, fmtTokens, fmtCost2, shortDate } from "@/shared/utils/format";
import {
  todayKey,
  metricValue,
  fmtByMetric,
  intensityLevel,
  monthLabels,
} from "../lib/heatmapUtils";

/**
 * 5-level intensity fill classes for heatmap cells (validator-passed — do
 * not change the mapping).
 */
export const LEVEL_CLASSES = [
  "bg-surface-2",
  "bg-brand-300 dark:bg-brand-700",
  "bg-brand-500",
  "bg-brand-600 dark:bg-brand-300",
  "bg-brand-800 dark:bg-brand-100",
];

const METRIC_LABELS = { tokens: "Tokens", requests: "Requests", cost: "Cost" };
const OTHER_METRICS = {
  tokens: ["requests", "cost"],
  requests: ["tokens", "cost"],
  cost: ["tokens", "requests"],
};
const WEEKDAY_LABELS = [
  ["Mon", 2],
  ["Wed", 4],
  ["Fri", 6],
];

/** Compact value for a given metric on a daily row (tooltip fallback lines). */
function fmtMetricValue(metric, day) {
  if (!day) return "0";
  if (metric === "tokens") return fmtTokens(day.tokens || 0);
  if (metric === "requests") return fmt(day.requests || 0);
  return fmtCost2(day.cost || 0);
}

/**
 * GitHub-contribution-graph style activity heatmap.
 * Row 1 = month labels, rows 2-8 = day cells; column 1 = weekday labels,
 * week columns start at 2 (Sunday-aligned weeks from buildGridDays).
 */
export default function ActivityHeatmap({
  gridDays,
  daysByDate,
  metric,
  max,
  selectedDate = null,
  onSelectDate = null,
  refetching = false,
}) {
  const [hover, setHover] = useState(null);

  const labels = useMemo(() => monthLabels(gridDays), [gridDays]);
  const today = todayKey();

  const hoverDay = hover ? daysByDate.get(hover.dateKey) || null : null;
  const hoverValue = hoverDay ? metricValue(hoverDay, metric) : 0;

  if (!gridDays || gridDays.length === 0) return null;

  return (
    <div className="custom-scrollbar relative overflow-x-auto">
      <div
        className={cn("transition-opacity", refetching && "opacity-60")}
        style={{
          display: "inline-grid",
          gridTemplateRows: "repeat(8, 12px)",
          gridAutoColumns: "12px",
          gridAutoFlow: "column",
          gap: "2px",
        }}
      >
        {labels.map(({ weekIndex, label }) => (
          <span
            key={`month-${weekIndex}`}
            className="text-text-muted text-[9px] leading-[12px] whitespace-nowrap self-start"
            style={{ gridColumn: weekIndex + 2, gridRow: 1 }}
          >
            {label}
          </span>
        ))}

        {WEEKDAY_LABELS.map(([label, row]) => (
          <span
            key={label}
            className="text-text-muted text-[9px] leading-[12px] whitespace-nowrap"
            style={{ gridColumn: 1, gridRow: row }}
          >
            {label}
          </span>
        ))}

        {gridDays.map((dateKey, i) => {
          const gridColumn = Math.floor(i / 7) + 2;
          const gridRow = (i % 7) + 2;

          // Future days: inert placeholders, keep the grid rectangular.
          if (dateKey > today) {
            return (
              <div
                key={dateKey}
                aria-hidden="true"
                className="bg-transparent h-3 w-3 rounded-[3px]"
                style={{ gridColumn, gridRow }}
              />
            );
          }

          const day = daysByDate.get(dateKey);
          const level = day ? intensityLevel(metricValue(day, metric), max) : 0;
          const isSelected = selectedDate === dateKey;
          const isToday = dateKey === today;
          const dayLabel = day
            ? `${shortDate(dateKey)}: ${fmtTokens(day.tokens || 0)} tokens, ${fmt(day.requests || 0)} requests, ${fmtCost2(day.cost || 0)}`
            : `${shortDate(dateKey)}: no activity`;

          return (
            <div
              key={dateKey}
              role="button"
              tabIndex={0}
              aria-label={dayLabel}
              title={dayLabel}
              onClick={() => onSelectDate?.(dateKey)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelectDate?.(dateKey);
                }
              }}
              onMouseEnter={(e) =>
                setHover({
                  dateKey,
                  x: e.currentTarget.offsetLeft,
                  y: e.currentTarget.offsetTop,
                })
              }
              onMouseLeave={() => setHover(null)}
              className={cn(
                "h-3 w-3 cursor-pointer rounded-[3px] focus-visible:outline",
                LEVEL_CLASSES[level],
                isSelected
                  ? "ring-text-main ring-2"
                  : isToday && "ring-primary ring-1"
              )}
              style={{ gridColumn, gridRow }}
            />
          );
        })}
      </div>

      {hover && (
        <div
          className="bg-surface border-border pointer-events-none absolute z-10 rounded-lg border px-2.5 py-1.5 text-[11px] whitespace-nowrap shadow-lg"
          style={{ left: hover.x + 16, top: hover.y }}
        >
          <div className="text-text-main">
            <span className="font-semibold">{fmtByMetric(hoverValue, metric)}</span>{" "}
            {METRIC_LABELS[metric]}
          </div>
          <div className="text-text-muted">
            {shortDate(hover.dateKey)}
            {hoverDay && (
              <span className="opacity-70">
                {" · "}
                {OTHER_METRICS[metric]
                  .map((m) => `${fmtMetricValue(m, hoverDay)} ${m}`)
                  .join(" · ")}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

ActivityHeatmap.propTypes = {
  gridDays: PropTypes.arrayOf(PropTypes.string).isRequired,
  daysByDate: PropTypes.instanceOf(Map).isRequired,
  metric: PropTypes.oneOf(["tokens", "requests", "cost"]).isRequired,
  max: PropTypes.number.isRequired,
  selectedDate: PropTypes.string,
  onSelectDate: PropTypes.func,
  refetching: PropTypes.bool,
};
