import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

function rowToPool(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  return {
    ...extra,
    id: row.id,
    isActive: row.isActive === 1 || row.isActive === true,
    testStatus: row.testStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function poolToRow(p) {
  const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
  return {
    id,
    isActive: isActive === false ? 0 : 1,
    testStatus: testStatus ?? null,
    data: stringifyJson(rest),
    createdAt,
    updatedAt,
  };
}

function upsert(db, p) {
  const r = poolToRow(p);
  db.run(
    `INSERT INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       isActive=excluded.isActive, testStatus=excluded.testStatus,
       data=excluded.data, updatedAt=excluded.updatedAt`,
    [r.id, r.isActive, r.testStatus, r.data, r.createdAt, r.updatedAt]
  );
}

function buildProxyPool(data, now = new Date().toISOString()) {
  return {
    id: data.id || uuidv4(),
    name: data.name,
    proxyUrl: data.proxyUrl,
    noProxy: data.noProxy || "",
    type: data.type || "http",
    isActive: data.isActive !== undefined ? data.isActive : true,
    strictProxy: data.strictProxy === true,
    testStatus: data.testStatus || "unknown",
    lastTestedAt: data.lastTestedAt || null,
    lastError: data.lastError || null,
    createdAt: now,
    updatedAt: now,
  };
}

function buildFilterClause(filter = {}) {
  const where = [];
  const params = [];
  if (filter.isActive !== undefined) {
    where.push("isActive = ?");
    params.push(filter.isActive ? 1 : 0);
  }
  if (filter.testStatus) {
    where.push("testStatus = ?");
    params.push(filter.testStatus);
  }
  if (typeof filter.search === "string" && filter.search.trim()) {
    const escapedSearch = filter.search
      .trim()
      .toLowerCase()
      .replace(/[\\%_]/g, "\\$&");
    const pattern = `%${escapedSearch}%`;
    where.push(`(
      LOWER(COALESCE(json_extract(data, '$.name'), '')) LIKE ? ESCAPE '\\'
      OR LOWER(id) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(json_extract(data, '$.proxyUrl'), '')) LIKE ? ESCAPE '\\'
    )`);
    params.push(pattern, pattern, pattern);
  }
  return {
    sql: where.length ? ` WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

const PROXY_POOL_SORT_SQL = {
  "active-first": "isActive DESC, updatedAt DESC, id ASC",
  "valid-first": `CASE
    WHEN testStatus = 'active' THEN 0
    WHEN testStatus = 'error' THEN 2
    ELSE 1
  END ASC, isActive DESC, updatedAt DESC, id ASC`,
  "errors-first": `CASE
    WHEN testStatus = 'error' THEN 0
    WHEN testStatus = 'active' THEN 2
    ELSE 1
  END ASC, isActive DESC, updatedAt DESC, id ASC`,
  "latency-asc": `CASE WHEN testStatus = 'active' THEN 0 ELSE 1 END ASC,
    CASE WHEN json_extract(data, '$.latencyMs') IS NULL THEN 1 ELSE 0 END ASC,
    CAST(json_extract(data, '$.latencyMs') AS REAL) ASC,
    isActive DESC, updatedAt DESC, id ASC`,
  "latency-desc": `CASE WHEN testStatus = 'active' THEN 0 ELSE 1 END ASC,
    CASE WHEN json_extract(data, '$.latencyMs') IS NULL THEN 1 ELSE 0 END ASC,
    CAST(json_extract(data, '$.latencyMs') AS REAL) DESC,
    isActive DESC, updatedAt DESC, id ASC`,
  "name-asc": "LOWER(COALESCE(json_extract(data, '$.name'), '')) ASC, updatedAt DESC, id ASC",
  "name-desc": "LOWER(COALESCE(json_extract(data, '$.name'), '')) DESC, updatedAt DESC, id ASC",
  newest: "updatedAt DESC, id ASC",
};

export async function getProxyPools(filter = {}) {
  const db = await getAdapter();
  const clause = buildFilterClause(filter);
  const list = db.all(`SELECT * FROM proxyPools${clause.sql}`, clause.params).map(rowToPool);
  list.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  return list;
}

/**
 * Fetch one proxy-pool page and global counts without materializing the full
 * table in the browser. Existing unpaginated callers continue using
 * getProxyPools().
 */
export async function getProxyPoolsPage({ filter = {}, page = 1, pageSize = 100, sort = "active-first" } = {}) {
  const db = await getAdapter();
  const clause = buildFilterClause(filter);
  const normalizedPageSize = Math.max(1, Math.min(Number(pageSize) || 100, 100));
  const requestedPage = Math.max(1, Number(page) || 1);
  const orderBy = PROXY_POOL_SORT_SQL[sort] || PROXY_POOL_SORT_SQL["active-first"];

  const filteredCount = Number(
    db.get(`SELECT COUNT(*) AS count FROM proxyPools${clause.sql}`, clause.params)?.count || 0
  );
  const totals = db.get(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN isActive = 1 THEN 1 ELSE 0 END), 0) AS active
       FROM proxyPools`
  ) || { total: 0, active: 0 };
  const totalPages = Math.ceil(filteredCount / normalizedPageSize);
  const normalizedPage = totalPages > 0 ? Math.min(requestedPage, totalPages) : 1;
  const offset = (normalizedPage - 1) * normalizedPageSize;

  const proxyPools = db.all(
    `SELECT * FROM proxyPools${clause.sql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    [...clause.params, normalizedPageSize, offset]
  ).map(rowToPool);

  return {
    proxyPools,
    page: normalizedPage,
    pageSize: normalizedPageSize,
    total: Number(totals.total || 0),
    active: Number(totals.active || 0),
    filteredTotal: filteredCount,
    totalPages,
  };
}

export async function getProxyPoolsByIds(ids) {
  if (!Array.isArray(ids)) {
    throw new TypeError("Proxy pool IDs must be an array");
  }

  const normalizedIds = [...new Set(
    ids.filter((id) => typeof id === "string" && id.length > 0)
  )];
  if (normalizedIds.length === 0) return [];

  const db = await getAdapter();
  const foundById = new Map();

  // Stay below SQLite's commonly configured parameter limit on every adapter.
  for (let start = 0; start < normalizedIds.length; start += 500) {
    const chunk = normalizedIds.slice(start, start + 500);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db.all(
      `SELECT * FROM proxyPools WHERE id IN (${placeholders})`,
      chunk
    );
    for (const row of rows) {
      const pool = rowToPool(row);
      foundById.set(pool.id, pool);
    }
  }

  return normalizedIds.map((id) => foundById.get(id)).filter(Boolean);
}

export async function getProxyPoolById(id) {
  const db = await getAdapter();
  return rowToPool(db.get(`SELECT * FROM proxyPools WHERE id = ?`, [id]));
}

export async function createProxyPool(data) {
  const db = await getAdapter();
  const pool = buildProxyPool(data);
  upsert(db, pool);
  return pool;
}

/**
 * Create many proxy pools in one synchronous SQLite transaction.
 *
 * All supported adapters expose synchronous transaction callbacks, so callers
 * must prepare and validate entries before invoking this function. Returning a
 * count keeps large imports from retaining a second array of created rows.
 */
export async function bulkCreateProxyPools(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError("Proxy pool entries must be an array");
  }
  if (entries.length === 0) return 0;

  const db = await getAdapter();
  const now = new Date().toISOString();
  let created = 0;

  db.transaction(() => {
    for (const data of entries) {
      upsert(db, buildProxyPool(data, now));
      created += 1;
    }
  });

  return created;
}

export async function bulkSetProxyPoolsActive(ids, isActive) {
  if (!Array.isArray(ids)) {
    throw new TypeError("Proxy pool IDs must be an array");
  }
  if (ids.length === 0) return 0;

  const db = await getAdapter();
  const now = new Date().toISOString();
  const normalizedActive = isActive === true ? 1 : 0;
  let updated = 0;

  db.transaction(() => {
    for (const id of new Set(ids)) {
      if (typeof id !== "string" || !id) continue;
      const result = db.run(
        `UPDATE proxyPools SET isActive = ?, updatedAt = ? WHERE id = ?`,
        [normalizedActive, now, id]
      );
      updated += Number(result?.changes || 0);
    }
  });

  return updated;
}

/**
 * Persist compact health results in one transaction per server-side chunk.
 * isActive is intentionally not accepted here: testing must never disable a
 * proxy before a separate, explicit confirmation.
 */
export async function bulkUpdateProxyPoolHealth(updates) {
  if (!Array.isArray(updates)) {
    throw new TypeError("Proxy pool health updates must be an array");
  }
  if (updates.length === 0) return 0;

  const db = await getAdapter();
  let updated = 0;

  db.transaction(() => {
    for (const health of updates) {
      if (!health || typeof health.id !== "string" || !health.id) continue;
      if (
        typeof health.expectedProxyUrl !== "string"
        || typeof health.expectedUpdatedAt !== "string"
        || typeof health.lastTestedAt !== "string"
      ) continue;
      const row = db.get(`SELECT * FROM proxyPools WHERE id = ?`, [health.id]);
      if (!row) continue;

      const current = rowToPool(row);
      const incomingTestedAt = Date.parse(health.lastTestedAt);
      const currentTestedAt = Date.parse(current.lastTestedAt || "");
      if (
        current.proxyUrl !== health.expectedProxyUrl
        || current.updatedAt !== health.expectedUpdatedAt
        || !Number.isFinite(incomingTestedAt)
        || (Number.isFinite(currentTestedAt) && incomingTestedAt < currentTestedAt)
      ) continue;

      upsert(db, {
        ...current,
        testStatus: health.testStatus === "active" ? "active" : "error",
        lastTestedAt: health.lastTestedAt,
        lastError: health.lastError || null,
        latencyMs: Number.isFinite(health.latencyMs) ? health.latencyMs : null,
        updatedAt: health.lastTestedAt,
      });
      updated += 1;
    }
  });

  return updated;
}

/**
 * Disable only failures that are still the latest test for their proxy. This
 * prevents an old health job from overriding a later successful/manual test.
 */
export async function disableProxyPoolsFromHealthJob(failures) {
  if (!Array.isArray(failures)) {
    throw new TypeError("Health-job failures must be an array");
  }

  const db = await getAdapter();
  const now = new Date().toISOString();
  const summary = { disabled: 0, stale: 0, alreadyInactive: 0, missing: 0 };
  const seen = new Set();

  db.transaction(() => {
    for (const failure of failures) {
      const id = failure?.id;
      if (typeof id !== "string" || !id || seen.has(id)) continue;
      seen.add(id);

      const row = db.get(`SELECT * FROM proxyPools WHERE id = ?`, [id]);
      if (!row) {
        summary.missing += 1;
        continue;
      }

      const pool = rowToPool(row);
      if (
        pool.testStatus !== "error"
        || !failure.lastTestedAt
        || pool.lastTestedAt !== failure.lastTestedAt
        || pool.updatedAt !== failure.lastTestedAt
        || typeof failure.expectedProxyUrl !== "string"
        || pool.proxyUrl !== failure.expectedProxyUrl
      ) {
        summary.stale += 1;
        continue;
      }
      if (pool.isActive === false) {
        summary.alreadyInactive += 1;
        continue;
      }

      const result = db.run(
        `UPDATE proxyPools SET isActive = 0, updatedAt = ? WHERE id = ?`,
        [now, id]
      );
      summary.disabled += Number(result?.changes || 0);
    }
  });

  return summary;
}

export async function updateProxyPool(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM proxyPools WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToPool(row), ...data, updatedAt: new Date().toISOString() };
    upsert(db, merged);
    result = merged;
  });
  return result;
}

export async function deleteProxyPool(id) {
  const db = await getAdapter();
  let removed = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM proxyPools WHERE id = ?`, [id]);
    if (!row) return;
    removed = rowToPool(row);
    db.run(`DELETE FROM proxyPools WHERE id = ?`, [id]);
  });
  return removed;
}
