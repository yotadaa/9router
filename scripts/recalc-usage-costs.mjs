// One-off recalculation of usageHistory.cost + usageDaily rebuild using current pricing.
// Mirrors src/lib/db/repos/usageRepo.js#recalculateUsageCosts and
// src/lib/db/repos/pricingRepo.js#getPricingForModel (alias-aware) exactly.
// Usage: node scripts/recalc-usage-costs.mjs
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const dbPath = path.join(process.env.APPDATA || "", "9router", "db", "data.sqlite");

const { getPricingForModel: builtinResolve, calculateCostFromTokens, PROVIDER_PRICING } =
  await import(pathToFileURL(path.join(repoRoot, "open-sse", "providers", "pricing.js")));

// --- Build provider id<->alias maps from registry files (same data source as production) ---
const registryDir = path.join(repoRoot, "open-sse", "providers", "registry");
const aliasToId = {}, idToAlias = {};
for (const f of fs.readdirSync(registryDir)) {
  if (!f.endsWith(".js") || f === "index.js" || f === "REGISTRY_TEMPLATE.js") continue;
  try {
    const mod = await import(pathToFileURL(path.join(registryDir, f)));
    const r = mod.default;
    if (r?.id) {
      const alias = r.alias || r.id;
      if (alias !== r.id) { aliasToId[alias] = r.id; idToAlias[r.id] = alias; }
    }
  } catch {}
}

// --- Load user pricing config (kv scope='pricing') ---
const db = new Database(dbPath);
db.pragma("busy_timeout = 5000");
const kvRows = db.prepare("SELECT key, value FROM kv WHERE scope = 'pricing'").all();
const userPricing = {};
for (const r of kvRows) { try { userPricing[r.key] = JSON.parse(r.value); } catch {} }

function userPricingFor(provider, model) {
  if (provider && userPricing[provider]?.[model]) return userPricing[provider][model];
  if (!provider) return null;
  const alt = aliasToId[provider] || idToAlias[provider];
  return alt && userPricing[alt]?.[model] ? userPricing[alt][model] : null;
}

// Production-equivalent resolution: user config (alias-aware) -> built-in chain -> PROVIDER_PRICING alias
function resolvePricing(provider, model) {
  if (!model) return null;
  const u = userPricingFor(provider, model);
  if (u) return u;
  const r = builtinResolve(provider, model);
  if (r) return r;
  if (provider) {
    const alt = aliasToId[provider] || idToAlias[provider];
    if (alt && PROVIDER_PRICING[alt]?.[model]) return PROVIDER_PRICING[alt][model];
  }
  return null;
}

// --- Daily aggregation helpers (verbatim mirror of usageRepo.js) ---
function getLocalDateKey(timestamp) {
  const d = timestamp ? new Date(timestamp) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addToCounter(target, key, values) {
  if (!target[key]) target[key] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
  target[key].requests += values.requests || 1;
  target[key].promptTokens += values.promptTokens || 0;
  target[key].completionTokens += values.completionTokens || 0;
  target[key].cachedTokens += values.cachedTokens || 0;
  target[key].cost += values.cost || 0;
  if (values.meta) Object.assign(target[key], values.meta);
}
function aggregateEntryToDay(day, entry) {
  const promptTokens = entry.tokens?.prompt_tokens || entry.tokens?.input_tokens || 0;
  const completionTokens = entry.tokens?.completion_tokens || entry.tokens?.output_tokens || 0;
  const cachedTokens = entry.tokens?.cached_tokens || entry.tokens?.cache_read_input_tokens || 0;
  const cost = entry.cost || 0;
  const vals = { promptTokens, completionTokens, cachedTokens, cost };
  day.requests = (day.requests || 0) + 1;
  day.promptTokens = (day.promptTokens || 0) + promptTokens;
  day.completionTokens = (day.completionTokens || 0) + completionTokens;
  day.cachedTokens = (day.cachedTokens || 0) + cachedTokens;
  day.cost = (day.cost || 0) + cost;
  day.byProvider ||= {}; day.byModel ||= {}; day.byAccount ||= {}; day.byApiKey ||= {}; day.byEndpoint ||= {};
  if (entry.provider) addToCounter(day.byProvider, entry.provider, vals);
  const modelKey = entry.provider ? `${entry.model}|${entry.provider}` : entry.model;
  addToCounter(day.byModel, modelKey, { ...vals, meta: { rawModel: entry.model, provider: entry.provider } });
  if (entry.connectionId) addToCounter(day.byAccount, entry.connectionId, { ...vals, meta: { rawModel: entry.model, provider: entry.provider } });
  const apiKeyVal = entry.apiKey && typeof entry.apiKey === "string" ? entry.apiKey : "local-no-key";
  addToCounter(day.byApiKey, `${apiKeyVal}|${entry.model}|${entry.provider || "unknown"}`, { ...vals, meta: { rawModel: entry.model, provider: entry.provider, apiKey: entry.apiKey || null } });
  const endpoint = entry.endpoint || "Unknown";
  addToCounter(day.byEndpoint, `${endpoint}|${entry.model}|${entry.provider || "unknown"}`, { ...vals, meta: { endpoint, rawModel: entry.model, provider: entry.provider } });
}

// --- Recalculate ---
const rows = db.prepare(
  "SELECT id, timestamp, provider, model, connectionId, apiKey, endpoint, status, tokens FROM usageHistory ORDER BY id ASC"
).all();

const updates = [];
const days = {};
let priced = 0;
for (const r of rows) {
  let tokens = {};
  try { tokens = JSON.parse(r.tokens || "{}") || {}; } catch {}
  let cost = 0;
  if (r.provider && r.model) {
    const pricing = resolvePricing(r.provider, r.model);
    if (pricing) { cost = calculateCostFromTokens(tokens, pricing); if (cost > 0) priced++; }
  }
  updates.push({ id: r.id, cost });
  const entry = { timestamp: r.timestamp, provider: r.provider, model: r.model, connectionId: r.connectionId, apiKey: r.apiKey, endpoint: r.endpoint, cost, status: r.status, tokens };
  const dateKey = getLocalDateKey(r.timestamp);
  const day = days[dateKey] || (days[dateKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, byProvider: {}, byModel: {}, byAccount: {}, byApiKey: {}, byEndpoint: {} });
  aggregateEntryToDay(day, entry);
}

const upd = db.prepare("UPDATE usageHistory SET cost = ? WHERE id = ?");
const upDay = db.prepare("INSERT INTO usageDaily(dateKey, data) VALUES(?, ?) ON CONFLICT(dateKey) DO UPDATE SET data = excluded.data");
db.transaction(() => {
  for (const { id, cost } of updates) upd.run(cost, id);
  for (const [dateKey, day] of Object.entries(days)) upDay.run(dateKey, JSON.stringify(day));
})();

const check = db.prepare("SELECT provider, model, COUNT(*) c, ROUND(SUM(cost),4) cost FROM usageHistory WHERE provider='qoder' GROUP BY provider, model").all();
console.log(`Recalculated ${rows.length} rows (${priced} with cost > 0). Rebuilt ${Object.keys(days).length} daily aggregates.`);
console.log("qoder check:", JSON.stringify(check));
db.close();
