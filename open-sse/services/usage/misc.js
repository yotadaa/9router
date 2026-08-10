/**
 * Misc usage handlers (Qwen, iFlow, Ollama, GLM, Vercel AI Gateway, Qoder)
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { buildCosyHeaders } from "../../shared/qoder/cosy.js";
import {
  invalidateQoderCredential,
  isQoderPat,
  resolveQoderCredential,
} from "../../shared/qoder/credentials.js";
import { U, fetchWithTimeout, parseResetTime } from "./shared.js";

// GLM quota endpoints (region-aware) — url from registry transport.usage
const GLM_QUOTA_URLS = {
  international: U("glm").url,
  china: U("glm-cn").url,
};

// Vercel AI Gateway credits endpoint
// Returns { balance: "95.50", total_used: "4.50" } (USD as decimal strings).
const VERCEL_AI_GATEWAY_CREDITS_URL = U("vercel-ai-gateway").url;

/**
 * Qwen Usage
 */
export async function getQwenUsage(accessToken, providerSpecificData) {
  try {
    const resourceUrl = providerSpecificData?.resourceUrl;
    if (!resourceUrl) {
      return { message: "Qwen connected. No resource URL available." };
    }

    // Qwen may have usage endpoint at resource URL
    return { message: "Qwen connected. Usage tracked per request." };
  } catch (error) {
    return { message: "Unable to fetch Qwen usage." };
  }
}

/**
 * iFlow Usage
 */
export async function getIflowUsage(accessToken) {
  try {
    // iFlow may have usage endpoint
    return { message: "iFlow connected. Usage tracked per request." };
  } catch (error) {
    return { message: "Unable to fetch iFlow usage." };
  }
}

/**
 * Ollama Cloud Usage
 */
export async function getOllamaUsage(accessToken, providerSpecificData) {
  try {
    const plan = providerSpecificData?.plan || "Free";
    return {
      plan,
      message: "Ollama Cloud uses a free tier with light usage limits (resets every 5h & 7d). For detailed usage tracking, visit ollama.com/settings/keys.",
      quotas: [],
    };
  } catch (error) {
    return { message: "Unable to fetch Ollama Cloud usage." };
  }
}

/**
 * GLM Coding Plan usage
 */
export async function getGlmUsage(apiKey, provider, proxyOptions = null) {
  if (!apiKey) {
    return { message: "GLM API key not available." };
  }

  const region = provider === "glm-cn" ? "china" : "international";
  const quotaUrl = GLM_QUOTA_URLS[region];

  try {
    const response = await proxyAwareFetch(quotaUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }, proxyOptions);

    if (!response.ok) {
      if (response.status === 401) {
        return { message: "GLM API key invalid or expired." };
      }
      return { message: `GLM quota API error (${response.status}).` };
    }

    const json = await response.json();
    const data = json?.data && typeof json.data === "object" ? json.data : {};
    const limits = Array.isArray(data.limits) ? data.limits : [];
    const quotas = {};

    for (const limit of limits) {
      if (!limit || limit.type !== "TOKENS_LIMIT") continue;
      const usedPercent = Number(limit.percentage) || 0;
      const resetMs = Number(limit.nextResetTime) || 0;
      const remaining = Math.max(0, 100 - usedPercent);

      quotas["session"] = {
        used: usedPercent,
        total: 100,
        remaining,
        remainingPercentage: remaining,
        resetAt: resetMs > 0 ? new Date(resetMs).toISOString() : null,
        unlimited: false,
      };
    }

    const levelRaw = typeof data.level === "string" ? data.level : "";
    const plan = levelRaw
      ? levelRaw.charAt(0).toUpperCase() + levelRaw.slice(1).toLowerCase()
      : "Unknown";

    return { plan, quotas };
  } catch (error) {
    return { message: `GLM error: ${error.message}` };
  }
}

/**
 * Vercel AI Gateway usage — credit balance for the API key
 */
export async function getVercelAiGatewayUsage(apiKey, proxyOptions = null) {
  if (!apiKey) {
    return { message: "Vercel AI Gateway API key not available." };
  }

  try {
    const response = await proxyAwareFetch(VERCEL_AI_GATEWAY_CREDITS_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }, proxyOptions);

    if (response.status === 401 || response.status === 403) {
      return { message: "Vercel AI Gateway API key invalid or expired." };
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const trimmed = errorText ? `: ${errorText.slice(0, 200)}` : "";
      return { message: `Vercel AI Gateway credits API error (${response.status})${trimmed}` };
    }

    const data = await response.json();

    const balance = Number(data?.balance) || 0;
    const totalUsed = Number(data?.total_used) || 0;

    const MONTHLY_CREDIT = 5;
    const remainingPercentage = (balance / MONTHLY_CREDIT) * 100;

    if (balance <= 0 && totalUsed <= 0) {
      return {
        plan: "Pay-as-you-go",
        message: "Vercel AI Gateway connected. No credit allocation found (BYOK or unfunded account).",
        quotas: {},
      };
    }

    return {
      plan: "Pay-as-you-go",
      quotas: {
        "Used (USD)": {
          used: totalUsed,
          total: 0,
          remaining: 0,
          remainingPercentage: 100,
          unlimited: true,
        },
        "Remaining (USD)": {
          used: balance,
          total: MONTHLY_CREDIT,
          remaining: balance,
          remainingPercentage,
          unlimited: false,
        },
      },
    };
  } catch (error) {
    return { message: `Vercel AI Gateway error: ${error.message}` };
  }
}

/**
 * Qoder activity quota
 *
 * api3.qoder.sh/algo endpoints require the same COSY signature as Qoder chat
 * and model-catalog requests. PAT connections are first exchanged for a
 * short-lived job token by the shared credential resolver.
 */

const QODER_USAGE_CONFIG = U("qoder");
const QODER_USAGE_TIMEOUT_MS = 15_000;

function qoderFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clampQoderCount(value, maximum) {
  return Math.min(maximum, Math.max(0, value));
}

function qoderActivityKey(activity, index, quotas) {
  const activityId = typeof activity.activityId === "string"
    ? activity.activityId.trim()
    : "";
  const firstModelKey = Array.isArray(activity.modelKeys)
    ? String(activity.modelKeys.find(Boolean) || "").trim()
    : "";
  const baseKey = activityId || firstModelKey || `free-quota-${index + 1}`;

  if (!Object.prototype.hasOwnProperty.call(quotas, baseKey)) return baseKey;
  let suffix = 2;
  while (Object.prototype.hasOwnProperty.call(quotas, `${baseKey}-${suffix}`)) {
    suffix += 1;
  }
  return `${baseKey}-${suffix}`;
}

function parseQoderActivityUsage(payload) {
  const activities = payload?.data?.activities;
  if (!Array.isArray(activities)) {
    return { message: "Qoder returned an invalid activity quota response." };
  }

  const queryAtValue = qoderFiniteNumber(payload?.data?.queryAt);
  const quotas = {};
  for (const [index, activity] of activities.entries()) {
    if (!activity || activity.type !== "MODEL_FREE_QUOTA") continue;
    if (activity.eligible === false) continue;
    if (activity.deviceOccupiedByOthers === true) continue;

    const activityEndAtValue = qoderFiniteNumber(activity.activityEndAt);
    if (
      activityEndAtValue != null
      && activityEndAtValue > 0
      && queryAtValue != null
      && queryAtValue > 0
      && activityEndAtValue <= queryAtValue
    ) {
      continue;
    }

    const limitValue = qoderFiniteNumber(activity.limit);
    if (limitValue == null || limitValue <= 0) continue;
    const limit = Math.max(0, limitValue);

    const usedValue = qoderFiniteNumber(activity.used);
    const remainingValue = qoderFiniteNumber(activity.remaining);
    const used = clampQoderCount(
      usedValue ?? (remainingValue == null ? 0 : limit - remainingValue),
      limit,
    );
    const remaining = clampQoderCount(
      remainingValue ?? (limit - used),
      limit,
    );

    const activityId = typeof activity.activityId === "string"
      ? activity.activityId.trim()
      : "";
    const modelKeys = Array.isArray(activity.modelKeys)
      ? activity.modelKeys.map(String).filter(Boolean)
      : [];
    const name = (typeof activity.modelName === "string" && activity.modelName.trim())
      || modelKeys[0]
      || "Free Quota";
    const resetAtValue = (qoderFiniteNumber(activity.resetAt) || 0) > 0
      ? activity.resetAt
      : activity.activityEndAt;
    const resetAt = parseResetTime(resetAtValue);
    const key = qoderActivityKey(activity, index, quotas);

    quotas[key] = {
      name,
      activityId: activityId || key,
      modelKeys,
      used,
      total: limit,
      remaining,
      remainingPercentage: Math.min(100, Math.max(0, (remaining / limit) * 100)),
      unit: "calls",
      resetAt,
      recurring:
        activity.resetStrategy !== "NEVER_EXPIRE"
        && (qoderFiniteNumber(activity.resetAt) || 0) > 0,
      unlimited: false,
      resetStrategy: activity.resetStrategy || null,
      statusText: typeof activity.statusText === "string" ? activity.statusText : "",
      description: typeof activity.description === "string" ? activity.description : "",
      eligible: activity.eligible !== false,
      claimActivity: activity.claimActivity === true,
      deviceOccupiedByOthers: activity.deviceOccupiedByOthers === true,
      activityEndAt: parseResetTime(activity.activityEndAt),
    };
  }

  if (Object.keys(quotas).length === 0) {
    return {
      plan: "Qoder Free",
      message: "No eligible Qoder free quota activities are currently available.",
      quotas: {},
      queryAt: parseResetTime(payload?.data?.queryAt),
    };
  }

  return {
    plan: "Qoder Free",
    quotas,
    queryAt: parseResetTime(payload?.data?.queryAt),
  };
}

function qoderPlanLabel(userType) {
  const raw = typeof userType === "string" ? userType.trim() : "";
  if (!raw) return "Qoder Free";
  if (raw.includes("professional_trial")) return "Professional Trial";
  if (raw.includes("personal")) return "Personal";
  return raw
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function parseQoderCreditsUsage(payload) {
  const userQuota = payload?.userQuota;
  const plan = qoderPlanLabel(payload?.userType);
  if (!userQuota || typeof userQuota !== "object") {
    return { plan, quotas: {}, message: "Qoder returned an invalid credits quota response." };
  }

  const totalValue = qoderFiniteNumber(userQuota.total);
  if (totalValue == null || totalValue <= 0) {
    return { plan, quotas: {}, message: "No Qoder credits quota is currently available." };
  }

  const total = Math.max(0, totalValue);
  const usedValue = qoderFiniteNumber(userQuota.used);
  const remainingValue = qoderFiniteNumber(userQuota.remaining);
  const used = clampQoderCount(
    usedValue ?? (remainingValue == null ? 0 : total - remainingValue),
    total,
  );
  const remaining = clampQoderCount(
    remainingValue ?? (total - used),
    total,
  );

  return {
    plan,
    quotas: {
      credits: {
        name: "Credits",
        used,
        total,
        remaining,
        remainingPercentage: Math.min(100, Math.max(0, (remaining / total) * 100)),
        resetAt: parseResetTime(payload?.expiresAt ?? userQuota.expiresAt),
        recurring: false,
        unlimited: false,
        unit: typeof userQuota.unit === "string" && userQuota.unit.trim()
          ? userQuota.unit.trim()
          : "credits",
      },
    },
  };
}

function qoderActivityHttpMessage(status) {
  if (status === 401 || status === 403) {
    return "Qoder authentication expired or was rejected. Reconnect the account.";
  }
  if (status === 429) {
    return "Qoder quota service is rate limited. Try again shortly.";
  }
  return status
    ? `Qoder activity quota request failed (HTTP ${status}).`
    : "Qoder activity quota is temporarily unavailable.";
}

function qoderCredentialMessage(error) {
  const message = typeof error?.message === "string" ? error.message : "";
  if (
    message.startsWith("Qoder PAT exchange")
    || message.startsWith("Qoder user identity")
    || message.startsWith("Qoder credential")
  ) {
    return message;
  }
  if (error?.name === "AbortError" || /timeout/i.test(message)) {
    return "Qoder authentication request timed out. Try again.";
  }
  return "Unable to authenticate with Qoder. Reconnect the account and try again.";
}

function qoderRequestFailureMessage(source, error) {
  const timedOut = error?.name === "AbortError"
    || /abort|timeout/i.test(error?.message || "");
  if (timedOut) return `Qoder ${source} quota request timed out. Try again.`;
  return `Qoder ${source} quota is temporarily unavailable.`;
}

function qoderCreditsHttpMessage(status) {
  if (status === 401 || status === 403) {
    return "Qoder credits authentication expired or was rejected. Reconnect the account.";
  }
  if (status === 429) {
    return "Qoder credits service is rate limited. Try again shortly.";
  }
  return status
    ? `Qoder credits quota request failed (HTTP ${status}).`
    : "Qoder credits quota is temporarily unavailable.";
}

async function discardQoderOutcome(outcome) {
  try {
    await outcome?.response?.body?.cancel();
  } catch {
    // The response may already be closed by the transport. Nothing to retain.
  }
}

async function fetchQoderOutcome(url, options, proxyOptions) {
  try {
    const response = await fetchWithTimeout(
      url,
      options,
      QODER_USAGE_TIMEOUT_MS,
      proxyOptions,
    );
    return { response, error: null };
  } catch (error) {
    return { response: null, error };
  }
}

function buildQoderActivityHeaders(activityUrl, credential, providerSpecificData) {
  return {
    Accept: "application/json",
    "Accept-Encoding": "identity",
    ...buildCosyHeaders(Buffer.alloc(0), activityUrl, {
      userId: credential.userId,
      authToken: credential.accessToken,
      name: "",
      email: "",
      machineId: providerSpecificData?.machineId || "",
    }),
  };
}

function qoderActivityUrlForCredential(credential) {
  const accessToken = typeof credential?.accessToken === "string"
    ? credential.accessToken.trim()
    : "";
  if (accessToken.startsWith("jt-") && QODER_USAGE_CONFIG.jobTokenActivityUrl) {
    return QODER_USAGE_CONFIG.jobTokenActivityUrl;
  }
  return QODER_USAGE_CONFIG.activityUrl;
}

async function fetchQoderSources(credential, providerSpecificData, proxyOptions, activityUrl) {
  const activityPromise = fetchQoderOutcome(
    activityUrl,
    {
      method: "GET",
      headers: buildQoderActivityHeaders(activityUrl, credential, providerSpecificData),
    },
    proxyOptions,
  );
  const creditsPromise = fetchQoderOutcome(
    QODER_USAGE_CONFIG.url,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        Accept: "application/json",
        "Accept-Encoding": "identity",
      },
    },
    proxyOptions,
  );

  const [activity, credits] = await Promise.all([activityPromise, creditsPromise]);
  return { activity, credits };
}

function qoderAuthRejected(outcome) {
  return outcome?.response?.status === 401 || outcome?.response?.status === 403;
}

async function parseQoderActivityOutcome(outcome) {
  if (outcome.error) {
    return { quotas: {}, message: qoderRequestFailureMessage("activity", outcome.error) };
  }
  if (!outcome.response?.ok) {
    await discardQoderOutcome(outcome);
    return { quotas: {}, message: qoderActivityHttpMessage(outcome.response?.status) };
  }

  const payload = await outcome.response.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    return { quotas: {}, message: "Qoder returned invalid JSON for activity quota." };
  }
  if (Number(payload.code) !== 0) {
    const upstreamMessage = typeof payload.msg === "string"
      ? payload.msg.replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, 160)
      : "";
    return {
      quotas: {},
      message: upstreamMessage
        ? `Qoder activity quota error: ${upstreamMessage}`
        : `Qoder activity quota error (code ${String(payload.code)}).`,
    };
  }
  return parseQoderActivityUsage(payload);
}

async function parseQoderCreditsOutcome(outcome) {
  if (outcome.error) {
    return { quotas: {}, message: qoderRequestFailureMessage("credits", outcome.error) };
  }
  if (!outcome.response?.ok) {
    await discardQoderOutcome(outcome);
    return { quotas: {}, message: qoderCreditsHttpMessage(outcome.response?.status) };
  }

  const payload = await outcome.response.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    return { quotas: {}, message: "Qoder returned invalid JSON for credits quota." };
  }
  return parseQoderCreditsUsage(payload);
}

export async function getQoderUsage(apiKey, providerSpecificData, proxyOptions = null) {
  const token = String(
    (apiKey || "").trim()
    || providerSpecificData?.qoderPat
    || "",
  ).trim();

  if (!token) {
    return {
      message: "Qoder credential is missing. Reconnect the account or add a Personal Access Token.",
    };
  }
  if (!QODER_USAGE_CONFIG.url || !QODER_USAGE_CONFIG.activityUrl) {
    return { message: "Qoder quota endpoints are not configured." };
  }

  let credential;
  try {
    credential = await resolveQoderCredential(token, {
      userId: providerSpecificData?.userId,
      proxyOptions,
    });
  } catch (error) {
    return { message: qoderCredentialMessage(error) };
  }

  let outcomes;
  let activityUrlUsed = qoderActivityUrlForCredential(credential);
  const refreshWarnings = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    activityUrlUsed = qoderActivityUrlForCredential(credential);
    outcomes = await fetchQoderSources(
      credential,
      providerSpecificData,
      proxyOptions,
      activityUrlUsed,
    );

    const shouldRefreshPat = attempt === 0
      && isQoderPat(token)
      && (qoderAuthRejected(outcomes.activity) || qoderAuthRejected(outcomes.credits));
    if (!shouldRefreshPat) break;

    invalidateQoderCredential(token);
    try {
      const refreshedCredential = await resolveQoderCredential(token, {
        userId: providerSpecificData?.userId,
        proxyOptions,
      });
      await Promise.all([
        discardQoderOutcome(outcomes.activity),
        discardQoderOutcome(outcomes.credits),
      ]);
      credential = refreshedCredential;
    } catch (error) {
      // Keep any already-successful source readable. A quota refresh is still
      // useful when activity or credits succeeded before PAT renewal failed.
      refreshWarnings.push(qoderCredentialMessage(error));
      break;
    }
  }

  if (
    qoderAuthRejected(outcomes.activity)
    && QODER_USAGE_CONFIG.jobTokenActivityUrl
    && QODER_USAGE_CONFIG.jobTokenActivityUrl !== activityUrlUsed
  ) {
    await discardQoderOutcome(outcomes.activity);
    outcomes.activity = await fetchQoderOutcome(
      QODER_USAGE_CONFIG.jobTokenActivityUrl,
      {
        method: "GET",
        headers: buildQoderActivityHeaders(
          QODER_USAGE_CONFIG.jobTokenActivityUrl,
          credential,
          providerSpecificData,
        ),
      },
      proxyOptions,
    );
  }

  const [activityUsage, creditsUsage] = await Promise.all([
    parseQoderActivityOutcome(outcomes.activity),
    parseQoderCreditsOutcome(outcomes.credits),
  ]);
  const quotas = {
    ...(activityUsage.quotas || {}),
    ...(creditsUsage.quotas || {}),
  };
  const warnings = [
    ...refreshWarnings,
    activityUsage.message,
    creditsUsage.message,
  ].filter(Boolean);

  if (Object.keys(quotas).length === 0) {
    return {
      plan: creditsUsage.plan || activityUsage.plan || "Qoder Free",
      quotas: {},
      message: warnings[0] || "No Qoder quota is currently available.",
    };
  }

  return {
    plan: creditsUsage.plan || activityUsage.plan || "Qoder Free",
    quotas,
    queryAt: activityUsage.queryAt || null,
    ...(warnings.length ? { warnings } : {}),
  };
}
