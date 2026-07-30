import { Pool } from "pg";
import { validateSelectOnly } from "./sqlGuard";

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      connectionTimeoutMillis: 10000,
    });
  }
  return pool;
}

// No SQL validation here — the caller (the graph's "validate" node) is
// responsible for that. This function only knows how to run a query.
export async function executeQuery(sql, limitRows = 20) {
  const client = await getPool().connect();
  try {
    const result = await client.query(sql);
    return result.rows.slice(0, limitRows);
  } finally {
    client.release();
  }
}

// Parameterized query helper for our own internal tables (e.g. the semantic
// cache) — never used for LLM-generated SQL, so it deliberately bypasses
// validateSelectOnly/ALLOWED_TABLES. Those guards exist to sandbox untrusted
// Gemini output, not our own hand-written statements.
export async function query(sql, params = []) {
  const client = await getPool().connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

// Convenience wrapper (validate + execute in one call) — used by anything
// that doesn't need the two steps to be separate graph nodes.
export async function runSelect(sql, limitRows = 20) {
  const safeSql = validateSelectOnly(sql);
  return executeQuery(safeSql, limitRows);
}
