import { createHash } from "crypto";

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import {
  QODER_CLIENT_TYPE,
  QODER_IDE_VERSION,
  QODER_JOB_TOKEN_EXCHANGE_URL,
  QODER_USERINFO_URL,
} from "./constants.js";

const PAT_PREFIX = "pt-";
const REQUEST_TIMEOUT_MS = 15_000;
const PAT_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const DEFAULT_JOB_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

// Cache short-lived job credentials in server memory only. Hashing the PAT
// keeps the long-lived secret out of Map keys and diagnostic heap snapshots.
const patCredentialCache = new Map();

function normalizeQoderToken(token) {
  const rawToken = typeof token === "string" ? token.trim() : "";
  if (!rawToken) return "";
  if (/^(?:pt|dt|jt)-/.test(rawToken)) return rawToken;
  return `${PAT_PREFIX}${rawToken}`;
}

export function isQoderPat(token) {
  return normalizeQoderToken(token).startsWith(PAT_PREFIX);
}

function getPatCacheKey(pat) {
  return createHash("sha256").update(`qoder-pat:${pat}`).digest("hex");
}

function parseJobTokenExpiry(data) {
  const expiresAt = data?.expires_at;
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > 0) {
    return expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
  }

  if (typeof expiresAt === "string" && expiresAt.trim()) {
    const trimmed = expiresAt.trim();
    if (/^\d+$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric) && numeric > 0) {
        return numeric < 1e12 ? numeric * 1000 : numeric;
      }
    }

    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return parsed;
  }

  const expiresIn = Number(data?.expires_in);
  if (Number.isFinite(expiresIn) && expiresIn > 0) {
    // Qoder has returned both seconds (3600) and milliseconds (86400000)
    // in this field. Values longer than one week are treated as milliseconds;
    // the absolute expires_at above remains authoritative when present.
    const durationMs = expiresIn > 7 * 24 * 60 * 60
      ? expiresIn
      : expiresIn * 1000;
    return Date.now() + durationMs;
  }

  return Date.now() + DEFAULT_JOB_TOKEN_TTL_MS;
}

async function qoderFetch(url, options, proxyOptions) {
  const parentSignal = options?.signal;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("qoder request timeout")),
    REQUEST_TIMEOUT_MS,
  );

  let abortListener = null;
  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort(parentSignal.reason);
    } else {
      abortListener = () => controller.abort(parentSignal.reason);
      parentSignal.addEventListener("abort", abortListener, { once: true });
    }
  }

  try {
    return await proxyAwareFetch(
      url,
      { ...options, signal: controller.signal },
      proxyOptions,
    );
  } finally {
    clearTimeout(timeout);
    if (abortListener) parentSignal.removeEventListener("abort", abortListener);
  }
}

async function exchangePatForJobToken(pat, proxyOptions, signal) {
  const response = await qoderFetch(
    QODER_JOB_TOKEN_EXCHANGE_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "qodercli/1.0.0",
        "Cosy-Version": QODER_IDE_VERSION,
        "Cosy-ClientType": QODER_CLIENT_TYPE,
      },
      body: JSON.stringify({ personal_token: pat }),
      signal,
    },
    proxyOptions,
  );

  if (!response.ok) {
    throw new Error(`Qoder PAT exchange failed (HTTP ${response.status}).`);
  }

  const data = await response.json().catch(() => null);
  if (!data?.token || typeof data.token !== "string") {
    throw new Error("Qoder PAT exchange returned an invalid response.");
  }

  return {
    accessToken: data.token,
    expiresAt: parseJobTokenExpiry(data),
  };
}

async function fetchQoderUserId(accessToken, proxyOptions, signal) {
  const response = await qoderFetch(
    QODER_USERINFO_URL,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "User-Agent": "qodercli/1.0.0",
      },
      signal,
    },
    proxyOptions,
  );

  if (!response.ok) {
    throw new Error(`Qoder user identity request failed (HTTP ${response.status}).`);
  }

  const data = await response.json().catch(() => null);
  const userId = data?.id || data?.userId || data?.user_id || "";
  if (!String(userId).trim()) {
    throw new Error("Qoder user identity is missing; reconnect the account.");
  }
  return String(userId).trim();
}

/**
 * Resolve a token that can sign Qoder COSY requests.
 *
 * PATs are exchanged for a short-lived job token and cached until shortly
 * before expiry. Device/job tokens are used directly. When the caller has no
 * persisted user id, userinfo supplies it for COSY signing.
 */
export async function resolveQoderCredential(
  token,
  { userId = "", proxyOptions = null, signal = null } = {},
) {
  const rawToken = normalizeQoderToken(token);
  if (!rawToken) throw new Error("Qoder credential is missing.");

  if (!isQoderPat(rawToken)) {
    const resolvedUserId = String(userId || "").trim()
      || await fetchQoderUserId(rawToken, proxyOptions, signal);
    return { accessToken: rawToken, userId: resolvedUserId, expiresAt: null };
  }

  const cacheKey = getPatCacheKey(rawToken);
  const cached = patCredentialCache.get(cacheKey);
  if (cached && cached.expiresAt - Date.now() > PAT_REFRESH_BUFFER_MS) {
    return cached;
  }

  const exchanged = await exchangePatForJobToken(rawToken, proxyOptions, signal);
  const resolvedUserId = String(userId || "").trim()
    || await fetchQoderUserId(exchanged.accessToken, proxyOptions, signal);
  const credential = { ...exchanged, userId: resolvedUserId };
  patCredentialCache.set(cacheKey, credential);
  return credential;
}

export function clearQoderCredentialCache() {
  patCredentialCache.clear();
}

export function invalidateQoderCredential(token) {
  const normalizedToken = normalizeQoderToken(token);
  if (!isQoderPat(normalizedToken)) return false;
  return patCredentialCache.delete(getPatCacheKey(normalizedToken));
}
