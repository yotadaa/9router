/**
 * Misc usage handlers (Qwen, iFlow, Ollama, GLM, Vercel AI Gateway, Qoder)
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { U, parseResetTime } from "./shared.js";

// GLM quota endpoints (region-aware) — url from registry transport.usage
const GLM_QUOTA_URLS = {
  international: U("glm").url,
  china: U("glm-cn").url,
};

// Vercel AI Gateway credits endpoint
// Returns { balance: "95.50", total_used: "4.50" } (USD as decimal strings).
const VERCEL_AI_GATEWAY_CREDITS_URL = U("vercel-ai-gateway").url;

// Qoder quota endpoints
const QODER_QUOTA_USAGE_URL = "https://api3.qoder.sh/api/v2/quota/usage";
const QODER_ACTIVITY_URL = "https://api3.qoder.sh/algo/api/v2/activity";

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
 * Qoder Usage
 *
 * Primary: GET https://openapi.qoder.sh/api/v2/quota/usage (simpler, no COSY)
 * Fallback: GET https://api3.qoder.sh/algo/api/v2/activity (requires COSY signing)
 */

const QODER_QUOTA_USAGE_URL = "https://openapi.qoder.sh/api/v2/quota/usage";
const QODER_ACTIVITY_URL = "https://api3.qoder.sh/algo/api/v2/activity";

/** Parse numeric values safely */
function parseNumber(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value == null) return fallback;

  if (typeof value === "object" && !Array.isArray(value) && "val" in value) {
    return typeof value.val === "number" && Number.isFinite(value.val)
      ? value.val
      : fallback;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  return fallback;
}

/**
 * Resolve job token from PAT (Personal Access Token)
 * Exchanges pt-... PAT for short-lived jt-... job token used by COSY-signed requests.
 * This endpoint is NOT COSY-signed (plain JSON POST).
 */
async function resolveQoderJobToken(pat) {
  // Normalize PAT: ensure it has "pt-" prefix
  const normalizedPat = pat.startsWith("pt-") ? pat : `pt-${pat}`;

  console.log("[Qoder PAT Exchange] Starting exchange with normalized PAT:", normalizedPat);

  const response = await proxyAwareFetch(
    "https://openapi.qoder.sh/api/v1/jobToken/exchange",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Cosy-Version": "1.0.1",
        "Cosy-ClientType": "5",
      },
      body: JSON.stringify({ personal_token: normalizedPat }),
    },
    null,
  );

  console.log("[Qoder PAT Exchange] Response status:", response.status);

  if (!response.ok || response.status === 401 || response.status === 403) {
    const text = await response.text().catch(() => "");
    console.error("[Qoder PAT Exchange] Exchange failed:", text.slice(0, 200));
    throw new Error(`Failed to exchange PAT for job token (HTTP ${response.status})`);
  }

  const data = await response.json();
  console.log("[Qoder PAT Exchange] Received data keys:", Object.keys(data));

  const jobToken = data?.jobToken || data?.token;
  if (!jobToken) {
    console.error("[Qoder PAT Exchange] No job token in response:", JSON.stringify(data));
    throw new Error("Job token not found in response");
  }

  console.log("[Qoder PAT Exchange] Success! Got job token starting with:", jobToken.substring(0, 8) + "...");
  return jobToken;
}

/**
 * Map Qoder /quota/usage response into normalized quota format
 * @param {Object} quotaData - Response from https://openapi.qoder.sh/api/v2/quota/usage
 */
function parseQoderQuotaUsage(quotaData) {
  console.log("[Parser] Input quota data:", JSON.stringify(quotaData));
  console.log("[Parser] Keys in quotaData:", Object.keys(quotaData));

  const quotas = {};

  // Structure 1: Check for nested data object (from your API example)
  if (quotaData.data && Array.isArray(quotaData.data?.activities)) {
    console.log("[Parser] Found data.activities structure");
    const activities = quotaData.data.activities;

    for (const activity of activities) {
      console.log("[Parser] Processing activity:", activity.type, "-", activity.modelName);

      if (activity.type !== "MODEL_FREE_QUOTA") continue;

      const modelName = activity.modelName || "Free Quota";
      const limit = Number(activity.limit) || 0;
      const used = Number(activity.used) || 0;
      const remaining = Math.max(0, Number(activity.remaining) || 0);

      console.log("[Parser] Activity details: limit=", limit, ", used=", used, ", remaining=", remaining);

      if (limit > 0) {
        quotas[modelName] = {
          name: modelName,
          used: used,
          total: limit,
          remaining: remaining,
          remainingPercentage: (remaining / limit) * 100,
          resetAt: parseResetTime(activity.resetAt),
          unlimited: false,
          statusText: activity.statusText || "",
          eligible: activity.eligible === true,
          description: activity.description || "",
        };
        console.log("[Parser] Added quota for:", modelName);
      }
    }
  }

  // Structure 2: userQuota object (current API response!)
  if (quotaData.userQuota) {
    console.log("[Parser] Found .userQuota field");
    const userQuota = quotaData.userQuota;

    quotas["Credits Quota"] = {
      name: "Credits Quota",
      used: Number(userQuota.used) || 0,
      total: Number(userQuota.total) || 0,
      remaining: Number(userQuota.remaining) || 0,
      remainingPercentage: (Number(userQuota.total) > 0) ? (Number(userQuota.remaining) / Number(userQuota.total)) * 100 : 0,
      resetAt: parseResetTime(userQuota.expiresAt),
      unlimited: false,
      unit: userQuota.unit || "credits",
      percentage: userQuota.percentage || 0,
      isQuotaExceeded: quotaData.isQuotaExceeded || false,
      upgradeUrl: quotaData.upgradeUrl || "",
    };
    console.log("[Parser] Added Credits Quota entry");
  }

  // Structure 3: Direct quota object at root level
  if (quotaData.quota) {
    console.log("[Parser] Found .quota field");
    const quota = quotaData.quota;
    quotas["Requests"] = {
      name: "Requests",
      used: Number(quota.used) || 0,
      total: Number(quota.limit) || 0,
      remaining: Math.max(0, Number(quota.remaining) || 0),
      remainingPercentage: (Number(quota.remaining) || 0) / (Number(quota.limit) || 1) * 100,
      resetAt: parseResetTime(quota.resetAt),
      unlimited: false,
    };
  }

  // Structure 4: Root-level limit/used fields
  if (quotaData.limit && typeof quotaData.used !== 'undefined') {
    console.log("[Parser] Found root-level limit/used");
    const planLabel = quotaData.planType || "Qoder Free";

    quotas["Free Quota"] = {
      name: "Free Quota",
      used: Number(quotaData.used) || 0,
      total: Number(quotaData.limit) || 0,
      remaining: Math.max(0, Number(quotaData.remaining) || 0),
      remainingPercentage: (Number(quotaData.limit) > 0) ? (Math.max(0, Number(quotaData.remaining)) / Number(quotaData.limit)) * 100 : 100,
      resetAt: parseResetTime(quotaData.resetAt),
      unlimited: false,
      description: quotaData.description || "",
    };
  }

  // Structure 5: Activities array at root level
  if (!quotaData.data && !quotaData.userQuota && quotaData.activities && Array.isArray(quotaData.activities)) {
    console.log("[Parser] Found root-level .activities array");

    for (const activity of quotaData.activities) {
      if (activity.type !== "MODEL_FREE_QUOTA") continue;

      const modelName = activity.modelName || "Free Quota";
      const limit = Number(activity.limit) || 0;
      const used = Number(activity.used) || 0;
      const remaining = Math.max(0, Number(activity.remaining) || 0);

      if (limit > 0) {
        quotas[modelName] = {
          name: modelName,
          used: used,
          total: limit,
          remaining: remaining,
          remainingPercentage: (remaining / limit) * 100,
          resetAt: parseResetTime(activity.resetAt),
          unlimited: false,
          statusText: activity.statusText || "",
          eligible: activity.eligible === true,
          description: activity.description || "",
        };
      }
    }
  }

  console.log("[Parser] Final quotas object:", JSON.stringify(Object.keys(quotas)));

  if (Object.keys(quotas).length === 0) {
    console.log("[Parser] No quotas found!");
    return {
      plan: "Qoder",
      message: "No active free quota activities found. You may need to claim available activities.",
      quotas: {},
    };
  }

  // Extract plan label from userType
  let planLabel = "Qoder Free";
  if (quotaData.userType) {
    if (quotaData.userType.includes("trial")) planLabel = "Professional Trial";
    else if (quotaData.userType.includes("personal")) planLabel = "Personal";
    else planLabel = quotaData.userType.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase());
  }

  return {
    plan: planLabel,
    quotas,
  };
}

export async function getQoderUsage(apiKey, providerSpecificData, proxyOptions = null) {
  const token = (apiKey || "").trim() || String(providerSpecificData?.qoderPat || "").trim();
  if (!token) {
    return { message: "Qoder connected. Add a Personal Access Token to view quota." };
  }

  console.log("[Qoder Usage] Token received:", token);

  // Try multiple endpoints in order of preference:
  // 1. Direct PAT with simple quota endpoint (no COSY needed)
  // 2. Job token with simple quota endpoint
  // 3. Job token with COSY activity endpoint (if needed)

  // Try direct PAT with simple quota endpoint
  try {
    console.log("[Qoder Usage] Attempting simple quota API with PAT...");
    const simpleResponse = await proxyAwareFetch(
      QODER_QUOTA_USAGE_URL,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      },
      proxyOptions,
    );
    console.log("[Qoder Usage] Simple quota API status:", simpleResponse.status);

    if (simpleResponse.ok && simpleResponse.status !== 401 && simpleResponse.status !== 403) {
      let quotaData;
      try {
        quotaData = await simpleResponse.json();
        console.log("[Qoder Usage] Direct PAT success with simple quota API, storing for later");

        // Store user credits but continue to fetch activity quotas too
        if (quotaData.userQuota) {
          const userQuota = quotaData.userQuota;
          const limit = Number(userQuota.total) || 0;
          const used = Number(userQuota.used) || 0;
          const remaining = Number(userQuota.remaining) || 0;

          if (limit > 0) {
            combinedQuotas["Credits"] = {
              name: "Credits",
              used: used,
              total: limit,
              remaining: remaining,
              remainingPercentage: (remaining / limit) * 100,
              resetAt: parseResetTime(userQuota.expiresAt),
              unlimited: false,
              unit: userQuota.unit || "credits",
            };
          }
        }
      } catch (e) {
        console.warn("[Qoder Usage] Failed to parse direct PAT simple quota response:", e.message);
      }
    }
  } catch (error) {
    console.warn("[Qoder Usage] Simple quota API attempt failed:", error.message);
  }

  // Exchange PAT for job token (needed for COSY-signed activity API)
  let authToken;
  try {
    console.log("[Qoder Usage] Exchanging PAT for job token...");
    authToken = await resolveQoderJobToken(token);
  } catch (error) {
    console.error("[Qoder Usage] Job token exchange failed:", error.message);
    return {
      message: `Qoder connected. Unable to validate your Personal Access Token - ${error.message}. Please check your PAT at https://qoder.com/account/integrations`,
      error: error.message
    };
  }

  // Fetch Activity API for MODEL_FREE_QUOTA activities (800 free calls example)
  try {
    console.log("[Qoder Usage] Fetching from activity API (/algo/api/v2/activity)...");
    const activityResponse = await proxyAwareFetch(
      QODER_ACTIVITY_URL,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${authToken}`,
          Accept: "application/json",
        },
      },
      proxyOptions,
    );
    console.log("[Qoder Usage] Activity API status:", activityResponse.status);

    if (activityResponse.ok && activityResponse.status !== 401 && activityResponse.status !== 403) {
      let activityData;
      try {
        activityData = await activityResponse.json();

        // Handle nested .data.activities structure
        let activities = [];
        if (activityData.data && Array.isArray(activityData.data.activities)) {
          activities = activityData.data.activities;
          console.log("[Qoder Usage] Found activities in .data.activities:", activities.length);
        } else if (Array.isArray(activityData.activities)) {
          activities = activityData.activities;
          console.log("[Qoder Usage] Found root-level activities:", activities.length);
        }

        if (activities.length > 0) {
          // Find all MODEL_FREE_QUOTA activities
          for (const activity of activities) {
            if (activity.type === "MODEL_FREE_QUOTA") {
              const modelName = activity.modelName || "Free Quota";
              const limit = Number(activity.limit) || 0;
              const used = Number(activity.used) || 0;
              const remaining = Math.max(0, Number(activity.remaining) || 0);

              console.log(`[Qoder Usage] Found FREE QUOTA: ${modelName} - ${remaining}/${limit} remaining`);

              if (limit > 0) {
                // Only add if not already present (to avoid duplication with Credits)
                if (!combinedQuotas[modelName]) {
                  combinedQuotas[modelName] = {
                    name: modelName,
                    used: used,
                    total: limit,
                    remaining: remaining,
                    remainingPercentage: (remaining / limit) * 100,
                    resetAt: parseResetTime(activity.resetAt),
                    unlimited: false,
                    statusText: activity.statusText || "",
                    description: activity.description || "",
                  };
                }
              }
            }
          }
        }
      } catch (e) {
        console.warn("[Qoder Usage] Failed to parse activity response:", e.message);
      }
    } else {
      console.log("[Qoder Usage] Activity API returned", activityResponse.status);
    }
  } catch (error) {
    console.warn("[Qoder Usage] Activity API fetch failed:", error.message);
  }

  // Source 2: Activity API for MODEL_FREE_QUOTA activities (800 free calls example)
  try {
    console.log("[Qoder Usage] Fetching from activity API (/algo/api/v2/activity)...");
    const activityResponse = await proxyAwareFetch(
      QODER_ACTIVITY_URL,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${authToken}`,
          Accept: "application/json",
        },
      },
      proxyOptions,
    );
    console.log("[Qoder Usage] Activity API status:", activityResponse.status);

    if (activityResponse.ok && activityResponse.status !== 401 && activityResponse.status !== 403) {
      let activityData;
      try {
        activityData = await activityResponse.json();

        // Handle nested .data.activities structure
        let activities = [];
        if (activityData.data && Array.isArray(activityData.data.activities)) {
          activities = activityData.data.activities;
          console.log("[Qoder Usage] Found activities in .data.activities:", activities.length);
        } else if (Array.isArray(activityData.activities)) {
          activities = activityData.activities;
          console.log("[Qoder Usage] Found root-level activities:", activities.length);
        }

        if (activities.length > 0) {
          // Find all MODEL_FREE_QUOTA activities
          for (const activity of activities) {
            if (activity.type === "MODEL_FREE_QUOTA") {
              const modelName = activity.modelName || "Free Quota";
              const limit = Number(activity.limit) || 0;
              const used = Number(activity.used) || 0;
              const remaining = Math.max(0, Number(activity.remaining) || 0);

              console.log(`[Qoder Usage] Found FREE QUOTA: ${modelName} - ${remaining}/${limit} remaining`);

              if (limit > 0) {
                combinedQuotas[modelName] = {
                  name: modelName,
                  used: used,
                  total: limit,
                  remaining: remaining,
                  remainingPercentage: (remaining / limit) * 100,
                  resetAt: parseResetTime(activity.resetAt),
                  unlimited: false,
                  statusText: activity.statusText || "",
                  description: activity.description || "",
                };
              }
            }
          }
        }
      } catch (e) {
        console.warn("[Qoder Usage] Failed to parse activity response:", e.message);
      }
    } else {
      console.log("[Qoder Usage] Activity API returned", activityResponse.status, ", trying fallback quota/user endpoint...");

      // Fallback: Try /api/v2/quota/user endpoint
      const fallbackActivityUrl = "https://openapi.qoder.sh/api/v2/quota/user";
      console.log("[Qoder Usage] Trying fallback endpoint:", fallbackActivityUrl);

      const fallbackResponse = await proxyAwareFetch(
        fallbackActivityUrl,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${authToken}`,
            Accept: "application/json",
          },
        },
        proxyOptions,
      );

      console.log("[Qoder Usage] Fallback endpoint status:", fallbackResponse.status);

      if (fallbackResponse.ok) {
        let fallbackData;
        try {
          fallbackData = await fallbackResponse.json();
          console.log("[Qoder Usage] Fallback endpoint response:", JSON.stringify(fallbackData));

          // Check for activities in fallback response
          let activities = [];
          if (fallbackData.data && Array.isArray(fallbackData.data.activities)) {
            activities = fallbackData.data.activities;
            console.log("[Qoder Usage] Found activities in fallback .data.activities:", activities.length);
          } else if (fallbackData.activities && Array.isArray(fallbackData.activities)) {
            activities = fallbackData.activities;
            console.log("[Qoder Usage] Found activities in fallback root level:", activities.length);
          }

          if (activities.length > 0) {
            for (const activity of activities) {
              if (activity.type === "MODEL_FREE_QUOTA") {
                const modelName = activity.modelName || "Free Quota";
                const limit = Number(activity.limit) || 0;
                const used = Number(activity.used) || 0;
                const remaining = Math.max(0, Number(activity.remaining) || 0);

                console.log(`[Qoder Usage] Found FREE QUOTA via fallback: ${modelName} - ${remaining}/${limit} remaining`);

                if (limit > 0) {
                  combinedQuotas[modelName] = {
                    name: modelName,
                    used: used,
                    total: limit,
                    remaining: remaining,
                    remainingPercentage: (remaining / limit) * 100,
                    resetAt: parseResetTime(activity.resetAt),
                    unlimited: false,
                    statusText: activity.statusText || "",
                    description: activity.description || "",
                  };
                }
              }
            }
          }
        } catch (e) {
          console.warn("[Qoder Usage] Failed to parse fallback endpoint response:", e.message);
        }
      }
    }
  } catch (error) {
    console.warn("[Qoder Usage] Activity API fetch failed:", error.message);
  }

  // Return combined quotas or fall back to just credits if no activities
  if (Object.keys(combinedQuotas).length === 0) {
    // Fallback to simple quota parsing
    try {
      const fallbackResponse = await proxyAwareFetch(
        QODER_QUOTA_USAGE_URL,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${authToken}`,
            Accept: "application/json",
          },
        },
        proxyOptions,
      );
      if (fallbackResponse.ok) {
        const fallbackData = await fallbackResponse.json();
        return parseQoderQuotaUsage(fallbackData);
      }
    } catch (e) {
      console.warn("[Qoder Usage] Fallback fetch failed:", e.message);
    }

    return {
      plan: "Qoder Free",
      message: "No active free quota activities found. You may need to claim available activities.",
      quotas: {},
    };
  }

  // Extract plan label from userType
  let planLabel = "Qoder Free";
  try {
    const quotaResponse = await proxyAwareFetch(
      QODER_QUOTA_USAGE_URL,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${authToken}`,
          Accept: "application/json",
        },
      },
      proxyOptions,
    );
    if (quotaResponse.ok) {
      const quotaData = await quotaResponse.json();
      if (quotaData.userType) {
        if (quotaData.userType.includes("trial")) planLabel = "Professional Trial";
        else if (quotaData.userType.includes("personal")) planLabel = "Personal";
        else planLabel = quotaData.userType.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase());
      }
    }
  } catch (e) {}

  return {
    plan: planLabel,
    quotas: combinedQuotas,
  };
}
