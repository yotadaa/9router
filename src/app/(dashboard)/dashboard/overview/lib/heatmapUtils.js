/**
 * Heatmap / activity-calendar helpers for the Overview dashboard.
 *
 * Consumes daily usage rows from GET /api/usage/daily:
 *   { dateKey, requests, tokens, cost, byProvider, byModel }
 * where dateKey is "YYYY-MM-DD" (server-local day). All date math is done
 * with local Date parts — never toISOString()/UTC — so grid days line up
 * with the usage API's local day boundaries.
 */

import { fmt, fmtTokens, fmtCost2 } from "@/shared/utils/format";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad2 = (n) => String(n).padStart(2, "0");

/** Local Date → "YYYY-MM-DD" (local parts only; no toISOString → no UTC shift). */
export function toDateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** Today's dateKey (local). */
export function todayKey() {
  return toDateKey(new Date());
}

/** Value of a daily row for "tokens" | "requests" | "cost"; 0 if missing. */
export function metricValue(day, metric) {
  if (!day) return 0;
  return Number(day[metric]) || 0;
}

/** Human format for a metric value: tokens → fmtTokens, requests → thousands, cost → $x.xx. */
export function fmtByMetric(value, metric) {
  if (metric === "tokens") return fmtTokens(value);
  if (metric === "cost") return fmtCost2(value);
  return fmt(value);
}

/** Heatmap intensity 0..4: 0 when no activity, else max-relative quartile buckets 1..4. */
export function intensityLevel(value, max) {
  if (value <= 0 || max <= 0) return 0;
  return 1 + Math.min(3, Math.floor((value / max) * 4));
}

/** First day of the month that is (rangeMonths - 1) months back from the current month. */
function rangeStartDate(rangeMonths) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() - (rangeMonths - 1), 1);
}

/**
 * Every dateKey covering the full calendar grid for the range:
 * walks back from the range's first day to the preceding Sunday and
 * forward from today to the following Saturday (inclusive).
 */
export function buildGridDays(rangeMonths) {
  const now = new Date();
  const start = rangeStartDate(rangeMonths);
  const gridStart = new Date(start.getFullYear(), start.getMonth(), start.getDate() - start.getDay());
  const gridEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (6 - now.getDay()));

  const dayCount = Math.round((gridEnd - gridStart) / 86400000);
  const days = [];
  for (let i = 0; i <= dayCount; i++) {
    days.push(toDateKey(new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i)));
  }
  return days;
}

/**
 * Month labels for the grid columns: [{ weekIndex, label }].
 * A label lands on the week column containing the 1st of each month
 * (weekIndex = Math.floor(i / 7)); labels closer than 3 columns are skipped.
 * Month names come from string-splitting the dateKey — no Date parsing.
 * Note: every "-01" in gridDays is within the visible range by construction —
 * the grid starts at most 6 days before the range's 1st, and those leading
 * days are day ≥ 25 of the previous month.
 */
export function monthLabels(gridDays) {
  const labels = [];
  let lastWeek = null;
  for (let i = 0; i < gridDays.length; i++) {
    if (!gridDays[i].endsWith("-01")) continue;
    const weekIndex = Math.floor(i / 7);
    if (lastWeek !== null && weekIndex - lastWeek < 3) continue;
    labels.push({ weekIndex, label: MONTHS[Number(gridDays[i].split("-")[1]) - 1] });
    lastWeek = weekIndex;
  }
  return labels;
}

/** Whole-day difference between two "YYYY-MM-DD" keys (local noon → DST-safe). */
function daysBetween(aKey, bKey) {
  const [ay, am, ad] = aKey.split("-").map(Number);
  const [by, bm, bd] = bKey.split("-").map(Number);
  const a = new Date(ay, am - 1, ad, 12).getTime();
  const b = new Date(by, bm - 1, bd, 12).getTime();
  return Math.round((b - a) / 86400000);
}

/**
 * Streak stats over ALL daily rows (any order; sorted internally).
 * A day is "active" when requests > 0.
 * - current: consecutive active days ending today (or ending yesterday when
 *   today has no activity yet).
 * - longest/longestStart/longestEnd: best-ever active run (dateKeys; null when none).
 * - busiestDay: { dateKey, value } with the max tokens across rows
 *   ({ dateKey: null, value: 0 } when there are no rows).
 */
export function computeStreaks(days) {
  const rows = [...(days || [])].sort((a, b) => String(a.dateKey).localeCompare(String(b.dateKey)));

  let busiestDay = { dateKey: null, value: 0 };
  for (const row of rows) {
    const tokens = Number(row.tokens) || 0;
    if (tokens > busiestDay.value) busiestDay = { dateKey: row.dateKey, value: tokens };
  }

  const activeKeys = new Set(rows.filter((row) => Number(row.requests) > 0).map((row) => row.dateKey));

  // Current streak: count backward from today, or from yesterday if today is inactive.
  const today = new Date();
  let cursor = activeKeys.has(toDateKey(today))
    ? today
    : new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  let current = 0;
  while (activeKeys.has(toDateKey(cursor))) {
    current++;
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - 1);
  }

  // Longest streak: walk sorted unique active days, extending runs across 1-day gaps.
  const activeSorted = [...activeKeys].sort(); // "YYYY-MM-DD" sorts chronologically
  let longest = 0;
  let longestStart = null;
  let longestEnd = null;
  let runStart = null;
  let runLen = 0;
  let prevKey = null;
  for (const key of activeSorted) {
    if (prevKey !== null && daysBetween(prevKey, key) === 1) {
      runLen++;
    } else {
      runStart = key;
      runLen = 1;
    }
    if (runLen > longest) {
      longest = runLen;
      longestStart = runStart;
      longestEnd = key;
    }
    prevKey = key;
  }

  return { current, longest, longestStart, longestEnd, busiestDay };
}

/** dateKey of the range's first day — filter daily rows with dateKey >= this key. */
export function rangeCutoffKey(rangeMonths) {
  return toDateKey(rangeStartDate(rangeMonths));
}
