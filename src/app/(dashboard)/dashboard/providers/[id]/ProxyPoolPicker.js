"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 250;

export default function ProxyPoolPicker({
  value,
  onSelect,
  disabled = false,
  enabled = true,
  showNone = true,
  noneLabel = "None (direct connection)",
  className = "",
}) {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("latency-asc");
  const [page, setPage] = useState(1);
  const [proxyPools, setProxyPools] = useState([]);
  const [pagination, setPagination] = useState({
    page: 1,
    pageSize: PAGE_SIZE,
    filteredTotal: 0,
    totalPages: 0,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retryRevision, setRetryRevision] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    if (!enabled) return undefined;

    const controller = new AbortController();
    const load = async () => {
      setLoading(true);
      setError("");
      try {
        const params = new URLSearchParams({
          view: "picker",
          page: String(page),
          pageSize: String(PAGE_SIZE),
          sort,
        });
        if (search) params.set("search", search);

        const response = await fetch(`/api/proxy-pools?${params}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.error || "Unable to load proxy pools");
        }
        setProxyPools(data.proxyPools || []);
        setPagination({
          page: data.pagination?.page || 1,
          pageSize: data.pagination?.pageSize || PAGE_SIZE,
          filteredTotal: data.pagination?.filteredTotal || 0,
          totalPages: data.pagination?.totalPages || 0,
        });
        if (data.pagination?.page && data.pagination.page !== page) {
          setPage(data.pagination.page);
        }
      } catch (loadError) {
        if (loadError.name !== "AbortError") {
          setProxyPools([]);
          setError(loadError.message || "Unable to load proxy pools");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    void load();
    return () => controller.abort();
  }, [enabled, page, retryRevision, search, sort]);

  const startItem = pagination.filteredTotal > 0
    ? (pagination.page - 1) * pagination.pageSize + 1
    : 0;
  const endItem = Math.min(
    pagination.page * pagination.pageSize,
    pagination.filteredTotal
  );

  return (
    <div className={`min-w-0 ${className}`} aria-busy={loading}>
      <div className="flex flex-col gap-2 border-b border-black/5 p-2 dark:border-white/5 sm:flex-row">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search valid proxy pools</span>
          <span className="material-symbols-outlined pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[17px] text-text-muted">
            search
          </span>
          <input
            type="search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search name, ID, or address"
            disabled={disabled}
            className="h-9 w-full rounded-lg border border-black/10 bg-surface pl-8 pr-3 text-[16px] text-text-main outline-none focus:border-primary/40 focus:ring-2 focus:ring-primary/20 disabled:opacity-50 dark:border-white/10 sm:text-xs"
          />
        </label>
        <label>
          <span className="sr-only">Sort valid proxy pools</span>
          <select
            value={sort}
            onChange={(event) => {
              setSort(event.target.value);
              setPage(1);
            }}
            disabled={disabled}
            className="h-9 w-full rounded-lg border border-black/10 bg-surface px-2 text-xs text-text-main outline-none focus:border-primary/40 focus:ring-2 focus:ring-primary/20 disabled:opacity-50 dark:border-white/10 sm:w-auto"
          >
            <option value="latency-asc">Fastest valid</option>
            <option value="valid-first">Recently validated</option>
            <option value="name-asc">Name (A-Z)</option>
          </select>
        </label>
      </div>

      <div
        className="max-h-60 overflow-y-auto overscroll-contain py-1"
        role="listbox"
        aria-label="Health-valid proxy pools"
      >
        {showNone && (
          <button
            type="button"
            role="option"
            aria-selected={!value}
            onClick={() => onSelect(null)}
            disabled={disabled}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5 ${!value ? "font-medium text-primary" : "text-text-main"}`}
          >
            <span className="material-symbols-outlined text-[17px] text-text-muted">link_off</span>
            <span className="truncate">{noneLabel}</span>
          </button>
        )}

        {loading && proxyPools.length === 0 && (
          <p className="px-3 py-5 text-center text-xs text-text-muted" role="status">
            Loading valid proxies...
          </p>
        )}

        {!loading && error && (
          <div className="px-3 py-4 text-center" role="alert">
            <p className="text-xs text-red-500">{error}</p>
            <button
              type="button"
              onClick={() => setRetryRevision((revision) => revision + 1)}
              className="mt-2 text-xs font-medium text-primary hover:underline"
            >
              Try again
            </button>
          </div>
        )}

        {!loading && !error && proxyPools.length === 0 && (
          <p className="px-3 py-5 text-center text-xs text-text-muted">
            {search ? "No valid proxies match this search." : "No health-valid proxies available."}
          </p>
        )}

        {proxyPools.map((pool) => (
          <button
            key={pool.id}
            type="button"
            role="option"
            aria-selected={value === pool.id}
            onClick={() => onSelect(pool)}
            disabled={disabled}
            className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5 ${value === pool.id ? "bg-primary/5" : ""}`}
          >
            <span className="min-w-0">
              <span className={`block truncate text-sm ${value === pool.id ? "font-medium text-primary" : "text-text-main"}`}>
                {pool.name || pool.id}
              </span>
              <span className="block truncate text-[10px] text-text-muted">{pool.id}</span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5 text-[10px] text-emerald-600 dark:text-emerald-400">
              <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
              {Number.isFinite(pool.latencyMs) ? `${pool.latencyMs}ms` : "Valid"}
            </span>
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-black/5 px-3 py-2 text-[10px] text-text-muted dark:border-white/5">
        <span aria-live="polite">
          {pagination.filteredTotal > 0
            ? `${startItem}-${endItem} of ${pagination.filteredTotal} valid`
            : "0 valid"}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            disabled={disabled || loading || pagination.page <= 1}
            aria-label="Previous proxy page"
            className="rounded p-1 text-text-main hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-white/5"
          >
            <span className="material-symbols-outlined text-[17px]">chevron_left</span>
          </button>
          <span>{pagination.totalPages > 0 ? `${pagination.page}/${pagination.totalPages}` : "1/1"}</span>
          <button
            type="button"
            onClick={() => setPage((current) => current + 1)}
            disabled={disabled || loading || pagination.totalPages === 0 || pagination.page >= pagination.totalPages}
            aria-label="Next proxy page"
            className="rounded p-1 text-text-main hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-white/5"
          >
            <span className="material-symbols-outlined text-[17px]">chevron_right</span>
          </button>
        </div>
      </div>
    </div>
  );
}

ProxyPoolPicker.propTypes = {
  value: PropTypes.string,
  onSelect: PropTypes.func.isRequired,
  disabled: PropTypes.bool,
  enabled: PropTypes.bool,
  showNone: PropTypes.bool,
  noneLabel: PropTypes.string,
  className: PropTypes.string,
};
