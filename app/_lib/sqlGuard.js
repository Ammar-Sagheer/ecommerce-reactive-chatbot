import { ALLOWED_TABLES } from "./schema";

export class UnsafeQueryError extends Error {}

const FORBIDDEN_KEYWORDS = [
  "insert", "update", "delete", "drop", "alter", "truncate",
  "create", "grant", "revoke", "call", "copy", "vacuum",
];

export function validateSelectOnly(sql) {
  const trimmed = sql.trim();

  if (trimmed.includes(";") && trimmed.indexOf(";") !== trimmed.length - 1) {
    throw new UnsafeQueryError("Multiple statements are not allowed.");
  }
  const withoutTrailingSemicolon = trimmed.replace(/;\s*$/, "");

  if (!/^select\b/i.test(withoutTrailingSemicolon)) {
    throw new UnsafeQueryError("Only SELECT statements are allowed.");
  }

  const lower = withoutTrailingSemicolon.toLowerCase();
  for (const word of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${word}\\b`).test(lower)) {
      throw new UnsafeQueryError(`Forbidden keyword detected: ${word}`);
    }
  }

  const referencedTables = [...lower.matchAll(/\b(?:from|join)\s+"?([a-z_]+)"?/g)].map(
    (m) => m[1]
  );
  for (const table of referencedTables) {
    if (!ALLOWED_TABLES.has(table)) {
      throw new UnsafeQueryError(`Table not allowed: ${table}`);
    }
  }

  return withoutTrailingSemicolon;
}
