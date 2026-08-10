import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";

const pricingKv = makeKv("pricing");
const CACHE_TTL_MS = 5000;

let cache = { value: null, expiresAt: 0 };

function invalidate() {
  cache = { value: null, expiresAt: 0 };
}

async function getUserPricing() {
  return await pricingKv.getAll();
}

export async function getPricing() {
  const now = Date.now();
  if (cache.value && cache.expiresAt > now) return cache.value;

  const userPricing = await getUserPricing();
  const { PROVIDER_PRICING } = await import("open-sse/providers/pricing.js");
  const merged = {};

  for (const [provider, models] of Object.entries(PROVIDER_PRICING)) {
    merged[provider] = { ...models };
    if (userPricing[provider]) {
      for (const [model, pricing] of Object.entries(userPricing[provider])) {
        merged[provider][model] = merged[provider][model]
          ? { ...merged[provider][model], ...pricing }
          : pricing;
      }
    }
  }

  for (const [provider, models] of Object.entries(userPricing)) {
    if (!merged[provider]) {
      merged[provider] = { ...models };
    } else {
      for (const [model, pricing] of Object.entries(models)) {
        if (!merged[provider][model]) merged[provider][model] = pricing;
      }
    }
  }

  cache = { value: merged, expiresAt: now + CACHE_TTL_MS };
  return merged;
}

// Usage history records the provider *id* ("qoder"), but pricing may be stored
// under the UI *alias* ("qd") and vice versa. Build bidirectional maps once so
// cost lookup matches whichever namespace the row and the kv store use.
let providerKeyAliases = { aliasToId: {}, idToAlias: {} };
try {
  const { default: REGISTRY } = await import("open-sse/providers/registry/index.js");
  for (const r of REGISTRY) {
    if (!r?.id) continue;
    const alias = r.alias || r.id;
    if (alias !== r.id) {
      providerKeyAliases.aliasToId[alias] = r.id;
      providerKeyAliases.idToAlias[r.id] = alias;
    }
  }
} catch {
  // Registry unavailable → alias resolution disabled, lookups fall back to exact match.
}

function userPricingFor(userPricing, provider, model) {
  if (provider && userPricing[provider]?.[model]) return userPricing[provider][model];
  if (!provider) return null;
  const alt = providerKeyAliases.aliasToId[provider] || providerKeyAliases.idToAlias[provider];
  return alt && userPricing[alt]?.[model] ? userPricing[alt][model] : null;
}

export async function getPricingForModel(provider, model) {
  if (!model) return null;
  const userPricing = await getUserPricing();
  const userMatch = userPricingFor(userPricing, provider, model);
  if (userMatch) return userMatch;
  const { getPricingForModel: resolveConst, PROVIDER_PRICING } = await import("open-sse/providers/pricing.js");
  // Try the provider key as recorded, then the alias-resolved key, so
  // PROVIDER_PRICING entries keyed by either namespace still hit.
  const resolved = resolveConst(provider, model);
  if (resolved) return resolved;
  if (provider) {
    const alt = providerKeyAliases.aliasToId[provider] || providerKeyAliases.idToAlias[provider];
    if (alt && PROVIDER_PRICING[alt]?.[model]) return PROVIDER_PRICING[alt][model];
  }
  return null;
}

// Atomic merge inside transaction (per-provider read-modify-write)
export async function updatePricing(pricingData) {
  const db = await getAdapter();
  db.transaction(() => {
    for (const [provider, models] of Object.entries(pricingData)) {
      const row = db.get(`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
      const current = row ? (parseJson(row.value, {}) || {}) : {};
      const merged = { ...current };
      for (const [model, pricing] of Object.entries(models)) {
        merged[model] = pricing;
      }
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(merged)]
      );
    }
  });
  invalidate();
  return await getUserPricing();
}

export async function resetPricing(provider, model) {
  if (!provider) return await getUserPricing();
  const db = await getAdapter();
  db.transaction(() => {
    if (!model) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
      return;
    }
    const row = db.get(`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
    const current = row ? (parseJson(row.value, {}) || {}) : {};
    delete current[model];
    if (Object.keys(current).length === 0) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
    } else {
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(current)]
      );
    }
  });
  invalidate();
  return await getUserPricing();
}

export async function resetAllPricing() {
  await pricingKv.clear();
  invalidate();
  return {};
}
