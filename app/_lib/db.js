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

export async function runSelect(sql, limitRows = 20) {
  const safeSql = validateSelectOnly(sql);
  const client = await getPool().connect();
  try {
    const result = await client.query(safeSql);
    return result.rows.slice(0, limitRows);
  } finally {
    client.release();
  }
}
