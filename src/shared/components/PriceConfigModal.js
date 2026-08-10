"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import Modal from "@/shared/components/Modal";
import Button from "@/shared/components/Button";
import Input from "@/shared/components/Input";

/**
 * PriceConfigModal — configure per-token pricing for a single provider model.
 * Rates are $/1M tokens. Saved pricing is merged into the store via PATCH
 * /api/pricing and drives the cost aggregation on /dashboard/usage.
 *
 * API contract notes:
 *  - GET /api/pricing returns the FULL merged pricing map { provider: { model: {…} } }
 *    (query params are ignored), so we load all pricing and pluck this model's entry.
 *  - PATCH /api/pricing rejects null / negative / unknown fields, so empty inputs are
 *    omitted from the payload rather than sent as null.
 *  - Pricing is ALWAYS keyed to the modelId prop (the model row that opened the
 *    modal) — usageHistory stores that exact id, so cost lookup matches. The id is
 *    shown read-only to make that contract visible.
 */
const PRICE_FIELDS = [
  { key: "input", label: "Input Rate ($/1M)", placeholder: "e.g. 2.50" },
  { key: "output", label: "Output Rate ($/1M)", placeholder: "e.g. 10.00" },
  { key: "cached", label: "Cached Rate ($/1M)", placeholder: "e.g. 0.25" },
];

function emptyRates() {
  return { input: "", output: "", cached: "" };
}

function PriceConfigModal({ isOpen, providerId, modelId, onClose, onSave }) {
  // Component remounts per model (parent gates on selectedPriceModelId), so
  // initial state comes straight from props — no synchronous setState in effects.
  const [rates, setRates] = useState(emptyRates);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    // GET returns the full merged pricing map; pluck this provider/model entry.
    fetch("/api/pricing", { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load pricing (${res.status})`);
        return res.json();
      })
      .then((all) => {
        if (cancelled) return;
        const entry = all?.[providerId]?.[modelId];
        if (entry && typeof entry === "object") {
          setRates({
            input: entry.input != null ? String(entry.input) : "",
            output: entry.output != null ? String(entry.output) : "",
            cached: entry.cached != null ? String(entry.cached) : "",
          });
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message || "Failed to load current pricing.");
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, providerId, modelId]);

  if (!isOpen) return null;

  const handleChange = (field, value) => {
    setError("");
    setRates((prev) => ({ ...prev, [field]: value }));
  };

  const buildPricingPayload = () => {
    const pricing = {};
    for (const { key } of PRICE_FIELDS) {
      const raw = String(rates[key] ?? "").trim();
      if (raw === "") continue; // omit empty — API rejects null
      const num = Number(raw);
      if (!Number.isFinite(num) || num < 0) {
        throw new Error(`"${key}" must be a non-negative number.`);
      }
      pricing[key] = num;
    }
    return pricing;
  };

  const handleSave = async () => {
    let pricing;
    try {
      pricing = buildPricingPayload();
    } catch (e) {
      setError(e.message);
      return;
    }
    if (Object.keys(pricing).length === 0) {
      setError("Enter at least one price field, or reset to defaults.");
      return;
    }

    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/pricing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // Always save under the model id the row was opened with — usage rows
        // carry that id, so cost calculation finds this pricing entry.
        body: JSON.stringify({ [providerId]: { [modelId]: pricing } }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Failed to save pricing (${res.status})`);
      }
      onSave?.();
      onClose();
    } catch (e) {
      setError(e.message || "Failed to save pricing");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!confirm("Reset this model's pricing to defaults? Custom rates will be removed.")) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch(
        `/api/pricing?provider=${encodeURIComponent(providerId)}&model=${encodeURIComponent(modelId)}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error(`Failed to reset pricing (${res.status})`);
      setRates(emptyRates());
      onSave?.();
      onClose();
    } catch (e) {
      setError(e.message || "Failed to reset pricing");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} title="Configure Model Pricing" onClose={onClose}>
      <div className="flex flex-col gap-5">
        <p className="rounded-lg border border-border bg-bg-subtle p-3 text-xs text-text-muted">
          Rates are in <strong>USD per 1M tokens</strong>. Configured prices feed the cost
          aggregation shown on the Usage dashboard for{" "}
          <span className="font-mono">{providerId}/{modelId}</span>.
        </p>

        {/* Pricing fields */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {PRICE_FIELDS.map(({ key, label, placeholder }) => (
            <div key={key}>
              <label className="mb-1 block text-xs text-text-muted" htmlFor={`price-${key}`}>
                {label}
              </label>
              <Input
                id={`price-${key}`}
                type="number"
                step="0.01"
                min="0"
                value={rates[key]}
                onChange={(e) => handleChange(key, e.target.value)}
                placeholder={placeholder}
                fullWidth
              />
            </div>
          ))}
        </div>

        {error && (
          <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">
            {error}
          </p>
        )}

        {/* Actions */}
        <div className="flex gap-2">
          <Button onClick={handleReset} variant="ghost" fullWidth disabled={saving} className="text-red-500">
            Reset
          </Button>
          <Button onClick={onClose} variant="ghost" fullWidth disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} fullWidth disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

PriceConfigModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  providerId: PropTypes.string.isRequired,
  modelId: PropTypes.string,
  onClose: PropTypes.func.isRequired,
  onSave: PropTypes.func,
};

export default PriceConfigModal;
