"use client";

import { useState, useEffect, useMemo } from "react";
import PropTypes from "prop-types";
import { Modal, Input, Button, Badge, Select } from "@/shared/components";
import { AI_PROVIDERS } from "@/shared/constants/providers";

const DEFAULT_BASE_URL = "https://api.openai.com/v1/videos";
const OTHER_PRESET = "other";

// Presets: built-in providers that have a video job endpoint (videoConfig.baseUrl).
// Currently xAI (Grok Imagine) — the list grows automatically with the registry.
function buildPresets() {
  return Object.values(AI_PROVIDERS || {})
    .filter((p) => typeof p?.videoConfig?.baseUrl === "string")
    .map((p) => ({
      id: p.id,
      name: p.display?.name || p.name || p.id,
      baseUrl: p.videoConfig.baseUrl,
      videoApi: "xai",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Two upstream job-API shapes:
//  xai  → POST {base}/{action} (generations|edits|extensions), poll GET {base}/{jobId}
//  sora → POST {base} (OpenAI /v1/videos shape), poll GET {base}/{jobId}
const VIDEO_API_OPTIONS = [
  { value: "xai", label: "xAI / Grok Imagine style — POST {base}/generations" },
  { value: "sora", label: "OpenAI / Sora style — POST {base} directly" },
];

// Dual-mode modal: edit when `node` provided, add otherwise
export default function AddCustomVideoModal({ isOpen, onClose, onCreated, onSaved, node }) {
  const isEdit = !!node;
  const presets = useMemo(buildPresets, []);
  const [presetId, setPresetId] = useState(OTHER_PRESET);
  const [formData, setFormData] = useState({
    name: "",
    prefix: "",
    baseUrl: DEFAULT_BASE_URL,
    videoApi: "xai",
  });
  const [submitting, setSubmitting] = useState(false);
  const [checkKey, setCheckKey] = useState("");
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState(null);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    setValidationResult(null);
    setCheckKey("");
    setErrorMessage("");
    if (isEdit) {
      setFormData({
        name: node.name || "",
        prefix: node.prefix || "",
        baseUrl: node.baseUrl || DEFAULT_BASE_URL,
        videoApi: node.videoApi || "xai",
      });
      setPresetId(OTHER_PRESET);
    } else {
      setFormData({ name: "", prefix: "", baseUrl: DEFAULT_BASE_URL, videoApi: "xai" });
      setPresetId(OTHER_PRESET);
    }
  }, [isOpen, isEdit, node]);

  const handlePresetChange = (value) => {
    setPresetId(value);
    const preset = presets.find((p) => p.id === value);
    if (preset) {
      setFormData((prev) => ({ ...prev, baseUrl: preset.baseUrl, videoApi: preset.videoApi }));
    } else {
      setFormData((prev) => ({ ...prev, baseUrl: DEFAULT_BASE_URL }));
    }
  };

  const handleSubmit = async () => {
    if (!formData.name.trim() || !formData.prefix.trim() || !formData.baseUrl.trim()) return;
    setSubmitting(true);
    setErrorMessage("");
    try {
      const url = isEdit ? `/api/provider-nodes/${node.id}` : "/api/provider-nodes";
      const method = isEdit ? "PUT" : "POST";
      const payload = {
        name: formData.name,
        prefix: formData.prefix,
        baseUrl: formData.baseUrl,
        videoApi: formData.videoApi,
      };
      if (!isEdit) payload.type = "custom-video";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (res.ok) {
        if (isEdit) onSaved?.(data.node);
        else onCreated?.(data.node);
      } else {
        setErrorMessage(data?.error || "Failed to save provider");
      }
    } catch (error) {
      console.log("Error saving custom video node:", error);
      setErrorMessage("Network error");
    } finally {
      setSubmitting(false);
    }
  };

  const handleValidate = async () => {
    setValidating(true);
    try {
      const res = await fetch("/api/provider-nodes/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: formData.baseUrl,
          apiKey: checkKey,
          type: "custom-video",
        }),
      });
      const data = await res.json();
      setValidationResult(data);
    } catch {
      setValidationResult({ valid: false, error: "Network error" });
    } finally {
      setValidating(false);
    }
  };

  const renderValidationResult = () => {
    if (!validationResult) return null;
    if (validationResult.valid) {
      return (
        <>
          <Badge variant="success">Valid</Badge>
          {validationResult.warning && <span className="text-sm text-text-muted">{validationResult.warning}</span>}
        </>
      );
    }
    return (
      <div className="flex flex-col gap-1">
        <Badge variant="error">Invalid</Badge>
        {validationResult.error && <span className="text-sm text-red-500">{validationResult.error}</span>}
      </div>
    );
  };

  return (
    <Modal isOpen={isOpen} title={isEdit ? "Edit Custom Video Provider" : "Add Custom Video Provider"} onClose={onClose}>
      <div className="flex flex-col gap-4">
        {!isEdit && presets.length > 0 && (
          <Select
            label="Compatible Provider"
            value={presetId}
            onChange={(e) => handlePresetChange(e.target.value)}
            options={[
              ...presets.map((p) => ({ value: p.id, label: p.name })),
              { value: OTHER_PRESET, label: "Other (custom URL)" },
            ]}
            hint="Prefills the base URL for known video job APIs."
          />
        )}
        <Input
          label="Name"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder="My Video Gateway"
          hint="Required. A friendly label for this video provider."
        />
        <Input
          label="Prefix"
          value={formData.prefix}
          onChange={(e) => setFormData({ ...formData, prefix: e.target.value })}
          placeholder="myvid"
          hint="Required. Used as the provider prefix for model IDs (e.g. myvid/veo-3)."
        />
        <Input
          label="Base URL"
          value={formData.baseUrl}
          onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
          placeholder="https://api.openai.com/v1/videos"
          hint="The video jobs endpoint. Jobs are polled at {baseUrl}/{jobId}."
        />
        <Select
          label="Job API Shape"
          value={formData.videoApi}
          onChange={(e) => setFormData({ ...formData, videoApi: e.target.value })}
          options={VIDEO_API_OPTIONS}
          hint="How job creation is submitted. Polling is GET {base}/{jobId} for both."
        />
        <Input
          label="API Key (for Check)"
          type="password"
          value={checkKey}
          onChange={(e) => setCheckKey(e.target.value)}
          hint="Checks {apiBase}/models with this key (no job is created)."
        />
        <div className="flex items-center gap-3">
          <Button
            onClick={handleValidate}
            disabled={!checkKey || validating || !formData.baseUrl.trim()}
            variant="secondary"
          >
            {validating ? "Checking..." : "Check"}
          </Button>
          {renderValidationResult()}
        </div>
        {errorMessage && <p className="text-xs text-red-500">{errorMessage}</p>}
        <div className="flex gap-2">
          <Button
            onClick={handleSubmit}
            fullWidth
            disabled={!formData.name.trim() || !formData.prefix.trim() || !formData.baseUrl.trim() || submitting}
          >
            {submitting ? (isEdit ? "Saving..." : "Creating...") : (isEdit ? "Save" : "Create")}
          </Button>
          <Button onClick={onClose} variant="ghost" fullWidth>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}

AddCustomVideoModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onCreated: PropTypes.func,
  onSaved: PropTypes.func,
  node: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    prefix: PropTypes.string,
    baseUrl: PropTypes.string,
    videoApi: PropTypes.string,
  }),
};
