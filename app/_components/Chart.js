// Phase 8 — renders the { type, labelKey, valueKey } spec from
// app/_lib/chart.js against the same `rows` the answer was summarized from.
// Hand-rolled SVG on purpose (Ammar's call): no charting dependency for what
// is, right now, a handful of points inside a chat bubble. Follows the
// project's dataviz conventions — sequential single hue for a magnitude
// comparison (not categorical; there's only one series), rounded data-ends,
// a shared baseline, and direct value labels in their own reserved gutter so
// nothing is ever clipped — but deliberately skips the full hover/tooltip
// layer and text-measurement logic a production chart would have, since
// every value here is already a direct label, not hidden behind a hover.

const BAR_HEIGHT = 18; // spec cap is 24px; kept a little under for breathing room
const ROW_GAP = 10;
const LABEL_GUTTER = 108; // reserved width for the category label, left side
const VALUE_GUTTER = 56; // reserved width for the value label, right side
const CHART_PADDING = 8;
const MAX_LABEL_CHARS = 16;

// A date-typed column's value survives the server round-trip as a full ISO
// timestamp string (e.g. "2026-07-11T00:00:00.000Z") — Date objects
// JSON-serialize that way once they cross the API boundary. Shown raw,
// that's unreadable on a chart axis, so anything that looks like one gets
// reformatted into a short, human date first.
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}/;

function formatLabel(label) {
  if (ISO_DATE_PATTERN.test(label)) {
    const parsed = new Date(label);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }
  }
  return label;
}

function truncate(label) {
  const formatted = formatLabel(label);
  if (formatted.length <= MAX_LABEL_CHARS) return formatted;
  return `${formatted.slice(0, MAX_LABEL_CHARS - 1)}…`;
}

function formatValue(value) {
  // Good enough for this store's data (prices, counts) without pulling in a
  // number-formatting dependency: 2 decimals only when the value actually
  // has a fractional part.
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

// A rounded rect with only its *right* corners rounded, square at the
// baseline (left) — "grows from a single baseline" per the mark spec.
function roundedBarPath(x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width, height / 2));
  if (width <= 0) return "";
  return `
    M ${x} ${y}
    H ${x + width - r}
    A ${r} ${r} 0 0 1 ${x + width} ${y + r}
    V ${y + height - r}
    A ${r} ${r} 0 0 1 ${x + width - r} ${y + height}
    H ${x}
    Z
  `;
}

function BarChart({ data }) {
  const maxValue = Math.max(...data.map((d) => d.value), 0);
  const width = 320;
  const barAreaWidth = width - LABEL_GUTTER - VALUE_GUTTER - CHART_PADDING * 2;
  const rowHeight = BAR_HEIGHT + ROW_GAP;
  const height = data.length * rowHeight - ROW_GAP + CHART_PADDING * 2;
  const baselineX = CHART_PADDING + LABEL_GUTTER;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      style={{ maxWidth: width, display: "block" }}
      role="img"
      aria-label="Bar chart comparing values across items"
    >
      <line
        x1={baselineX}
        y1={CHART_PADDING}
        x2={baselineX}
        y2={height - CHART_PADDING}
        className="chart-baseline"
      />
      {data.map((d, i) => {
        const y = CHART_PADDING + i * rowHeight;
        const barWidth = maxValue > 0 ? (d.value / maxValue) * barAreaWidth : 0;
        return (
          <g key={i}>
            <title>{`${d.label}: ${formatValue(d.value)}`}</title>
            <text
              x={baselineX - 8}
              y={y + BAR_HEIGHT / 2}
              textAnchor="end"
              dominantBaseline="middle"
              className="chart-label"
            >
              {truncate(d.label)}
            </text>
            <path d={roundedBarPath(baselineX, y, barWidth, BAR_HEIGHT, 4)} className="chart-mark" />
            <text
              x={baselineX + barWidth + 8}
              y={y + BAR_HEIGHT / 2}
              dominantBaseline="middle"
              className="chart-value"
            >
              {formatValue(d.value)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function LineChart({ data }) {
  const width = 320;
  const height = 140;
  const padTop = 14;
  const padBottom = 24;
  const padSide = 12;
  const plotWidth = width - padSide * 2;
  const plotHeight = height - padTop - padBottom;

  const maxValue = Math.max(...data.map((d) => d.value));
  const minValue = Math.min(0, ...data.map((d) => d.value));
  const range = maxValue - minValue || 1;

  const points = data.map((d, i) => ({
    ...d,
    x: padSide + (data.length === 1 ? plotWidth / 2 : (i / (data.length - 1)) * plotWidth),
    y: padTop + plotHeight - ((d.value - minValue) / range) * plotHeight,
  }));

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  const last = points[points.length - 1];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      style={{ maxWidth: width, display: "block" }}
      role="img"
      aria-label="Line chart showing a trend over time"
    >
      <line
        x1={padSide}
        y1={height - padBottom}
        x2={width - padSide}
        y2={height - padBottom}
        className="chart-baseline"
      />
      <path d={linePath} fill="none" className="chart-mark chart-line" />
      {points.map((p, i) => (
        <g key={i}>
          <title>{`${p.label}: ${formatValue(p.value)}`}</title>
          <circle cx={p.x} cy={p.y} r="6" className="chart-dot-ring" />
          <circle cx={p.x} cy={p.y} r="4" className="chart-dot" />
        </g>
      ))}
      <text x={last.x} y={last.y - 10} textAnchor="middle" className="chart-value">
        {formatValue(last.value)}
      </text>
      <text x={points[0].x} y={height - 8} textAnchor="start" className="chart-label">
        {truncate(points[0].label)}
      </text>
      <text x={last.x} y={height - 8} textAnchor="end" className="chart-label">
        {truncate(last.label)}
      </text>
    </svg>
  );
}

export default function Chart({ chart, rows }) {
  if (!chart || !Array.isArray(rows)) return null;

  const data = rows
    .map((row) => ({ label: String(row[chart.labelKey] ?? ""), value: Number(row[chart.valueKey]) }))
    .filter((d) => Number.isFinite(d.value));

  if (data.length < 2) return null;

  return (
    <div className="chart-root mt-2">
      <style>{`
        .chart-root { color-scheme: light; }
        .chart-mark { fill: #2a78d6; stroke: #2a78d6; }
        .chart-line { stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
        .chart-dot { fill: #2a78d6; }
        .chart-dot-ring { fill: #fff; }
        .chart-baseline { stroke: rgba(0,0,0,0.18); stroke-width: 1; }
        .chart-label { fill: currentColor; opacity: 0.7; font-size: 10px; font-family: -apple-system, "Segoe UI", Arial, sans-serif; }
        .chart-value { fill: currentColor; font-size: 10px; font-variant-numeric: tabular-nums; font-family: -apple-system, "Segoe UI", Arial, sans-serif; }
        @media (prefers-color-scheme: dark) {
          .chart-root { color-scheme: dark; }
          .chart-mark { fill: #3987e5; stroke: #3987e5; }
          .chart-dot { fill: #3987e5; }
          .chart-dot-ring { fill: #1a1a19; }
          .chart-baseline { stroke: rgba(255,255,255,0.22); }
        }
        :root[data-theme="dark"] .chart-root { color-scheme: dark; }
        :root[data-theme="dark"] .chart-mark { fill: #3987e5; stroke: #3987e5; }
        :root[data-theme="dark"] .chart-dot { fill: #3987e5; }
        :root[data-theme="dark"] .chart-dot-ring { fill: #1a1a19; }
        :root[data-theme="dark"] .chart-baseline { stroke: rgba(255,255,255,0.22); }
        :root[data-theme="light"] .chart-root { color-scheme: light; }
        :root[data-theme="light"] .chart-mark { fill: #2a78d6; stroke: #2a78d6; }
        :root[data-theme="light"] .chart-dot { fill: #2a78d6; }
        :root[data-theme="light"] .chart-dot-ring { fill: #fff; }
        :root[data-theme="light"] .chart-baseline { stroke: rgba(0,0,0,0.18); }
      `}</style>
      {chart.type === "line" ? <LineChart data={data} /> : <BarChart data={data} />}
    </div>
  );
}
