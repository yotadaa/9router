"use client";

import { useEffect, useState } from "react";
import { Card, Toggle } from "@/shared/components";

export default function ApiConverterPage() {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState({ type: "", message: "" });

  useEffect(() => {
    let mounted = true;

    fetch("/api/settings", { headers: { "Cache-Control": "no-store" } })
      .then(async (response) => {
        if (!response.ok) throw new Error("Failed to load API Converter settings");
        return response.json();
      })
      .then((settings) => {
        if (mounted) setEnabled(settings.responsesApiConverterEnabled === true);
      })
      .catch((error) => {
        if (mounted) setStatus({ type: "error", message: error.message });
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => { mounted = false; };
  }, []);

  const updateEnabled = async (nextEnabled) => {
    setSaving(true);
    setStatus({ type: "", message: "" });

    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ responsesApiConverterEnabled: nextEnabled }),
      });
      const settings = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(settings.error || "Failed to save API Converter setting");

      const isEnabled = settings.responsesApiConverterEnabled === true;
      setEnabled(isEnabled);
      setStatus({
        type: "success",
        message: isEnabled
          ? "Converter enabled. /v1/responses now returns Responses API output for Chat Completions providers."
          : "Converter disabled. /v1/responses returns the provider's Chat Completions output.",
      });
    } catch (error) {
      setStatus({ type: "error", message: error.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-[10px] bg-primary/10 text-primary">
          <span className="material-symbols-outlined text-[22px]">swap_horiz</span>
        </div>
        <div>
          <h1 className="text-2xl font-semibold text-text-main">API Converter</h1>
          <p className="mt-1 text-sm text-text-muted">Control compatibility conversion for the OpenAI Responses API endpoint.</p>
        </div>
      </div>

      <Card>
        <div className="flex items-start justify-between gap-5">
          <div className="min-w-0 flex-1">
            <p className="font-medium text-text-main">Chat Completions → Responses API</p>
            <p className="mt-1 text-sm text-text-muted">
              Convert JSON and SSE output from Chat Completions providers when clients call <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-text-main">/v1/responses</code>.
            </p>
          </div>
          <Toggle
            checked={enabled}
            onChange={updateEnabled}
            disabled={loading || saving}
            ariaLabel="Enable Chat Completions to Responses API conversion"
          />
        </div>

        <div className="mt-5 border-t border-border-subtle pt-4">
          <p className={enabled ? "text-sm font-medium text-success" : "text-sm font-medium text-text-muted"}>
            {loading ? "Loading setting…" : enabled ? "Active" : "Disabled"}
          </p>
          <p className="mt-1 text-xs text-text-muted">
            The default is disabled. Enable it only for clients that require the Responses API response schema.
          </p>
        </div>
      </Card>

      <Card padding="sm">
        <div className="flex gap-3 p-1">
          <span className="material-symbols-outlined mt-0.5 text-[18px] text-text-muted">info</span>
          <div className="space-y-1 text-sm text-text-muted">
            <p><span className="font-medium text-text-main">Endpoint:</span> <code className="font-mono text-xs">POST /v1/responses</code></p>
            <p>With the toggle off, the provider&apos;s OpenAI Chat Completions response is passed through. With it on, 9Router returns Responses API objects and events.</p>
          </div>
        </div>
      </Card>

      {status.message ? (
        <p role="status" className={status.type === "error" ? "text-sm text-red-500" : "text-sm text-success"}>
          {status.message}
        </p>
      ) : null}
    </div>
  );
}
