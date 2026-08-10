"use client";

import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { UsageStats, RequestLogger, CardSkeleton, SegmentedControl } from "@/shared/components";
import RequestDetailsTab from "./components/RequestDetailsTab";

const PERIODS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "60d", label: "60D" },
  { value: "12mo", label: "12M" },
];

export default function UsagePage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <UsageContent />
    </Suspense>
  );
}

function UsageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [period, setPeriod] = useState("today");
  const [recalculating, setRecalculating] = useState(false);

  const tabFromUrl = searchParams.get("tab");
  const activeTab = tabFromUrl && ["overview", "logs", "details"].includes(tabFromUrl)
    ? tabFromUrl
    : "overview";

  const handleTabChange = (value) => {
    if (value === activeTab) return;
    const params = new URLSearchParams(searchParams);
    params.set("tab", value);
    router.push(`/dashboard/usage?${params.toString()}`, { scroll: false });
  };

  // Recompute historical request costs with the current model pricing config.
  // UsageStats polls /api/usage/stats every second, so the new totals appear shortly.
  const handleRecalculateCosts = async () => {
    if (recalculating) return;
    setRecalculating(true);
    try {
      const res = await fetch("/api/usage/recalculate-costs", { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Recalculate failed (${res.status})`);
      }
    } catch (e) {
      alert(e.message || "Failed to recalculate costs");
    } finally {
      setRecalculating(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {/* Tabs + period selector on same row */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <SegmentedControl
          options={[
            { value: "overview", label: "Overview" },
            { value: "details", label: "Details" },
          ]}
          value={activeTab}
          onChange={handleTabChange}
          className="w-full sm:w-auto"
        />
        <div className="flex items-center gap-2">
          {activeTab === "overview" && (
            <button
              type="button"
              onClick={handleRecalculateCosts}
              disabled={recalculating}
              title="Recompute historical costs using the current model pricing configuration"
              className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-black/10 px-2 text-xs text-text-primary transition-colors hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:hover:bg-white/5"
            >
              <span className={`material-symbols-outlined text-[14px] ${recalculating ? "animate-spin" : ""}`}>
                {recalculating ? "progress_activity" : "calculate"}
              </span>
              <span className="hidden sm:inline">{recalculating ? "Recalculating..." : "Recalculate Costs"}</span>
            </button>
          )}
          {activeTab === "overview" && (
            <SegmentedControl
              options={PERIODS}
              value={period}
              onChange={setPeriod}
              size="sm"
              className="w-full sm:w-auto"
            />
          )}
        </div>
      </div>

      {activeTab === "overview" && (
        <Suspense fallback={<CardSkeleton />}>
          <UsageStats period={period} setPeriod={setPeriod} hidePeriodSelector />
        </Suspense>
      )}
      {activeTab === "logs" && <RequestLogger />}
      {activeTab === "details" && <RequestDetailsTab />}
    </div>
  );
}
