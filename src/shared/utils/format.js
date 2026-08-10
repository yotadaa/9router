/**
 * Shared formatting helpers for usage/analytics UI.
 * Single source for the token/cost/number formatters previously duplicated
 * across OverviewCards, UsageChart, UsageTable, PxpipeClient, and the
 * overview page.
 */

/** Locale-aware integer formatting: 12345 → "12,345" */
export const fmt = (n) => new Intl.NumberFormat().format(n || 0);

/** Compact token counts: 12.4K / 1.2M */
export const fmtTokens = (n) => {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n || 0);
};

/** Cost with 2 decimals (stat tiles, tables) */
export const fmtCost2 = (n) => `$${(n || 0).toFixed(2)}`;

/** Cost with 4 decimals (chart tooltips) */
export const fmtCost4 = (n) => `$${(n || 0).toFixed(4)}`;

/** "Aug 5" from a YYYY-MM-DD dateKey (string-split; no Date parsing → no TZ shift) */
export function shortDate(dateKey) {
  if (!dateKey) return "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const [y, m, d] = dateKey.split("-");
  const month = months[Number(m) - 1] || m;
  return `${month} ${Number(d)}, ${y}`;
}

/** "Tue, Aug 5, 2026" — weekday from a local-noon Date built from the dateKey */
export function fullDate(dateKey) {
  if (!dateKey) return "";
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(y, m - 1, d, 12);
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
