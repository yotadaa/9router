"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CardSkeleton } from "@/shared/components";
import OverviewStatCards from "./components/OverviewStatCards";
import ActivityCalendarCard from "./components/ActivityCalendarCard";
import DayDetail from "./components/DayDetail";
import InsightsRow from "./components/InsightsRow";
import { computeStreaks, rangeCutoffKey } from "./lib/heatmapUtils";

const REFRESH_INTERVAL_MS = 60000;

/**
 * /dashboard/overview orchestrator.
 * Fetches ALL daily rows once (usageDaily is pre-aggregated — one row per
 * active day ever), then serves metric/range toggles entirely client-side.
 * Light 60s poll keeps totals fresh without SSE.
 */
export default function OverviewPageClient() {
  const [days, setDays] = useState(null);
  const [todayStats, setTodayStats] = useState(null);
  const [lifetimeStats, setLifetimeStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refetching, setRefetching] = useState(false);
  const [error, setError] = useState("");

  const [metric, setMetric] = useState("tokens");
  const [rangeMonths, setRangeMonths] = useState(12);
  const [selectedDate, setSelectedDate] = useState(null);

  const fetchAll = useCallback(async (isInitial) => {
    // Initial render already shows the skeleton (loading starts true);
    // subsequent polls dim the content instead.
    if (!isInitial) setRefetching(true);
    try {
      const [dailyRes, todayRes, allRes] = await Promise.all([
        fetch("/api/usage/daily", { cache: "no-store" }),
        fetch("/api/usage/stats?period=today", { cache: "no-store" }),
        fetch("/api/usage/stats?period=all", { cache: "no-store" }),
      ]);
      if (!dailyRes.ok) throw new Error("Failed to load activity data");
      const dailyRows = await dailyRes.json();
      setDays(Array.isArray(dailyRows) ? dailyRows : []);
      setTodayStats(todayRes.ok ? await todayRes.json() : null);
      setLifetimeStats(allRes.ok ? await allRes.json() : null);
      setError("");
    } catch (e) {
      if (isInitial) setError(e.message || "Failed to load overview data");
    } finally {
      setLoading(false);
      setRefetching(false);
    }
  }, []);

  useEffect(() => {
    fetchAll(true);
    const timer = setInterval(() => fetchAll(false), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [fetchAll]);

  const streaks = useMemo(() => computeStreaks(days || []), [days]);

  const daysByDate = useMemo(
    () => new Map((days || []).map((d) => [d.dateKey, d])),
    [days],
  );

  const rangeDays = useMemo(() => {
    const cutoff = rangeCutoffKey(rangeMonths);
    return (days || []).filter((d) => d.dateKey >= cutoff);
  }, [days, rangeMonths]);

  const selectedDay = selectedDate ? daysByDate.get(selectedDate) || null : null;

  const handleSelectDate = useCallback((dateKey) => {
    setSelectedDate((prev) => (prev === dateKey ? null : dateKey));
  }, []);

  if (loading) {
    return (
      <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
        <CardSkeleton />
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
        <div className="rounded-[14px] border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-500">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      <OverviewStatCards
        days={days || []}
        todayStats={todayStats}
        lifetimeStats={lifetimeStats}
        streaks={streaks}
        loading={false}
      />

      <ActivityCalendarCard
        days={days || []}
        metric={metric}
        onMetricChange={setMetric}
        rangeMonths={rangeMonths}
        onRangeChange={setRangeMonths}
        selectedDate={selectedDate}
        onSelectDate={handleSelectDate}
        refetching={refetching}
      />

      {selectedDay ? (
        <DayDetail day={selectedDay} onClose={() => setSelectedDate(null)} />
      ) : (
        <InsightsRow
          days={days || []}
          streaks={streaks}
          rangeDays={rangeDays}
          rangeMonths={rangeMonths}
        />
      )}
    </div>
  );
}
