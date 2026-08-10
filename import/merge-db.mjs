/**
 * One-off merge: other-device 9router data.sqlite (staged copy) → current DB.
 *
 * Merges: providerConnections (dedupe by provider+email/name, UUIDs kept),
 * usageHistory (dedupe by the app's composite key, connectionIds remapped to
 * the current device's matching connections), combos + providerNodes (dedupe),
 * kv modelAliases/customModels (current device wins on key conflicts).
 * Skips: settings, apiKeys, proxyPools, requestDetails, usageDaily (rebuilt
 * afterwards by POST /api/usage/recalculate-costs), _meta.
 *
 * Usage: node import/merge-db.mjs
 */
import Database from "better-sqlite3";

const SRC_PATH = "C:/Users/LENOVO/program/9router-rafil/import/source/data.sqlite";
const CUR_PATH = "C:/Users/LENOVO/AppData/Roaming/9router/db/data.sqlite";

const src = new Database(SRC_PATH, { readonly: true });
const cur = new Database(CUR_PATH);
cur.pragma("busy_timeout = 10000");

const summary = { connections: { inserted: 0, dupSkipped: 0 }, usage: { inserted: 0, dupSkipped: 0 }, combos: { inserted: 0, dupSkipped: 0 }, nodes: { inserted: 0, dupSkipped: 0 }, kv: { inserted: 0, dupSkipped: 0 } };

// ---------- Phase 1: connection id map ----------
const connKey = (c) => `${c.provider}|${(c.email || (c.name ? `name:${c.name}` : "")).toLowerCase()}`;
const curByKey = new Map();
for (const c of cur.prepare("SELECT id, provider, name, email FROM providerConnections").all()) {
  curByKey.set(connKey(c), c.id);
}

const idMap = new Map(); // srcConnectionId -> curConnectionId
const connsToInsert = [];
for (const c of src.prepare("SELECT * FROM providerConnections").all()) {
  const existing = curByKey.get(connKey(c));
  if (existing) {
    idMap.set(c.id, existing);
    summary.connections.dupSkipped++;
  } else {
    idMap.set(c.id, c.id); // keep the other device's UUID
    connsToInsert.push(c);
  }
}

const insConn = cur.prepare(
  `INSERT OR IGNORE INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
   VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

// ---------- Phase 2: usageHistory (dedupe + remap) ----------
const seen = new Set(
  cur.prepare(
    "SELECT timestamp, provider, model, connectionId, apiKey, promptTokens, completionTokens FROM usageHistory",
  ).all().map((r) =>
    [r.timestamp, r.provider || "", r.model || "", r.connectionId || "", r.apiKey || "", r.promptTokens, r.completionTokens].join("\u0001"),
  ),
);

const insUsage = cur.prepare(
  `INSERT OR IGNORE INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
   VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

const usageBatches = [];
let batch = [];
for (const r of src.prepare(
  "SELECT timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta FROM usageHistory ORDER BY id ASC",
).all()) {
  const remappedConn = r.connectionId ? idMap.get(r.connectionId) || r.connectionId : r.connectionId;
  const key = [r.timestamp, r.provider || "", r.model || "", remappedConn || "", r.apiKey || "", r.promptTokens, r.completionTokens].join("\u0001");
  if (seen.has(key)) { summary.usage.dupSkipped++; continue; }
  seen.add(key);
  batch.push([r.timestamp, r.provider, r.model, remappedConn, r.apiKey, r.endpoint, r.promptTokens, r.completionTokens, r.cost, r.status, r.tokens, r.meta]);
  if (batch.length >= 2000) { usageBatches.push(batch); batch = []; }
}
if (batch.length) usageBatches.push(batch);

// ---------- Phase 3: combos (dedupe by name) ----------
const curComboNames = new Set(cur.prepare("SELECT name FROM combos").all().map((r) => r.name));
const combosToInsert = [];
for (const c of src.prepare("SELECT * FROM combos").all()) {
  if (curComboNames.has(c.name)) { summary.combos.dupSkipped++; continue; }
  combosToInsert.push(c);
}
const insCombo = cur.prepare(
  `INSERT OR IGNORE INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
);

// ---------- Phase 4: providerNodes (dedupe by id) ----------
const curNodeIds = new Set(cur.prepare("SELECT id FROM providerNodes").all().map((r) => r.id));
const nodesToInsert = [];
for (const n of src.prepare("SELECT * FROM providerNodes").all()) {
  if (curNodeIds.has(n.id)) { summary.nodes.dupSkipped++; continue; }
  nodesToInsert.push(n);
}
const insNode = cur.prepare(
  `INSERT OR IGNORE INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
);

// ---------- Phase 5: kv scopes (current device wins) ----------
const MERGE_SCOPES = ["modelAliases", "customModels"];
const curKvKeys = new Set(
  cur.prepare(
    `SELECT scope || '\u0001' || key AS k FROM kv WHERE scope IN ('modelAliases','customModels')`,
  ).all().map((r) => r.k),
);
const kvToInsert = [];
for (const row of src.prepare(`SELECT scope, key, value FROM kv WHERE scope IN ('modelAliases','customModels')`).all()) {
  const k = `${row.scope}\u0001${row.key}`;
  if (curKvKeys.has(k)) { summary.kv.dupSkipped++; continue; }
  kvToInsert.push(row);
}
const insKv = cur.prepare(
  `INSERT OR IGNORE INTO kv(scope, key, value) VALUES(?, ?, ?)`,
);

// ---------- Execute in one transaction ----------
cur.transaction(() => {
  for (const c of connsToInsert) {
    const res = insConn.run(c.id, c.provider, c.authType, c.name, c.email, c.priority, c.isActive, c.data, c.createdAt, c.updatedAt);
    if (res.changes) summary.connections.inserted++;
  }
  for (const b of usageBatches) {
    for (const row of b) {
      const res = insUsage.run(...row);
      if (res.changes) summary.usage.inserted++;
    }
  }
  for (const c of combosToInsert) {
    const res = insCombo.run(c.id, c.name, c.kind, c.models, c.createdAt, c.updatedAt);
    if (res.changes) summary.combos.inserted++;
  }
  for (const n of nodesToInsert) {
    const res = insNode.run(n.id, n.type, n.name, n.data, n.createdAt, n.updatedAt);
    if (res.changes) summary.nodes.inserted++;
  }
  for (const row of kvToInsert) {
    const res = insKv.run(row.scope, row.key, row.value);
    if (res.changes) summary.kv.inserted++;
  }
})();

console.log("MERGE COMPLETE");
console.log(JSON.stringify(summary, null, 2));
console.log("usageHistory now:", cur.prepare("SELECT COUNT(*) c FROM usageHistory").get().c);
console.log("usageHistory range:", cur.prepare("SELECT MIN(timestamp) mn, MAX(timestamp) mx FROM usageHistory").get());
console.log("providerConnections now:", cur.prepare("SELECT COUNT(*) c FROM providerConnections").get().c);
console.log("combos now:", cur.prepare("SELECT COUNT(*) c FROM combos").get().c);

src.close();
cur.close();
