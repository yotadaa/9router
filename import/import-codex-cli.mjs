/**
 * One-off importer: Codex Desktop / Codex CLI session usage → 9router usageHistory.
 *
 * Source: rollout JSONL files under .codexx/accounts/genbi/sessions/**\/rollout-*.jsonl
 * Each `token_count` event's `last_token_usage` is ONE upstream request (delta).
 * Model per request comes from the most recent `turn_context` event in the file.
 *
 * Mapping to usageHistory:
 *   provider     = "codex-cli" (distinct from gateway "codex" traffic)
 *   model        = turn_context.model (e.g. gpt-5.6-terra)
 *   connectionId = genbi account's 9router connection (mukhtadanasution@gmail.com)
 *   endpoint     = "codex-desktop"
 *   tokens       = canonical: prompt (cache-incl), completion, cached,
 *                  cache_creation_input_tokens, reasoning_tokens
 *   meta         = { sessionId, threadSource, originator, source: "codex-cli-import" }
 *
 * Dedupe: the app's composite key (timestamp, provider, model, connectionId,
 * apiKey, promptTokens, completionTokens) — re-runs are idempotent.
 *
 * Usage: node import/import-codex-cli.mjs [--dry-run]
 */
import Database from "better-sqlite3";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

const DRY_RUN = process.argv.includes("--dry-run");
const SESSIONS_DIR = "C:/Users/LENOVO/.codexx/accounts/genbi/sessions";
const CUR_PATH = "C:/Users/LENOVO/AppData/Roaming/9router/db/data.sqlite";
const GENBI_CONNECTION_ID = "445a832b-9f7c-41f1-a2bb-7c18276748c7"; // mukhtadanasution@gmail.com
const PROVIDER = "codex-cli";
const ENDPOINT = "codex-desktop";

// ---------- collect rollout files ----------
async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(p));
    else if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

// ---------- parse one rollout file into usage rows ----------
async function parseRollout(path) {
  const rows = [];
  let model = null;
  let sessionMeta = null;
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || line[0] !== "{") continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const type = o.type;
    const p = o.payload || {};

    if (type === "session_meta") {
      sessionMeta = {
        sessionId: p.id || p.session_id || null,
        threadSource: p.thread_source || null,
        originator: p.originator || null,
      };
      if (p.model && !model) model = p.model;
      continue;
    }
    if (type === "turn_context" && p.model) {
      model = p.model;
      continue;
    }
    if (type === "event_msg" && p.type === "token_count") {
      const u = (p.info || {}).last_token_usage;
      if (!u || typeof u !== "object") continue;
      const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
      // Codex CLI: input_tokens is cache-INCLUSIVE (same convention as 9router canonical)
      const prompt = num(u.input_tokens);
      const completion = num(u.output_tokens);
      if (prompt === 0 && completion === 0) continue;
      const meta = {
        ...(sessionMeta || {}),
        model: model || null,
        effort: null,
        source: "codex-cli-import",
      };
      const tokens = {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
        cached_tokens: num(u.cached_input_tokens),
        cache_creation_input_tokens: num(u.cache_write_input_tokens),
        reasoning_tokens: num(u.reasoning_output_tokens),
      };
      rows.push({
        timestamp: o.timestamp || null,
        model: model || "",
        tokens,
        meta,
      });
    }
  }
  return rows;
}

// ---------- main ----------
const files = await walk(SESSIONS_DIR);
console.log(`Found ${files.length} rollout files`);

const allRows = [];
const modelCounts = {};
let filesWithEvents = 0;
for (const f of files) {
  const rows = await parseRollout(f);
  if (rows.length) {
    filesWithEvents++;
    for (const r of rows) modelCounts[r.model || "(none)"] = (modelCounts[r.model || "(none)"] || 0) + 1;
  }
  allRows.push(...rows);
}
allRows.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
const totalTokens = allRows.reduce((s, r) => s + r.tokens.prompt_tokens + r.tokens.completion_tokens, 0);
console.log(`Parsed ${allRows.length} token_count events from ${filesWithEvents} files`);
console.log(`Models: ${JSON.stringify(modelCounts, null, 2)}`);
console.log(`Total tokens: ${totalTokens.toLocaleString()}`);
if (allRows.length) console.log(`Range: ${allRows[0].timestamp} → ${allRows[allRows.length - 1].timestamp}`);

if (DRY_RUN) {
  console.log("\n[DRY-RUN] nothing written.");
  process.exit(0);
}

// ---------- write ----------
const cur = new Database(CUR_PATH);
cur.pragma("busy_timeout = 10000");

const seen = new Set(
  cur.prepare(
    `SELECT timestamp, COALESCE(model,'') m, promptTokens, completionTokens
     FROM usageHistory WHERE provider = ? AND connectionId = ?`,
  ).all(PROVIDER, GENBI_CONNECTION_ID)
    .map((r) => [r.timestamp, r.m, r.promptTokens, r.completionTokens].join("\u0001")),
);

const ins = cur.prepare(
  `INSERT OR IGNORE INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)
   VALUES(?, ?, ?, ?, ?, ?, ?, ?, 0, 'ok', ?, ?)`,
);

let inserted = 0, dupSkipped = 0, noTs = 0;
cur.transaction(() => {
  for (const r of allRows) {
    if (!r.timestamp) { noTs++; continue; }
    const key = [r.timestamp, r.model || "", r.tokens.prompt_tokens, r.tokens.completion_tokens].join("\u0001");
    if (seen.has(key)) { dupSkipped++; continue; }
    seen.add(key);
    const res = ins.run(
      r.timestamp, PROVIDER, r.model || null, GENBI_CONNECTION_ID, null, ENDPOINT,
      r.tokens.prompt_tokens, r.tokens.completion_tokens,
      JSON.stringify(r.tokens), JSON.stringify(r.meta),
    );
    if (res.changes) inserted++;
  }
})();

console.log(`\nIMPORT COMPLETE: inserted=${inserted} dupSkipped=${dupSkipped} missingTimestamp=${noTs}`);
console.log("usageHistory now:", cur.prepare("SELECT COUNT(*) c FROM usageHistory").get().c);
console.log("codex-cli rows:", cur.prepare("SELECT COUNT(*) c FROM usageHistory WHERE provider=?").get(PROVIDER).c);
console.log("codex-cli tokens:", cur.prepare("SELECT SUM(promptTokens+completionTokens) t FROM usageHistory WHERE provider=?").get(PROVIDER).t);
cur.close();
