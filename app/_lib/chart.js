// Phase 8 — chart auto-detection. Deterministic, rule-based inspection of a
// query's result rows, not another Gemini call: whether a set of rows is
// chart-worthy is a mechanical question about their shape (a numeric
// column? a category or date column? more than one row?), not a judgment
// call that benefits from an LLM's reasoning — and a plain function can't
// hallucinate a chart type that doesn't fit the actual data.

const MIN_ROWS_FOR_CHART = 2;

function isIdLike(key) {
  // Internal identifiers (id, category_id, ...) are never meaningful to
  // plot as a label or a value, even though category_id is numeric.
  return /(^|_)id$/i.test(key);
}

function isNumeric(value) {
  // Postgres `numeric`/`bigint` columns come back from the `pg` driver as
  // JS *strings* (e.g. "99.99"), not numbers — done deliberately to avoid
  // floating-point precision loss on money-like values. Checking
  // `typeof value === "number"` alone would silently miss every price,
  // sale_price, and COUNT(*) column.
  if (value === null || value === undefined || value === "") return false;
  return Number.isFinite(Number(value));
}

function isDateLike(value) {
  if (value === null || value === undefined || value === "") return false;
  // Reject bare numeric strings — Date.parse("2024") or even
  // Date.parse("100") can succeed, and isNumeric() should win that case.
  if (isNumeric(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

function classifyColumn(rows, key) {
  const values = rows.map((row) => row[key]).filter((v) => v !== null && v !== undefined);
  if (values.length === 0) return "unknown";
  if (values.every(isNumeric)) return "numeric";
  if (values.every(isDateLike)) return "date";
  return "text";
}

// Returns a chart spec { type: "bar" | "line", labelKey, valueKey } if
// `rows` looks worth charting, or null otherwise. The caller (the frontend)
// is left to actually draw it — this only decides *whether* and *how*.
export function detectChart(rows) {
  if (!Array.isArray(rows) || rows.length < MIN_ROWS_FOR_CHART) return null;

  const keys = Object.keys(rows[0]).filter((key) => !isIdLike(key));
  if (keys.length < 2) return null;

  const kindByKey = Object.fromEntries(keys.map((key) => [key, classifyColumn(rows, key)]));
  const numericKeys = keys.filter((key) => kindByKey[key] === "numeric");
  const dateKeys = keys.filter((key) => kindByKey[key] === "date");
  const textKeys = keys.filter((key) => kindByKey[key] === "text");

  if (numericKeys.length === 0) return null;

  if (dateKeys.length > 0) {
    return { type: "line", labelKey: dateKeys[0], valueKey: numericKeys[0] };
  }

  if (textKeys.length > 0) {
    // Prefer an obviously-named label column (name/title) over an
    // incidental one (e.g. a description field that happens to be text).
    const labelKey = textKeys.find((key) => /name|title|label/i.test(key)) || textKeys[0];
    return { type: "bar", labelKey, valueKey: numericKeys[0] };
  }

  return null;
}
