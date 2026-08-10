"use client";

import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { Badge, Button, Card, CardSkeleton, Input, Modal, Toggle, ConfirmModal } from "@/shared/components";
import Pagination from "@/shared/components/Pagination";
import { useNotificationStore } from "@/store/notificationStore";

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_HEALTH_CONCURRENCY = 10;
const MAX_HEALTH_CONCURRENCY = 64;
const HEALTH_POLL_INTERVAL_MS = 1_000;

function waitFor(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function getStatusVariant(status) {
  if (status === "active") return "success";
  if (status === "error") return "error";
  return "default";
}

function formatDateTime(value) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  return date.toLocaleString();
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "Calculating...";
  const totalSeconds = Math.ceil(ms / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function createHealthProgressTracker(targetCount, initialSnapshot = {}) {
  let previousCompleted = Number(initialSnapshot.completed) || 0;
  let previousSampleAt = Date.now();
  let measuredRate = Number(initialSnapshot.currentRatePerSecond) || 0;

  return (snapshot) => {
    const now = Date.now();
    const completed = Number(snapshot.completed) || 0;
    const elapsedSeconds = Math.max(0.001, (now - previousSampleAt) / 1_000);
    const completionDelta = Math.max(0, completed - previousCompleted);
    if (completionDelta > 0) measuredRate = completionDelta / elapsedSeconds;
    previousCompleted = completed;
    previousSampleAt = now;

    const serverRate = Number(snapshot.currentRatePerSecond) || 0;
    const rate = serverRate > 0 ? serverRate : measuredRate;
    const total = Number(snapshot.total) || targetCount;
    const remaining = Math.max(0, total - completed);
    const telemetryAvailable = snapshot.telemetryAvailable !== false;
    const estimatedRemainingMs = Number.isFinite(snapshot.estimatedRemainingMs)
      ? snapshot.estimatedRemainingMs
      : (rate > 0 ? (remaining / rate) * 1_000 : null);

    return {
      current: completed,
      total,
      valid: Number(snapshot.successful) || 0,
      errors: Number(snapshot.failed) || 0,
      inconclusive: Number(snapshot.internalErrors) || 0,
      retried: Number(snapshot.retried) || 0,
      timedOut: telemetryAvailable ? (Number(snapshot.timedOut) || 0) : null,
      persisted: Number(snapshot.persisted) || 0,
      queued: Number(snapshot.queuedForPersistence) || 0,
      inFlight: telemetryAvailable ? (Number(snapshot.inFlight) || 0) : null,
      rate,
      averageAttemptMs: telemetryAvailable ? (snapshot.stats?.averageAttemptMs ?? null) : null,
      telemetryAvailable,
      classificationReliable: snapshot.classificationReliable !== false,
      estimatedRemainingMs,
    };
  };
}

function normalizeFormData(data = {}) {
  return {
    name: data.name || "",
    proxyUrl: data.proxyUrl || "",
    noProxy: data.noProxy || "",
    isActive: data.isActive !== false,
    strictProxy: data.strictProxy === true,
  };
}

export default function ProxyPoolsPage() {
  const [proxyPools, setProxyPools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showFormModal, setShowFormModal] = useState(false);
  const [showBatchImportModal, setShowBatchImportModal] = useState(false);
  const [importResults, setImportResults] = useState(null);
  const [showVercelModal, setShowVercelModal] = useState(false);
  const [showCloudflareModal, setShowCloudflareModal] = useState(false);
  const [showDenoModal, setShowDenoModal] = useState(false);
  const [showRelayMenu, setShowRelayMenu] = useState(false);
  const [editingProxyPool, setEditingProxyPool] = useState(null);
  const [formData, setFormData] = useState(normalizeFormData());
  const [batchImportText, setBatchImportText] = useState("");
  const [vercelForm, setVercelForm] = useState({ vercelToken: "", projectName: "vercel-relay" });
  const [cloudflareForm, setCloudflareForm] = useState({ accountId: "", apiToken: "", projectName: "cloudflare-relay" });
  const [denoForm, setDenoForm] = useState({ denoToken: "", orgDomain: "", projectName: "" });
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [testingId, setTestingId] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [healthChecking, setHealthChecking] = useState(false);
  const [healthProgress, setHealthProgress] = useState({
    current: 0,
    total: 0,
    valid: 0,
    errors: 0,
    inconclusive: 0,
    retried: 0,
    timedOut: 0,
    persisted: 0,
    queued: 0,
    inFlight: 0,
    rate: 0,
    averageAttemptMs: null,
    telemetryAvailable: true,
    classificationReliable: true,
    estimatedRemainingMs: null,
  });
  const [healthJobId, setHealthJobId] = useState(null);
  const [healthStopping, setHealthStopping] = useState(false);
  const [concurrencyConfig, setConcurrencyConfig] = useState(DEFAULT_HEALTH_CONCURRENCY);
  const [showSettingsPanel, setShowSettingsPanel] = useState(false);
  const [latencyStats, setLatencyStats] = useState(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [sortOrder, setSortOrder] = useState('active-first');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [pagination, setPagination] = useState({
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    total: 0,
    active: 0,
    filteredTotal: 0,
    totalPages: 0,
  });
  const [confirmState, setConfirmState] = useState(null);
  const relayMenuRef = useRef(null);
  const healthPollAbortRef = useRef(null);
  const visiblePoolIdsRef = useRef([]);
  const notify = useMemo(() => ({
    success: (...args) => useNotificationStore.getState().success(...args),
    error: (...args) => useNotificationStore.getState().error(...args),
    warning: (...args) => useNotificationStore.getState().warning(...args),
    info: (...args) => useNotificationStore.getState().info(...args),
  }), []);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (relayMenuRef.current && !relayMenuRef.current.contains(e.target)) {
        setShowRelayMenu(false);
      }
    };
    if (showRelayMenu) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showRelayMenu]);

  const fetchProxyPools = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        includeUsage: "true",
        page: String(currentPage),
        pageSize: String(pageSize),
        sort: sortOrder,
      });
      const res = await fetch(`/api/proxy-pools?${params}`, { cache: "no-store" });
      const data = await res.json();
      if (res.ok) {
        setProxyPools(data.proxyPools || []);
        // Selection is page-scoped. A refresh can reorder or replace the page,
        // so retaining hidden IDs would make later bulk actions unsafe.
        setSelectedIds([]);
        const nextPagination = data.pagination || {};
        setPagination({
          page: nextPagination.page || 1,
          pageSize: nextPagination.pageSize || pageSize,
          total: nextPagination.total || 0,
          active: nextPagination.active || 0,
          filteredTotal: nextPagination.filteredTotal || 0,
          totalPages: nextPagination.totalPages || 0,
        });
        if (nextPagination.page && nextPagination.page !== currentPage) {
          setCurrentPage(nextPagination.page);
        }
      }
    } catch (error) {
      console.log("Error fetching proxy pools:", error);
    } finally {
      setLoading(false);
    }
  }, [currentPage, pageSize, sortOrder]);

  const refreshVisibleHealth = useCallback(async () => {
    const ids = visiblePoolIdsRef.current;
    if (ids.length === 0) return;
    try {
      const params = new URLSearchParams({ healthIds: ids.join(",") });
      const res = await fetch(`/api/proxy-pools?${params}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const healthById = new Map((data.health || []).map((health) => [health.id, health]));
      setProxyPools((current) => current.map((pool) => {
        const incoming = healthById.get(pool.id);
        if (!incoming) return pool;

        const incomingTestedAt = Date.parse(incoming.lastTestedAt || "");
        const currentTestedAt = Date.parse(pool.lastTestedAt || "");
        if (Number.isFinite(currentTestedAt)
          && (!Number.isFinite(incomingTestedAt) || incomingTestedAt < currentTestedAt)) {
          return pool;
        }

        return { ...pool, ...incoming };
      }));
    } catch {
      // The next polling revision or final page refresh will retry naturally.
    }
  }, []);

  const monitorHealthJob = useCallback(async ({ initialData, controller, targetCount }) => {
    let data = initialData;
    setHealthJobId(data.jobId || null);
    const runningStatuses = new Set(["loading", "queued", "running", "cancelling"]);
    const trackProgress = createHealthProgressTracker(targetCount, data);
    let seenPersistenceRevision = -1;

    const applySnapshot = async (snapshot) => {
      setHealthStopping(snapshot.status === "cancelling");
      setHealthProgress(trackProgress(snapshot));
      const persistenceRevision = Number(snapshot.persistenceRevision) || 0;
      if (persistenceRevision > seenPersistenceRevision) {
        seenPersistenceRevision = persistenceRevision;
        if (persistenceRevision > 0) await refreshVisibleHealth();
      }
    };

    await applySnapshot(data);
    while (runningStatuses.has(data.status)) {
      await waitFor(HEALTH_POLL_INTERVAL_MS);
      const pollRes = await fetch(
        "/api/proxy-pools/batch-test?jobId=" + encodeURIComponent(data.jobId),
        { cache: "no-store", signal: controller.signal }
      );
      data = await pollRes.json().catch(() => ({}));
      if (!pollRes.ok) {
        throw new Error(
          data.error || "Unable to read health-check progress (" + pollRes.status + ")"
        );
      }
      await applySnapshot(data);
    }

    setLatencyStats(data.stats ? {
      ...data.stats,
      durationMs: data.durationMs || 0,
      scope: data.scope,
      includeInactive: data.includeInactive === true,
    } : null);
    await fetchProxyPools();

    if (data.status === "cancelled") {
      notify.warning("Health check cancelled after " + (data.completed || 0) + " proxy pools.");
      return;
    }
    if (data.status !== "completed") {
      throw new Error(data.error || "Health check job failed on the server");
    }

    const statMsg = data.stats?.averageLatencyMs !== null
      ? "\nAverage latency: " + data.stats.averageLatencyMs + "ms (min "
        + data.stats.minLatencyMs + "ms, max " + data.stats.maxLatencyMs + "ms)"
      : "";
    const durationMsg = "\nDuration: " + ((data.durationMs || 0) / 1000).toFixed(1) + "s";

    if (data.failed > 0 && data.canDisableFailed === true) {
      const completedJobId = data.jobId;
      setConfirmState({
        title: "Disable Dead Proxies?",
        message: "Results: " + data.successful + " healthy, " + data.failed + " confirmed failed, "
          + (data.internalErrors || 0) + " inconclusive, and "
          + data.skipped + " inactive skipped." + statMsg + durationMsg
          + "\n\nDisable the failed proxies whose result is still current?",
        confirmText: "Disable Dead Proxies",
        onConfirm: async () => {
          setConfirmState(null);
          setBulkBusy(true);
          try {
            const disableRes = await fetch("/api/proxy-pools/batch-test", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "disable-failed", jobId: completedJobId }),
            });
            const disableData = await disableRes.json().catch(() => ({}));
            if (!disableRes.ok) {
              throw new Error(disableData.error || "Failed to disable unhealthy proxies");
            }
            await fetchProxyPools();
            notify.success(
              (disableData.disabled || 0) + " failed proxies disabled"
              + (disableData.stale
                ? "; " + disableData.stale + " newer results preserved"
                : "")
              + "."
            );
          } catch (error) {
            notify.error(error.message || "Failed to disable unhealthy proxies");
          } finally {
            setBulkBusy(false);
          }
        }
      });
    } else if (data.failed > 0 && data.classificationReliable === false) {
      notify.warning(
        "Legacy health check finished with " + data.failed
        + " one-shot failures. Disabling is blocked; run Complete Health Check again "
        + "to confirm them safely."
      );
    } else if ((data.internalErrors || 0) > 0) {
      notify.warning(
        "Health check complete: " + data.successful + " valid, "
        + (data.internalErrors || 0) + " inconclusive (previous health preserved), and "
        + data.skipped + " inactive skipped." + statMsg + durationMsg
      );
    } else {
      notify.success(
        "Health check complete: " + data.successful + " healthy, "
        + data.skipped + " inactive skipped." + statMsg + durationMsg
      );
    }
  }, [fetchProxyPools, notify, refreshVisibleHealth]);

  useEffect(() => {
    const timer = setTimeout(() => { void fetchProxyPools(); }, 0);
    return () => clearTimeout(timer);
  }, [fetchProxyPools]);

  useEffect(() => {
    visiblePoolIdsRef.current = proxyPools.map((pool) => pool.id);
  }, [proxyPools]);

  useEffect(() => {
    const controller = new AbortController();
    const reconnect = async () => {
      try {
        const res = await fetch("/api/proxy-pools/batch-test", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!["loading", "queued", "running", "cancelling"].includes(data.status)) return;

        healthPollAbortRef.current?.abort();
        healthPollAbortRef.current = controller;
        setHealthChecking(true);
        setHealthStopping(data.status === "cancelling");
        setLatencyStats(null);
        await monitorHealthJob({
          initialData: data,
          controller,
          targetCount: Number(data.total) || 0,
        });
      } catch (error) {
        if (error.name !== "AbortError") {
          console.error("Health check reconnect error:", error);
          notify.error(error.message || "Unable to reconnect to the running health check");
        }
      } finally {
        if (healthPollAbortRef.current === controller) {
          healthPollAbortRef.current = null;
          setHealthChecking(false);
          setHealthStopping(false);
        }
      }
    };

    void reconnect();
    return () => controller.abort();
  }, [monitorHealthJob, notify]);

  useEffect(() => () => healthPollAbortRef.current?.abort(), []);

  const resetForm = () => {
    setEditingProxyPool(null);
    setFormData(normalizeFormData());
  };

  const openCreateModal = () => {
    resetForm();
    setShowFormModal(true);
  };

  const openEditModal = (proxyPool) => {
    setEditingProxyPool(proxyPool);
    setFormData(normalizeFormData(proxyPool));
    setShowFormModal(true);
  };

  const closeFormModal = () => {
    setShowFormModal(false);
    resetForm();
  };

  const handleSave = async () => {
    const payload = {
      name: formData.name.trim(),
      proxyUrl: formData.proxyUrl.trim(),
      noProxy: formData.noProxy.trim(),
      isActive: formData.isActive === true,
      strictProxy: formData.strictProxy === true,
    };

    if (!payload.name || !payload.proxyUrl) return;

    setSaving(true);
    try {
      const isEdit = !!editingProxyPool;
      const res = await fetch(isEdit ? `/api/proxy-pools/${editingProxyPool.id}` : "/api/proxy-pools", {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        await fetchProxyPools();
        closeFormModal();
        notify.success(editingProxyPool ? "Proxy pool updated" : "Proxy pool created");
      } else {
        const data = await res.json();
        notify.error(data.error || "Failed to save proxy pool");
      }
    } catch (error) {
      console.log("Error saving proxy pool:", error);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (proxyPool) => {
    setConfirmState({
      title: "Delete Proxy Pool",
      message: `Delete proxy pool "${proxyPool.name}"?`,
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/proxy-pools/${proxyPool.id}`, { method: "DELETE" });
          if (res.ok) {
            clearSelection();
            await fetchProxyPools();
            notify.success("Proxy pool deleted");
            return;
          }

          const data = await res.json();
          if (res.status === 409) {
            notify.warning(`Cannot delete: ${data.boundConnectionCount || 0} connection(s) are still using this pool.`);
          } else {
            notify.error(data.error || "Failed to delete proxy pool");
          }
        } catch (error) {
          console.log("Error deleting proxy pool:", error);
          notify.error("Failed to delete proxy pool");
        }
      }
    });
  };

  const handleTest = async (proxyPoolId) => {
    setTestingId(proxyPoolId);
    try {
      const res = await fetch(`/api/proxy-pools/${proxyPoolId}/test`, { method: "POST" });
      const data = await res.json();

      if (!res.ok) {
        notify.error(data.error || "Failed to test proxy");
        return;
      }

      await fetchProxyPools();
      if (data.inconclusive === true) {
        notify.warning(
          "Proxy test was inconclusive"
          + (data.attempts > 1 ? " after two targets" : "")
          + "; the previous health status was preserved."
        );
        return;
      }
      if (data.persisted === false) {
        notify.warning("Proxy changed while the test was running; the stale result was discarded.");
        return;
      }
      const latMsg = data.latencyMs ? ` (${data.latencyMs}ms)` : '';
      if (data.ok) notify.success(`Proxy test passed ✓${latMsg}`);
      else notify.error(`Proxy test failed${latMsg}`);
    } catch (error) {
      console.log("Error testing proxy pool:", error);
      notify.error("Failed to test proxy");
    } finally {
      setTestingId(null);
    }
  };

  const handleToggleActive = async (pool) => {
    const next = !pool.isActive;
    setProxyPools((prev) => prev.map((p) => p.id === pool.id ? { ...p, isActive: next } : p));
    try {
      const res = await fetch(`/api/proxy-pools/${pool.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: next }),
      });
      if (!res.ok) {
        setProxyPools((prev) => prev.map((p) => p.id === pool.id ? { ...p, isActive: pool.isActive } : p));
        notify.error("Failed to update active state");
      } else {
        clearSelection();
        await fetchProxyPools();
      }
    } catch (error) {
      console.log("Error toggling active:", error);
      setProxyPools((prev) => prev.map((p) => p.id === pool.id ? { ...p, isActive: pool.isActive } : p));
    }
  };

  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const currentPageIds = useMemo(() => proxyPools.map((pool) => pool.id), [proxyPools]);
  const allSelected = currentPageIds.length > 0 && currentPageIds.every((id) => selectedIdSet.has(id));
  const toggleSelect = (id) => setSelectedIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  const toggleSelectAll = () => setSelectedIds(allSelected ? [] : currentPageIds);
  const clearSelection = () => setSelectedIds([]);

  const bulkSetActive = async (isActive) => {
    const targets = selectedIds;
    if (targets.length === 0) return;
    setBulkBusy(true);
    try {
      let ok = 0; let failed = 0;
      for (const id of targets) {
        try {
          const res = await fetch(`/api/proxy-pools/${id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ isActive }),
          });
          if (res.ok) ok += 1; else failed += 1;
        } catch { failed += 1; }
      }
      await fetchProxyPools();
      notify.success(`${isActive ? "Activated" : "Deactivated"} ${ok}${failed ? `, failed ${failed}` : ""}`);
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkDelete = async () => {
    if (selectedIds.length === 0) return;
    setConfirmState({
      title: "Delete Proxy Pools",
      message: `Delete ${selectedIds.length} proxy pool(s)?`,
      onConfirm: async () => {
        setConfirmState(null);
        setBulkBusy(true);
        try {
          let ok = 0; let blocked = 0; let failed = 0;
          for (const id of selectedIds) {
            try {
              const res = await fetch(`/api/proxy-pools/${id}`, { method: "DELETE" });
              if (res.ok) ok += 1;
              else if (res.status === 409) blocked += 1;
              else failed += 1;
            } catch { failed += 1; }
          }
          await fetchProxyPools();
          clearSelection();
          notify.success(`Deleted ${ok}${blocked ? `, ${blocked} bound` : ""}${failed ? `, ${failed} failed` : ""}`);
        } finally {
          setBulkBusy(false);
        }
      }
    });
  };

  const handleHealthCheck = async ({ forceAll = false, includeInactive = false } = {}) => {
    const selectedScope = !forceAll && selectedIds.length > 0;
    const targetCount = selectedScope ? selectedIds.length : pagination.total;
    if (targetCount === 0) {
      notify.warning("No proxy pools selected for health check");
      return;
    }

    if (targetCount > 100) {
      const confirmed = window.confirm(
        (includeInactive
          ? "Start a complete server-side health check for all "
          : "Start a server-side health check for ")
        + targetCount.toLocaleString()
        + (includeInactive ? " proxy records, including inactive records?" : " proxy pools?")
        + "\n\nThe dashboard will only poll compact progress counters. "
        + "Large checks can take a long time when proxies time out.\n\nContinue?"
      );
      if (!confirmed) return;
    }

    const controller = new AbortController();
    healthPollAbortRef.current?.abort();
    healthPollAbortRef.current = controller;
    setHealthJobId(null);
    setHealthChecking(true);
    setHealthStopping(false);
    setHealthProgress({
      current: 0,
      total: targetCount,
      valid: 0,
      errors: 0,
      inconclusive: 0,
      retried: 0,
      timedOut: 0,
      persisted: 0,
      queued: 0,
      inFlight: 0,
      rate: 0,
      averageAttemptMs: null,
      telemetryAvailable: true,
      classificationReliable: true,
      estimatedRemainingMs: null,
    });
    setLatencyStats(null);

    try {
      const res = await fetch("/api/proxy-pools/batch-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: selectedScope ? "selected" : "all",
          poolIds: selectedScope ? selectedIds : undefined,
          includeInactive: !selectedScope && includeInactive,
          concurrency: includeInactive ? MAX_HEALTH_CONCURRENCY : Number(concurrencyConfig),
        }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 409) {
        throw new Error(data.error || "Health check failed (" + res.status + ")");
      }
      if (res.status === 409) {
        notify.warning("A server health check is already running; reconnected to its progress.");
      }

      await monitorHealthJob({ initialData: data, controller, targetCount });
    } catch (error) {
      if (error.name === "AbortError") return;
      if (healthPollAbortRef.current !== controller) return;
      setLatencyStats(null);
      console.error("Health check error:", error);
      notify.error(error.message || "Health check failed. Please try again.");
    } finally {
      if (healthPollAbortRef.current === controller) {
        healthPollAbortRef.current = null;
        setHealthChecking(false);
        setHealthStopping(false);
      }
    }
  };

  const handleCancelHealthCheck = async () => {
    if (!healthJobId) return;
    setHealthStopping(true);
    try {
      const res = await fetch(
        "/api/proxy-pools/batch-test?jobId=" + encodeURIComponent(healthJobId),
        { method: "DELETE" }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Unable to cancel health check");
      }
      notify.warning("Server health-check stop requested. Saved results will be kept.");
    } catch (error) {
      setHealthStopping(false);
      notify.error(error.message || "Unable to cancel health check");
    }
  };

  useEffect(() => {
    const saved = Number.parseInt(localStorage.getItem("proxyHealthConcurrency"), 10);
    if (!Number.isFinite(saved)) return undefined;
    const normalized = Math.max(1, Math.min(saved, MAX_HEALTH_CONCURRENCY));
    const timer = setTimeout(() => setConcurrencyConfig(normalized), 0);
    return () => clearTimeout(timer);
  }, []);

  const saveConcurrencyPreference = (value) => {
    const normalized = Math.max(
      1,
      Math.min(Number(value) || DEFAULT_HEALTH_CONCURRENCY, MAX_HEALTH_CONCURRENCY)
    );
    setConcurrencyConfig(normalized);
    localStorage.setItem("proxyHealthConcurrency", String(normalized));
  };

  const applyPreset = (presetName) => {
    const presets = { light: 4, normal: 10, balanced: 20, aggressive: 32, maximum: 64 };
    const value = presets[presetName];
    saveConcurrencyPreference(value);
    notify.success(
      "Applied " + presetName + " profile (" + value + " concurrent server checks)"
    );
  };

  const openBatchImportModal = () => {
    setBatchImportText("");
    setShowBatchImportModal(true);
  };

  const closeBatchImportModal = () => {
    if (importing) return;
    setShowBatchImportModal(false);
  };

  const openVercelModal = () => {
    setVercelForm({ vercelToken: "", projectName: "vercel-relay" });
    setShowVercelModal(true);
  };

  const closeVercelModal = () => {
    if (deploying) return;
    setShowVercelModal(false);
  };

  const openCloudflareModal = () => {
    setCloudflareForm({ accountId: "", apiToken: "", projectName: "cloudflare-relay" });
    setShowCloudflareModal(true);
  };

  const closeCloudflareModal = () => {
    if (deploying) return;
    setShowCloudflareModal(false);
  };

  const openDenoModal = () => {
    setDenoForm({ denoToken: "", orgDomain: "", projectName: "" });
    setShowDenoModal(true);
  };

  const closeDenoModal = () => {
    if (deploying) return;
    setShowDenoModal(false);
  };

  const handleVercelDeploy = async () => {
    if (!vercelForm.vercelToken.trim()) return;
    setDeploying(true);
    try {
      const res = await fetch("/api/proxy-pools/vercel-deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vercelForm),
      });
      const data = await res.json();
      if (res.ok) {
        await fetchProxyPools();
        closeVercelModal();
        notify.success(`Deployed: ${data.deployUrl}`);
      } else {
        notify.error(data.error || "Deploy failed");
      }
    } catch (error) {
      console.log("Error deploying Vercel relay:", error);
      notify.error("Deploy failed");
    } finally {
      setDeploying(false);
    }
  };

  const handleCloudflareDeploy = async () => {
    if (!cloudflareForm.accountId.trim() || !cloudflareForm.apiToken.trim()) return;
    setDeploying(true);
    try {
      const res = await fetch("/api/proxy-pools/cloudflare-deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cloudflareForm),
      });
      const data = await res.json();
      if (res.ok) {
        await fetchProxyPools();
        closeCloudflareModal();
        notify.success(`Deployed: ${data.deployUrl}`);
      } else {
        notify.error(data.error || "Deploy failed");
      }
    } catch (error) {
      console.log("Error deploying Cloudflare relay:", error);
      notify.error("Deploy failed");
    } finally {
      setDeploying(false);
    }
  };

  const handleDenoDeploy = async () => {
    if (!denoForm.denoToken.trim()) return;
    setDeploying(true);
    try {
      const res = await fetch("/api/proxy-pools/deno-deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(denoForm),
      });
      const data = await res.json();
      if (res.ok) {
        await fetchProxyPools();
        closeDenoModal();
        notify.success(`Deployed: ${data.deployUrl}`);
      } else {
        notify.error(data.error || "Deploy failed");
      }
    } catch (error) {
      console.log("Error deploying Deno relay:", error);
      notify.error("Deploy failed");
    } finally {
      setDeploying(false);
    }
  };

  const handleBatchImport = async () => {
    if (!batchImportText.trim()) {
      notify.warning("Please paste at least one proxy line.");
      return;
    }

    // Parsing, validation, deduplication, and persistence all run in the API.
    setImporting(true);
    setImportResults(null);

    try {
      const res = await fetch("/api/proxy-pools/batch-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: batchImportText,
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        if (data.parsingErrors && data.parsingErrors.length > 0) {
          notify.error(`Failed to parse some lines:\n${data.parsingErrors.map(e => `Line ${e.lineNumber}: ${e.error}`).join("\n")}`);
        } else {
          notify.error(data.error || "Import failed");
        }
        setImportResults(null);
        return;
      }

      // Store results
      setImportResults(data);

      // Build notification message
      let msg = `Import complete!`;
      msg += `\n✓ ${data.summary.created} created`;
      msg += `\n⊛ ${data.summary.duplicatesSkipped} skipped (duplicates)`;
      if (data.summary.failed > 0) {
        msg += `\n✗ ${data.summary.failed} failed`;
      }

      const avgTime = data.meta?.averageImportTime
        ? `\n📈 Avg ${data.meta.averageImportTime}ms per proxy`
        : '';

      notify.success(`${msg}${avgTime}`);

      // Refresh pool list
      await fetchProxyPools();

    } catch (error) {
      console.error("Error batch importing proxies:", error);
      notify.error("Import request failed. Please check the server logs and try again.");
    } finally {
      setImporting(false);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-1 sm:gap-6 sm:px-0">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-1 sm:gap-6 sm:px-0">
      {/* Concurrent Health Check Settings - Collapsible Panel */}
      <Card>
        <button
          onClick={() => setShowSettingsPanel(!showSettingsPanel)}
          className="flex w-full items-center justify-between py-3"
          aria-expanded={showSettingsPanel}
        >
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[20px] text-primary">tune</span>
            <h2 className="text-base font-semibold text-text-main">⚡ Parallel Health Check Settings</h2>
          </div>
          <span className={`material-symbols-outlined text-[18px] transition-transform ${showSettingsPanel ? 'rotate-180' : ''}`}>
            expand_more
          </span>
        </button>

        {showSettingsPanel && (
          <div className="space-y-4 pt-2">
            {/* Preset Quick Actions */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              <Button
                size="sm"
                variant="secondary"
                icon="speed"
                onClick={() => applyPreset('light')}
                disabled={healthChecking || saving}
                className="w-full justify-start"
              >
                Light (4)
              </Button>
              <Button
                size="sm"
                variant="secondary"
                icon="verified"
                onClick={() => applyPreset('normal')}
                disabled={healthChecking || saving}
                className="w-full justify-start bg-primary/10 border-primary/30"
              >
                Normal (10)
              </Button>
              <Button
                size="sm"
                variant="secondary"
                icon="flash_on"
                onClick={() => applyPreset('balanced')}
                disabled={healthChecking || saving}
                className="w-full justify-start"
              >
                Balanced (20)
              </Button>
              <Button
                size="sm"
                variant="secondary"
                icon="bolt"
                onClick={() => applyPreset('aggressive')}
                disabled={healthChecking || saving}
                className="w-full justify-start"
              >
                Aggressive (32)
              </Button>
              <Button
                size="sm"
                variant="secondary"
                icon="rocket_launch"
                onClick={() => applyPreset('maximum')}
                disabled={healthChecking || saving}
                className="w-full justify-start"
              >
                Maximum (64)
              </Button>
            </div>

            {/* Slider Control */}
            <div className="border-t border-black/5 dark:border-white/5 pt-4">
              <label htmlFor="concurrency-slider" className="block text-sm font-medium text-text-main mb-2">
                Selected-check concurrency
              </label>
              <input
                id="concurrency-slider"
                type="range"
                min="1"
                max={MAX_HEALTH_CONCURRENCY}
                value={concurrencyConfig}
                onChange={(e) => saveConcurrencyPreference(e.target.value)}
                disabled={healthChecking || saving}
                className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer accent-primary"
              />
              <div className="mt-2 flex items-center justify-between text-xs text-text-muted">
                <span>1 check</span>
                <span className="font-mono font-bold text-primary">{concurrencyConfig} concurrent checks</span>
                <span>{MAX_HEALTH_CONCURRENCY} max</span>
              </div>
              <p className="mt-1 text-[11px] text-text-muted">
                Selected checks use this setting. Complete Health Check uses the bounded {MAX_HEALTH_CONCURRENCY}-worker
                maximum plus a 25-starts/second safety limit. All work stays on the server.
              </p>
            </div>

            {/* Performance Tips */}
            <div className="rounded-lg bg-blue-500/5 border border-blue-500/10 p-3 space-y-2">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-[18px] text-blue-500">info</span>
                <p className="text-sm font-medium text-text-main">Performance Tips</p>
              </div>
              <ul className="text-xs text-text-muted space-y-1 pl-6 list-disc">
                <li><strong>Light:</strong> Lowest impact, ideal for background checks</li>
                <li><strong>Normal:</strong> Recommended balance of speed and stability</li>
                <li><strong>Balanced:</strong> Faster checks with moderate resource usage</li>
                <li><strong>Aggressive:</strong> High concurrency for selected checks</li>
                <li><strong>Maximum:</strong> 64 async checks, protected by the 25-starts/second limit</li>
                <li>The browser only polls compact progress counters</li>
              </ul>
            </div>
          </div>
        )}

        {!showSettingsPanel && (
          <div className="pt-2 pb-1">
            <div className="flex items-center gap-2 text-sm text-text-muted">
              <span className="material-symbols-outlined text-[18px] text-primary">settings</span>
              <span>Selected checks: {concurrencyConfig} workers</span>
              <span className="ml-auto font-mono text-primary">Complete: {MAX_HEALTH_CONCURRENCY}</span>
            </div>
          </div>
        )}
      </Card>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold sm:text-2xl">Proxy Pools</h1>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:flex sm:items-center">
          <div className="relative" ref={relayMenuRef}>
            <Button
              size="sm"
              variant="secondary"
              icon="rocket_launch"
              onClick={() => setShowRelayMenu(!showRelayMenu)}
            >
              Deploy Relay
              <span className="material-symbols-outlined ml-1 text-[18px]">
                {showRelayMenu ? "expand_less" : "expand_more"}
              </span>
            </Button>

            {showRelayMenu && (
              <div className="absolute left-0 top-full z-50 mt-1 w-48 rounded-xl border border-black/10 bg-white p-1 shadow-xl dark:border-white/10 dark:bg-zinc-900 sm:left-auto sm:right-0">
                <button
                  onClick={() => {
                    openCloudflareModal();
                    setShowRelayMenu(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-text-main transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                >
                  <span className="material-symbols-outlined text-[20px] text-orange-500">cloud</span>
                  Cloudflare Relay
                </button>
                <button
                  onClick={() => {
                    openVercelModal();
                    setShowRelayMenu(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-text-main transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                >
                  <span className="material-symbols-outlined text-[20px] text-blue-500">cloud_upload</span>
                  Vercel Relay
                </button>
                <button
                  onClick={() => {
                    openDenoModal();
                    setShowRelayMenu(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-text-main transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                >
                  <span className="material-symbols-outlined text-[20px] text-green-500">terminal</span>
                  Deno Relay
                </button>
              </div>
            )}
          </div>

          <Button
            size="sm"
            variant="secondary"
            icon={healthChecking ? "progress_activity" : "monitor_heart"}
            onClick={() => handleHealthCheck({ forceAll: true, includeInactive: true })}
            disabled={healthChecking || bulkBusy || pagination.total === 0}
            title={`Checks every record with ${MAX_HEALTH_CONCURRENCY} parallel server workers`}
          >
            {healthChecking
              ? `Checking ${healthProgress.current}/${healthProgress.total}`
              : "Complete Health Check"}
          </Button>
          <Button size="sm" variant="secondary" icon="upload" onClick={openBatchImportModal}>
            Batch Import
          </Button>
          <Button size="sm" icon="add" onClick={openCreateModal}>Add Proxy Pool</Button>
        </div>
      </div>

      {healthChecking && (
        <section
          className="rounded-xl border border-primary/25 bg-primary/5 px-4 py-4"
          aria-live="polite"
          aria-label="Live proxy health check status"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <span className="material-symbols-outlined mt-0.5 text-[20px] text-primary">monitor_heart</span>
              <div>
                <h2 className="text-sm font-semibold text-text-main">Live health check</h2>
                <p className="mt-0.5 text-xs text-text-muted">
                  Results are saved server-side and merged into the visible rows while the check runs.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-start justify-end gap-3">
              <div className="text-right text-xs text-text-muted">
                <div className="font-mono font-semibold text-text-main">
                  {healthProgress.rate.toFixed(1)} checks/s
                </div>
                <div>
                  {healthProgress.inFlight === null ? "-" : healthProgress.inFlight} in flight
                  {" | "}ETA {formatDuration(healthProgress.estimatedRemainingMs)}
                </div>
              </div>
              <Button
                size="sm"
                variant="secondary"
                icon={healthStopping ? "progress_activity" : "stop_circle"}
                onClick={handleCancelHealthCheck}
                disabled={!healthJobId || healthStopping}
              >
                {healthStopping ? "Stopping..." : "Stop Check"}
              </Button>
            </div>
          </div>

          {(!healthProgress.telemetryAvailable || !healthProgress.classificationReliable) && (
            <div className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              This job started with the legacy one-shot checker. Stop and restart it for
              confirmed retries and Avg attempt telemetry. Disabling its failed set is blocked.
            </div>
          )}

          <div
            className="mt-3 h-2 overflow-hidden rounded-full bg-black/10 dark:bg-white/10"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax={healthProgress.total}
            aria-valuenow={healthProgress.current}
          >
            <div
              className="h-full rounded-full bg-primary"
              style={{
                width: `${healthProgress.total > 0
                  ? Math.min(100, (healthProgress.current / healthProgress.total) * 100)
                  : 0}%`,
              }}
            />
          </div>

          <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-3">
            <div>
              <dt className="text-xs text-text-muted">Checked</dt>
              <dd className="font-mono text-sm font-semibold text-text-main">
                {healthProgress.current.toLocaleString()} / {healthProgress.total.toLocaleString()}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">Valid</dt>
              <dd className="font-mono text-sm font-semibold text-success">
                {healthProgress.valid.toLocaleString()}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">Errors</dt>
              <dd className="font-mono text-sm font-semibold text-danger">
                {healthProgress.errors.toLocaleString()}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">Inconclusive</dt>
              <dd className="font-mono text-sm font-semibold text-amber-500">
                {healthProgress.inconclusive.toLocaleString()}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">Timeouts</dt>
              <dd className="font-mono text-sm font-semibold text-amber-500">
                {healthProgress.timedOut === null ? "-" : healthProgress.timedOut.toLocaleString()}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">Saved</dt>
              <dd className="font-mono text-sm font-semibold text-text-main">
                {healthProgress.persisted.toLocaleString()}
                {healthProgress.queued > 0 ? ` (+${healthProgress.queued} queued)` : ""}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">Avg attempt</dt>
              <dd className="font-mono text-sm font-semibold text-text-main">
                {healthProgress.averageAttemptMs === null
                  ? "-"
                  : `${healthProgress.averageAttemptMs}ms`}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">Retried</dt>
              <dd className="font-mono text-sm font-semibold text-text-main">
                {healthProgress.retried.toLocaleString()}
              </dd>
            </div>
          </dl>
        </section>
      )}

      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {proxyPools.length > 0 && (
            <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleSelectAll}
                className="size-4 rounded border-black/20 dark:border-white/20"
              />
              {allSelected ? "Unselect page" : "Select page"}
            </label>
          )}
          <Badge variant="default">Total: {pagination.total}</Badge>
          <Badge variant="success">Active: {pagination.active}</Badge>
        </div>

        {/* Sort Controls */}
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4 px-1 sm:px-0">
          <div className="flex items-center gap-2">
            <label className="text-xs text-text-muted">Sort by:</label>
            <select
              value={sortOrder}
              onChange={(e) => {
                clearSelection();
                setCurrentPage(1);
                setSortOrder(e.target.value);
              }}
              className="text-xs bg-white dark:bg-zinc-800 border border-black/10 dark:border-white/10 rounded-md px-2 py-1 focus:ring-1 focus:ring-primary/30 focus:outline-none"
            >
              <option value="active-first">Enabled First</option>
              <option value="valid-first">Valid First</option>
              <option value="errors-first">Errors First</option>
              <option value="latency-asc">Valid: Fastest Latency</option>
              <option value="latency-desc">Valid: Slowest Latency</option>
              <option value="name-asc">Name (A-Z)</option>
              <option value="name-desc">Name (Z-A)</option>
              <option value="newest">Newest First</option>
            </select>
          </div>
        </div>

        {/* Selection Toolbar */}
        {(selectedIds.length > 0 || healthChecking) && (
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2">
            <span className="material-symbols-outlined text-[18px] text-primary">checklist</span>
            <span className="text-xs font-medium text-primary">
              {selectedIds.length > 0 ? `${selectedIds.length} selected` : "Complete check in progress"}
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {selectedIds.length > 0 && (
                <Button
                  size="sm"
                  icon={healthChecking ? "progress_activity" : "health_and_safety"}
                  onClick={() => handleHealthCheck()}
                  disabled={healthChecking || bulkBusy}
                >
                  {healthChecking
                    ? `Checking ${healthProgress.current}/${healthProgress.total}`
                    : "Check Selected"}
                </Button>
              )}
              {selectedIds.length > 0 && (
                <>
                  <Button size="sm" variant="secondary" icon="toggle_on" onClick={() => bulkSetActive(true)} disabled={bulkBusy || healthChecking}>
                    Activate
                  </Button>
                  <Button size="sm" variant="secondary" icon="toggle_off" onClick={() => bulkSetActive(false)} disabled={bulkBusy || healthChecking}>
                    Deactivate
                  </Button>
                  <Button size="sm" variant="secondary" icon="delete" onClick={bulkDelete} disabled={bulkBusy || healthChecking}>
                    Delete
                  </Button>
                  <Button size="sm" variant="ghost" onClick={clearSelection} disabled={bulkBusy || healthChecking}>
                    Clear
                  </Button>
                </>
              )}
            </div>
          </div>
        )}

        {/* Compact aggregate recap; per-proxy results remain on the server. */}
        {latencyStats && (
          <section className="mb-4 rounded-lg bg-black/[0.025] p-4 dark:bg-white/[0.035]" aria-live="polite">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-[20px] text-primary">monitor_heart</span>
                  <h3 className="text-sm font-semibold text-text-main">
                    {latencyStats.includeInactive ? "Complete Health Check Recap" : "Health Check Recap"}
                  </h3>
                </div>
                <p className="mt-1 text-xs text-text-muted">
                  {latencyStats.includeInactive
                    ? "All active and inactive records were included."
                    : "Results for the requested proxy set."}
                </p>
              </div>
              <button
                onClick={() => setLatencyStats(null)}
                className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/5 text-text-muted"
                aria-label="Dismiss health check recap"
              >
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>

            <div className="grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-3 lg:grid-cols-6">
              <div>
                <p className="text-xs text-text-muted">Reachable</p>
                <p className="text-xl font-bold text-success">
                  {latencyStats.successful}
                </p>
              </div>

              <div>
                <p className="text-xs text-text-muted">Unreachable</p>
                <p className="text-xl font-bold text-danger">{latencyStats.failed}</p>
              </div>

              <div>
                <p className="text-xs text-text-muted">Average latency</p>
                <p className={`text-xl font-bold ${latencyStats.averageLatencyMs === null ? 'text-text-muted' : latencyStats.averageLatencyMs < 2000 ? 'text-green-500' : latencyStats.averageLatencyMs < 5000 ? 'text-yellow-500' : 'text-red-500'}`}>
                  {latencyStats.averageLatencyMs === null ? "-" : `${latencyStats.averageLatencyMs}ms`}
                </p>
              </div>

              <div>
                <p className="text-xs text-text-muted">Latency range</p>
                <p className="text-base font-semibold text-text-main">
                  {latencyStats.minLatencyMs === null
                    ? "-"
                    : `${latencyStats.minLatencyMs}-${latencyStats.maxLatencyMs}ms`}
                </p>
              </div>

              <div>
                <p className="text-xs text-text-muted">Checked</p>
                <p className="text-base font-semibold text-text-main">
                  {latencyStats.completed}/{latencyStats.total}
                </p>
              </div>

              <div>
                <p className="text-xs text-text-muted">Duration</p>
                <p className="text-base font-semibold text-text-main">
                  {(latencyStats.durationMs / 1000).toFixed(1)}s
                </p>
              </div>
            </div>

            <p className="mt-4 text-xs text-text-muted">
              {latencyStats.skipped} skipped | {latencyStats.concurrency} concurrent server checks
            </p>
          </section>
        )}

        {proxyPools.length === 0 ? (
          <div className="text-center py-10">
            <p className="text-text-main font-medium mb-1">No proxy pool entries yet</p>
            <p className="text-sm text-text-muted mb-4">
              Create a proxy pool entry, then assign it to connections.
            </p>
            <Button icon="add" onClick={openCreateModal}>Add Proxy Pool</Button>
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-black/[0.04] dark:divide-white/[0.05]">
            {proxyPools.map((pool) => (
              <div key={pool.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3 min-w-0 flex-1">
                  <input
                    type="checkbox"
                    checked={selectedIdSet.has(pool.id)}
                    onChange={() => toggleSelect(pool.id)}
                    className="mt-1 size-4 shrink-0 rounded border-black/20 dark:border-white/20"
                  />
                  <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="min-w-0 max-w-full truncate text-sm font-medium sm:max-w-[18rem]">{pool.name}</p>
                    <Badge variant={getStatusVariant(pool.testStatus)} size="sm" dot>
                      {pool.testStatus || "unknown"}
                    </Badge>
                    <Badge variant={pool.isActive ? "success" : "default"} size="sm">
                      {pool.isActive ? "active" : "inactive"}
                    </Badge>
                    {pool.type === "vercel" && (
                      <Badge variant="default" size="sm">vercel relay</Badge>
                    )}
                    {pool.type === "cloudflare" && (
                      <Badge variant="default" size="sm">cloudflare relay</Badge>
                    )}
                    <Badge variant="default" size="sm">
                      {pool.boundConnectionCount || 0} bound
                    </Badge>
                  </div>
                  <p className="text-xs text-text-muted truncate mt-1">{pool.proxyUrl}</p>
                  {pool.noProxy ? (
                    <p className="text-xs text-text-muted truncate">No proxy: {pool.noProxy}</p>
                  ) : null}
                  <p className="text-[11px] text-text-muted mt-1 flex items-center gap-2">
                    Last tested: {formatDateTime(pool.lastTestedAt)}
                    {pool.lastError ? ` · ${pool.lastError}` : ""}
                    {pool.latencyMs && (
                      <>
                        <span>•</span>
                        <span className={`font-mono ${pool.latencyMs < 2000 ? 'text-green-500' : pool.latencyMs < 5000 ? 'text-yellow-500' : 'text-red-500'}`}>
                          {pool.latencyMs}ms
                        </span>
                      </>
                    )}
                  </p>
                  </div>
                </div>

                <div className="flex items-center justify-end gap-1">
                  <Toggle
                    size="sm"
                    checked={pool.isActive === true}
                    onChange={() => handleToggleActive(pool)}
                    title={pool.isActive ? "Disable" : "Enable"}
                  />
                  <button
                    onClick={() => handleTest(pool.id)}
                    className="p-2 rounded hover:bg-black/5 dark:hover:bg-white/5 text-text-muted hover:text-primary"
                    title="Test proxy"
                    disabled={testingId === pool.id}
                  >
                    <span
                      className="material-symbols-outlined text-[18px]"
                      style={testingId === pool.id ? { animation: "spin 1s linear infinite" } : undefined}
                    >
                      {testingId === pool.id ? "progress_activity" : "science"}
                    </span>
                  </button>
                  <button
                    onClick={() => openEditModal(pool)}
                    className="p-2 rounded hover:bg-black/5 dark:hover:bg-white/5 text-text-muted hover:text-primary"
                    title="Edit"
                  >
                    <span className="material-symbols-outlined text-[18px]">edit</span>
                  </button>
                  <button
                    onClick={() => handleDelete(pool)}
                    className="p-2 rounded hover:bg-red-500/10 text-red-500"
                    title="Delete"
                  >
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <Pagination
          currentPage={pagination.page}
          pageSize={pagination.pageSize}
          totalItems={pagination.filteredTotal}
          onPageChange={(page) => {
            clearSelection();
            setCurrentPage(page);
          }}
          onPageSizeChange={(size) => {
            clearSelection();
            setCurrentPage(1);
            setPageSize(size);
          }}
        />
      </Card>

      <Modal
        isOpen={showBatchImportModal}
        title="Batch Import Proxies"
        onClose={closeBatchImportModal}
      >
        <div className="flex flex-col gap-4">
          <div>
            <label className="text-sm font-medium text-text-main mb-1 block">Paste Proxy List (One per line)</label>
            <textarea
              value={batchImportText}
              onChange={(e) => setBatchImportText(e.target.value)}
              placeholder={"http://user:pass@127.0.0.1:7897\n127.0.0.1:7897:user:pass"}
              className="w-full min-h-[180px] py-2 px-3 text-sm text-text-main bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-md focus:ring-1 focus:ring-primary/30 focus:border-primary/50 focus:outline-none transition-all"
            />
            <p className="text-xs text-text-muted mt-1">
              Supported formats: protocol://user:pass@host:port, host:port:user:pass
            </p>
            <p className="text-xs text-text-muted mt-1">
              New proxies are saved atomically in one optimized database transaction.
            </p>
          </div>

          {/* Import Progress */}
          {(importing || importResults) && (
            <div className="space-y-2 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-4">
              <h4 className="text-sm font-semibold text-text-main flex items-center gap-2">
                <span className="material-symbols-outlined text-[18px] text-blue-500">progress_activity</span>
                Import Status
              </h4>

              {importing && (
                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-text-muted">
                    <span>Uploading and processing on the server...</span>
                    <span>Server-side</span>
                  </div>
                  <div className="h-2 w-full bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                    <div
                      className="h-full w-1/3 bg-primary animate-pulse"
                    />
                  </div>
                </div>
              )}

              {importResults && importResults.meta && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3 pt-3 border-t border-blue-200 dark:border-blue-800">
                  <div className="text-center">
                    <div className="text-xl font-bold text-success">{importResults.summary.created}</div>
                    <div className="text-[10px] text-text-muted uppercase">Created</div>
                  </div>
                  <div className="text-center">
                    <div className="text-xl font-bold text-yellow-500">{importResults.summary.duplicatesSkipped}</div>
                    <div className="text-[10px] text-text-muted uppercase">Skipped</div>
                  </div>
                  <div className="text-center">
                    <div className="text-xl font-bold text-red-500">{importResults.summary.failed}</div>
                    <div className="text-[10px] text-text-muted uppercase">Failed</div>
                  </div>
                  <div className="text-center">
                    <div className="text-xl font-bold text-text-main">{importResults.meta.averageImportTime}ms</div>
                    <div className="text-[10px] text-text-muted uppercase">Avg Time</div>
                  </div>
                </div>
              )}

              {importResults && importResults.meta && (
                <p className="mt-2 text-xs text-text-muted text-center">
                  Completed in {importResults.meta.durationMs}ms ({Math.round(importResults.meta.durationMs / 1000)}s)
                  using a single database transaction
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button
              fullWidth
              onClick={handleBatchImport}
              disabled={!batchImportText.trim() || importing}
              icon={importing ? "progress_activity" : "upload"}
            >
              {importing ? "Importing..." : "Import Proxies"}
            </Button>
            <Button fullWidth variant="ghost" onClick={closeBatchImportModal} disabled={importing}>
              Close
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={showVercelModal}
        title="Deploy Vercel Relay"
        onClose={closeVercelModal}
      >
        <div className="flex flex-col gap-4">
          <div className="rounded-lg bg-blue-500/5 border border-blue-500/10 p-3 flex flex-col gap-1.5">
            <p className="text-sm text-text-main font-medium">What is Vercel Relay?</p>
            <p className="text-xs text-text-muted">
              Deploys an edge relay function to Vercel. All AI provider requests will be forwarded through Vercel&apos;s edge network, masking your real IP from providers.
            </p>
            <ul className="text-xs text-text-muted list-disc pl-4 space-y-0.5">
              <li>Your IP is replaced by Vercel&apos;s dynamic edge IPs (hundreds of IPs across 20+ global regions)</li>
              <li>Vercel serves millions of apps — providers can&apos;t block Vercel IPs without affecting legitimate traffic</li>
              <li>Free tier: 100GB bandwidth/month, 500K edge invocations</li>
              <li>Deploy multiple relays on different accounts for more IP diversity</li>
            </ul>
          </div>
          <Input
            label="Vercel API Token"
            value={vercelForm.vercelToken}
            onChange={(e) => setVercelForm((prev) => ({ ...prev, vercelToken: e.target.value }))}
            placeholder="your-vercel-api-token"
            hint={<>Token is used once for deployment and not stored. <a href="https://vercel.com/account/tokens" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Get token →</a></>}
            type="password"
          />
          <Input
            label="Project Name"
            value={vercelForm.projectName}
            onChange={(e) => setVercelForm((prev) => ({ ...prev, projectName: e.target.value }))}
            placeholder="my-relay"
            hint="Unique name for your Vercel project. Leave empty for auto-generated name."
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button
              fullWidth
              onClick={handleVercelDeploy}
              disabled={!vercelForm.vercelToken.trim() || deploying}
            >
              {deploying ? "Deploying... (may take ~1 min)" : "Deploy"}
            </Button>
            <Button fullWidth variant="ghost" onClick={closeVercelModal} disabled={deploying}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={showCloudflareModal}
        title="Deploy Cloudflare Relay"
        onClose={closeCloudflareModal}
      >
        <div className="flex flex-col gap-4">
          <div className="rounded-lg bg-orange-500/5 border border-orange-500/10 p-3 flex flex-col gap-1.5">
            <p className="text-sm text-text-main font-medium">What is Cloudflare Relay?</p>
            <p className="text-xs text-text-muted">
              Deploys a Cloudflare Worker as a proxy relay. All AI provider requests will be forwarded through Cloudflare&apos;s global edge network.
            </p>
            <ul className="text-xs text-text-muted list-disc pl-4 space-y-0.5">
              <li>High performance global routing and IP masking via Cloudflare Workers</li>
              <li>Free tier: 100,000 requests per day</li>
              <li>Requires Cloudflare Account ID and a Workers API Token (Edit Workers permission)</li>
            </ul>
            <div className="mt-2 pt-2 border-t border-orange-500/10 text-xs text-text-muted">
              <p className="font-medium text-text-main mb-1">How to generate your API Token:</p>
              <ol className="list-decimal pl-4 space-y-0.5">
                <li>Go to <b>My Profile</b> → <b>API Tokens</b> → <b>Create Token</b></li>
                <li>Scroll down to <b>Custom Token</b> and click <b>Get started</b></li>
                <li>Under <b>Permissions</b>: Account | Workers Scripts | Edit</li>
                <li>Under <b>Account Resources</b>: Include | Account | <i>Your Account Name</i></li>
                <li>Click <b>Continue to summary</b> → <b>Create Token</b></li>
              </ol>
            </div>
          </div>
          <Input
            label="Account ID"
            value={cloudflareForm.accountId}
            onChange={(e) => setCloudflareForm((prev) => ({ ...prev, accountId: e.target.value }))}
            placeholder="your-cloudflare-account-id"
            hint={<>Found on the right side of the Cloudflare dashboard overview page.</>}
          />
          <Input
            label="API Token"
            value={cloudflareForm.apiToken}
            onChange={(e) => setCloudflareForm((prev) => ({ ...prev, apiToken: e.target.value }))}
            placeholder="your-cloudflare-api-token"
            hint={<>Requires &quot;Workers Scripts: Edit&quot; permission. <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Get token →</a></>}
            type="password"
          />
          <Input
            label="Worker Name"
            value={cloudflareForm.projectName}
            onChange={(e) => setCloudflareForm((prev) => ({ ...prev, projectName: e.target.value }))}
            placeholder="my-relay"
            hint="Unique name for your Cloudflare Worker. Leave empty for auto-generated name."
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button
              fullWidth
              onClick={handleCloudflareDeploy}
              disabled={!cloudflareForm.accountId.trim() || !cloudflareForm.apiToken.trim() || deploying}
            >
              {deploying ? "Deploying..." : "Deploy Worker"}
            </Button>
            <Button fullWidth variant="ghost" onClick={closeCloudflareModal} disabled={deploying}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={showDenoModal}
        title="Deploy Deno Relay"
        onClose={closeDenoModal}
      >
        <div className="flex flex-col gap-4">
          <div className="rounded-lg bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 p-3 flex flex-col gap-1.5">
            <p className="text-sm text-text-main font-medium">What is Deno Relay?</p>
            <p className="text-xs text-text-muted">
              Deploys a relay worker to Deno Deploy&apos;s global edge network. All AI provider requests are forwarded through Deno&apos;s edge, masking your real IP.
            </p>
            <ul className="text-xs text-text-muted list-disc pl-4 space-y-0.5">
              <li>Deno Deploy v2 runs on a high-performance global edge network</li>
              <li>Free tier: 1M requests & 100GiB outbound traffic per month</li>
              <li>No per-request CPU time limits (unlike Vercel/Cloudflare)</li>
              <li>Support up to 20 active apps & 50 custom domains</li>
              <li>Deploy multiple relays for maximum IP diversity</li>
            </ul>
            <div className="mt-2 pt-2 border-t border-black/10 dark:border-white/10 text-xs text-text-muted">
              <p className="font-medium text-text-main mb-1">How to generate API token:</p>
              <ol className="list-decimal pl-4 space-y-0.5">
                <li>Go to <b>console.deno.com</b></li>
                <li>Select your <b>Organization</b> → <b>Settings</b> → <b>Organization Tokens</b></li>
                <li>Create a <b>Organization Token</b> (prefix <b>ddo_</b>)</li>
              </ol>
            </div>
          </div>
          <Input
            label="Deno Deploy API Token"
            value={denoForm.denoToken}
            onChange={(e) => setDenoForm((prev) => ({ ...prev, denoToken: e.target.value }))}
            placeholder="ddo_xxxxxxxxxxxxxxxx"
            hint={<>Token is used once for deployment, not stored. Found in Organization Settings.</>}
            type="password"
          />
          <Input
            label="Organization Domain"
            value={denoForm.orgDomain}
            onChange={(e) => setDenoForm((prev) => ({ ...prev, orgDomain: e.target.value }))}
            placeholder="your-org.deno.net"
            hint="Organization's default domain. Your relay URL will be in the format: https://my-relay.your-org.deno.net"
          />
          <Input
            label="App Name"
            value={denoForm.projectName}
            onChange={(e) => setDenoForm((prev) => ({ ...prev, projectName: e.target.value }))}
            placeholder="deno-relay"
            hint="Unique app name. Leave empty for auto-generated name."
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button
              fullWidth
              onClick={handleDenoDeploy}
              disabled={!denoForm.denoToken.trim() || !denoForm.orgDomain.trim() || deploying}
            >
              {deploying ? "Deploying..." : "Deploy Relay"}
            </Button>
            <Button fullWidth variant="ghost" onClick={closeDenoModal} disabled={deploying}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={showFormModal}
        title={editingProxyPool ? "Edit Proxy Pool" : "Add Proxy Pool"}
        onClose={closeFormModal}
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Name"
            value={formData.name}
            onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
            placeholder="Office Proxy"
          />
          <Input
            label="Proxy URL"
            value={formData.proxyUrl}
            onChange={(e) => setFormData((prev) => ({ ...prev, proxyUrl: e.target.value }))}
            placeholder="http://127.0.0.1:7897"
          />
          <Input
            label="No Proxy"
            value={formData.noProxy}
            onChange={(e) => setFormData((prev) => ({ ...prev, noProxy: e.target.value }))}
            placeholder="localhost,127.0.0.1,.internal"
            hint="Comma-separated hosts/domains to bypass proxy"
          />

          <div className="flex flex-col gap-3 rounded-lg border border-border/50 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium text-sm">Active</p>
              <p className="text-xs text-text-muted">Inactive pools are ignored by runtime resolution.</p>
            </div>
            <Toggle
              checked={formData.isActive === true}
              onChange={() => setFormData((prev) => ({ ...prev, isActive: !prev.isActive }))}
              disabled={saving}
            />
          </div>

          <div className="flex flex-col gap-3 rounded-lg border border-border/50 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium text-sm">Strict Proxy</p>
              <p className="text-xs text-text-muted">Fail request if proxy is unreachable instead of falling back to direct.</p>
            </div>
            <Toggle
              checked={formData.strictProxy === true}
              onChange={() => setFormData((prev) => ({ ...prev, strictProxy: !prev.strictProxy }))}
              disabled={saving}
            />
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button
              fullWidth
              onClick={handleSave}
              disabled={!formData.name.trim() || !formData.proxyUrl.trim() || saving}
            >
              {saving ? "Saving..." : "Save"}
            </Button>
            <Button fullWidth variant="ghost" onClick={closeFormModal} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      {/* Confirm Modal */}
      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        confirmText={confirmState?.confirmText || "Confirm"}
        variant="danger"
      />
    </div>
  );
}
