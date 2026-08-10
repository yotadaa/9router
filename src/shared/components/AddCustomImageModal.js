"use client";

import { useState, useEffect, useMemo } from "react";
import PropTypes from "prop-types";
import { Modal, Input, Button, Badge, Select } from "@/shared/components";
import { AI_PROVIDERS } from "@/shared/constants/providers";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const OTHER_PRESET = "other";

// Presets: every built-in provider whose image endpoint is an OpenAI-compatible
// /images/generations URL (derived from the registry, so new providers appear
// automatically). OAuth/proprietary image providers (gemini, antigravity, ...)
// are excluded — custom nodes require an API-key OpenAI-compatible endpoint.
function buildPresets() {
  const presets = Object.values(AI_PROVIDERS || {})
    .filter((p) => typeof p?.imageConfig?.baseUrl === "string" && p.imageConfig.baseUrl.endsWith("/images/generations"))
    .map((p) => ({
      id: p.id,
      name: p.display?.name || p.name || p.id,
      baseUrl: p.imageConfig.baseUrl.slice(0, -"/images/generations".length),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return presets;
}

// Dual-mode modal: edit when `node` provided, add otherwise
export default function AddCustomImageModal({ isOpen, onClose, onCreated, onSaved, node }) {
  const isEdit = !!node;
  const presets = useMemo(buildPresets, []);
  const [presetId, setPresetId] = useState(OTHER_PRESET);
  const [formData, setFormData] = useState({
    name: "",
    prefix: "",
    baseUrl: DEFAULT_BASE_URL,
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
      });
      setPresetId(OTHER_PRESET);
    } else {
      setFormData({ name: "", prefix: "", baseUrl: DEFAULT_BASE_URL });
      setPresetId(OTHER_PRESET);
    }
  }, [isOpen, isEdit, node]);

  const handlePresetChange = (value) => {
    setPresetId(value);
    const preset = presets.find((p) => p.id === value);
    if (preset) {
      setFormData((prev) => ({ ...prev, baseUrl: preset.baseUrl }));
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
      };
      if (!isEdit) payload.type = "custom-image";

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
      console.log("Error saving custom image node:", error);
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
          type: "custom-image",
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
      return <Badge variant="success">Valid</Badge>;
    }
    return (
      <div className="flex flex-col gap-1">
        <Badge variant="error">Invalid</Badge>
        {validationResult.error && <span className="text-sm text-red-500">{validationResult.error}</span>}
      </div>
    );
  };

  return (
    <Modal isOpen={isOpen} title={isEdit ? "Edit Custom Image Provider" : "Add Custom Image Provider"} onClose={onClose}>
      <div className="flex flex-col gap-4">
        {!isEdit && (
          <Select
            label="Compatible Provider"
            value={presetId}
            onChange={(e) => handlePresetChange(e.target.value)}
            options={[
              ...presets.map((p) => ({ value: p.id, label: p.name })),
              { value: OTHER_PRESET, label: "Other (custom URL)" },
            ]}
            hint="Prefills the base URL for known OpenAI-compatible Text to Image APIs."
          />
        )}
        <Input
          label="Name"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder="My Flux Gateway"
          hint="Required. A friendly label for this image provider."
        />
        <Input
          label="Prefix"
          value={formData.prefix}
          onChange={(e) => setFormData({ ...formData, prefix: e.target.value })}
          placeholder="myimg"
          hint="Required. Used as the provider prefix for model IDs (e.g. myimg/flux-1-dev)."
        />
        <Input
          label="Base URL"
          value={formData.baseUrl}
          onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
          placeholder="https://api.openai.com/v1"
          hint="OpenAI-compatible API base. Images are requested at {baseUrl}/images/generations."
        />
        <Input
          label="API Key (for Check)"
          type="password"
          value={checkKey}
          onChange={(e) => setCheckKey(e.target.value)}
          hint="Checks {baseUrl}/models with this key (no generation is spent)."
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

AddCustomImageModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onCreated: PropTypes.func,
  onSaved: PropTypes.func,
  node: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    prefix: PropTypes.string,
    baseUrl: PropTypes.string,
  }),
};
