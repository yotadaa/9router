// Shared helpers for image provider adapters

export const POLL_INTERVAL_MS = 1500;
export const POLL_TIMEOUT_MS = 120000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Map OpenAI size to provider-specific aspect ratio
export function sizeToAspectRatio(size) {
  if (!size || typeof size !== "string") return "1:1";
  const map = {
    "1024x1024": "1:1",
    "1024x1792": "9:16",
    "1792x1024": "16:9",
    "1024x1536": "2:3",
    "1536x1024": "3:2",
  };
  return map[size] || "1:1";
}

// Fetch URL → base64 (for providers returning image URLs)
export async function urlToBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const buf = await res.arrayBuffer();
  return Buffer.from(buf).toString("base64");
}

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

// Common OpenAI-compatible endpoint paths appended to a custom API base URL
export const IMAGES_GENERATIONS_PATH = "/images/generations";
export const RESPONSES_PATH = "/responses";

// Read the per-connection custom host override (providerSpecificData.customBaseUrl).
// Returns a trimmed http(s) URL, or null when unset/invalid.
function getCustomBaseUrl(creds) {
  const raw = creds?.providerSpecificData?.customBaseUrl;
  if (typeof raw !== "string") return null;
  const url = raw.trim();
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    new URL(url);
    return url;
  } catch {
    return null;
  }
}

// Resolve an endpoint honoring a per-connection custom host override
// (providerSpecificData.customBaseUrl, e.g. a self-hosted OpenAI-compatible
// gateway). The override may be an API base ("https://host/v1/" or
// "https://host") — customPath is then appended — or a full endpoint URL with
// an explicit path, used verbatim. Empty/invalid values fall back to defaultUrl.
export function resolveCustomBaseUrl(defaultUrl, customPath, creds) {
  const url = getCustomBaseUrl(creds);
  if (!url) return defaultUrl;
  const parsed = new URL(url);
  const segments = parsed.pathname.split("/").filter(Boolean);
  const bare = url.replace(/\/+$/, "");
  if (segments.length === 0) return `${bare}${customPath}`;
  if (segments.length === 1 && segments[0] === "v1") return `${bare}${customPath}`;
  return url; // explicit path — use verbatim
}

// Like resolveCustomBaseUrl, but customPath is ALWAYS appended to the override
// host (an explicit path on the override is not used verbatim). Used for
// auxiliary endpoints probed against the same custom host, e.g. /models for
// key validation against a self-hosted gateway.
export function customBaseUrlEndpoint(defaultUrl, customPath, creds) {
  const url = getCustomBaseUrl(creds);
  if (!url) return defaultUrl;
  return `${url.replace(/\/+$/, "")}${customPath}`;
}
