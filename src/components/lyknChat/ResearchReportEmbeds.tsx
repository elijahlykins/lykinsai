import React, { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { tryRepairJsonText } from "@/lib/ai/researchReportFinalize";

/** Balanced neutrals — white/grey base, with beige, dark green, black accents. */
const SERIES_COLORS = [
  "#3f3f46", // zinc grey
  "#3d5a45", // dark green
  "#a89f91", // warm beige
  "#1c1c1c", // black
  "#6b7280", // cool grey
  "#4a5d4e", // forest mute
  "#c4b8a5", // sand beige
  "#52525b", // mid zinc
];
const ACCENT = SERIES_COLORS[0];

function useIsDark(): boolean {
  const [dark, setDark] = useState(() =>
    typeof document !== "undefined"
      ? document.documentElement.classList.contains("dark")
      : false,
  );
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setDark(root.classList.contains("dark"));
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

function EmbedShell({
  label,
  hint,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={
        `my-4 overflow-hidden rounded-2xl border border-black/[0.1] ` +
        `bg-gradient-to-br from-white via-[#f7f6f4] to-[#ececea] ` +
        `shadow-none ` +
        `dark:border-white/[0.1] dark:from-[#141413] dark:via-[#111110] dark:to-[#0c0c0b] ` +
        `dark:shadow-none ${className}`
      }
    >
      <div
        aria-hidden
        className="pointer-events-none h-px w-full bg-gradient-to-r from-transparent via-black/12 to-transparent dark:via-white/12"
      />
      <div className="flex items-center justify-between gap-3 border-b border-black/[0.07] px-3.5 py-2 dark:border-white/[0.08]">
        <div className="flex min-w-0 items-center gap-2">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#3d5a45] dark:bg-[#6b8f74]" />
          <span className="truncate text-[11px] font-semibold tracking-wide text-black/70 dark:text-white/75">
            {label}
          </span>
        </div>
        {hint ? (
          <span className="shrink-0 text-[10px] font-medium text-black/35 dark:text-white/35">
            {hint}
          </span>
        ) : null}
      </div>
      <div className="relative">{children}</div>
    </div>
  );
}

function EmbedFallback() {
  // Incomplete / unparseable research embeds used to dump raw fence JSON into
  // the chat. Prefer an empty placeholder over a code dump.
  return (
    <div
      className="my-3 rounded-xl border border-dashed border-black/10 px-3 py-2 text-[11px] text-black/40 dark:border-white/10 dark:text-white/35"
      role="status"
    >
      Embed couldn’t finish rendering
    </div>
  );
}

function parseStockSymbol(raw: string): string | null {
  const line = String(raw || "")
    .trim()
    .split(/\n/)[0]
    ?.trim();
  if (!line) return null;
  // NASDAQ:TSLA | TSLA | $TSLA
  const cleaned = line.replace(/^\$/, "").replace(/\s+/g, "").toUpperCase();
  if (
    !/^[A-Z]{1,6}$/.test(cleaned) &&
    !/^[A-Z0-9.]{1,12}:[A-Z0-9.=^-]{1,20}$/.test(cleaned)
  ) {
    return null;
  }
  return cleaned.slice(0, 32);
}

/** TradingView symbol-overview expects symbols: [["LABEL", "EXCHANGE:TICKER|RANGE"]]. */
function toOverviewSymbolEntry(symbol: string): [string, string] {
  const range = "12M";
  if (symbol.includes(":")) {
    const ticker = symbol.split(":").pop() || symbol;
    return [ticker, `${symbol}|${range}`];
  }
  return [symbol, `${symbol}|${range}`];
}

export function ResearchStockEmbed({ code }: { code: string }) {
  const symbol = parseStockSymbol(code);
  const isDark = useIsDark();
  const src = useMemo(() => {
    if (!symbol) return null;
    const config = {
      symbols: [toOverviewSymbolEntry(symbol)],
      chartOnly: false,
      width: "100%",
      height: 360,
      locale: "en",
      colorTheme: isDark ? "dark" : "light",
      isTransparent: true,
      autosize: true,
      showVolume: false,
      hideDateRanges: false,
      hideMarketStatus: false,
      hideSymbolLogo: false,
      scalePosition: "right",
      scaleMode: "Normal",
      valuesTracking: "1",
      changeMode: "price-and-percent",
      chartType: "area",
      lineWidth: 2,
      lineType: 0,
      dateRanges: ["1d|1", "1m|1D", "3m|60", "12m|1D", "60m|1W", "all|1M"],
      lineColor: ACCENT,
      topColor: isDark ? "rgba(63, 63, 70, 0.4)" : "rgba(63, 63, 70, 0.2)",
      bottomColor: isDark ? "rgba(63, 63, 70, 0.02)" : "rgba(247, 246, 244, 0.55)",
    };
    return `https://s.tradingview.com/embed-widget/symbol-overview/?locale=en#${encodeURIComponent(JSON.stringify(config))}`;
  }, [symbol, isDark]);

  if (!symbol || !src) return <EmbedFallback />;

  return (
    <EmbedShell label={symbol} hint="Live market">
      <iframe
        key={`${symbol}-${isDark ? "d" : "l"}`}
        title={`Stock ${symbol}`}
        src={src}
        className="block h-[360px] w-full border-0 bg-transparent"
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
      />
    </EmbedShell>
  );
}

type ChartSpec = {
  type?: string;
  title?: string;
  labels?: string[];
  data?: number[];
  datasets?: Array<{ label?: string; data: number[] }>;
};

type NormalizedChart = {
  type: "bar" | "line" | "area" | "pie" | "doughnut";
  title: string;
  rows: Array<Record<string, string | number>>;
  seriesKeys: string[];
};

function normalizeChartSpec(spec: ChartSpec): NormalizedChart | null {
  const labels = Array.isArray(spec.labels) ? spec.labels.map(String).slice(0, 24) : null;
  if (!labels?.length) return null;

  let datasets = Array.isArray(spec.datasets)
    ? spec.datasets
        .filter((d) => Array.isArray(d?.data))
        .slice(0, 4)
        .map((d, i) => ({
          label: String(d.label || `Series ${i + 1}`).slice(0, 40),
          data: d.data.map(Number).slice(0, labels.length),
        }))
    : null;

  if (!datasets?.length && Array.isArray(spec.data)) {
    datasets = [
      {
        label: String(spec.title || "Value").slice(0, 40),
        data: spec.data.map(Number).slice(0, labels.length),
      },
    ];
  }
  if (!datasets?.length) return null;

  const rawType = String(spec.type || "bar").toLowerCase();
  const type = (["bar", "line", "area", "pie", "doughnut"].includes(rawType)
    ? rawType
    : "bar") as NormalizedChart["type"];

  const seriesKeys = datasets.map((d) => d.label);
  const rows = labels.map((label, i) => {
    const row: Record<string, string | number> = { name: label };
    datasets!.forEach((d) => {
      const n = Number(d.data[i]);
      row[d.label] = Number.isFinite(n) ? n : 0;
    });
    return row;
  });

  return {
    type,
    title: String(spec.title || "").slice(0, 80),
    rows,
    seriesKeys,
  };
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; color?: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-black/10 bg-white/95 px-2.5 py-1.5 text-[11px] shadow-none backdrop-blur-sm dark:border-white/12 dark:bg-[#141413]/95">
      {label ? (
        <div className="mb-0.5 font-semibold text-black/75 dark:text-white/80">{label}</div>
      ) : null}
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-1.5 text-black/65 dark:text-white/65">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: p.color || ACCENT }}
          />
          <span>{p.name}</span>
          <span className="ml-auto font-semibold tabular-nums text-black/80 dark:text-white/85">
            {typeof p.value === "number" ? p.value.toLocaleString() : p.value}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ResearchChartEmbed({ code }: { code: string }) {
  const chart = useMemo(() => {
    const raw = String(code || "").trim();
    const repaired = tryRepairJsonText(raw) || raw;
    try {
      const parsed = JSON.parse(repaired) as ChartSpec;
      return normalizeChartSpec(parsed);
    } catch {
      return null;
    }
  }, [code]);

  const isDark = useIsDark();
  const axisColor = isDark ? "rgba(168,162,158,0.7)" : "rgba(82,82,91,0.7)";
  const gridColor = isDark ? "rgba(168,162,158,0.12)" : "rgba(28,25,23,0.08)";

  if (!chart) return <EmbedFallback />;

  const isPie = chart.type === "pie" || chart.type === "doughnut";
  const key = chart.seriesKeys[0];

  return (
    <EmbedShell label={chart.title || "Chart"} hint="From evidence">
      <div className="px-2 pb-3 pt-2 sm:px-3">
        <div className="h-[260px] w-full sm:h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            {isPie ? (
              <PieChart>
                <Pie
                  data={chart.rows}
                  dataKey={key}
                  nameKey="name"
                  innerRadius={chart.type === "doughnut" ? "52%" : 0}
                  outerRadius="78%"
                  paddingAngle={2}
                  stroke={isDark ? "#0f172a" : "#ffffff"}
                  strokeWidth={2}
                >
                  {chart.rows.map((_, i) => (
                    <Cell key={i} fill={SERIES_COLORS[i % SERIES_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip content={<ChartTooltip />} />
                <Legend
                  wrapperStyle={{ fontSize: 11, color: axisColor }}
                  iconType="circle"
                />
              </PieChart>
            ) : chart.type === "line" ? (
              <LineChart data={chart.rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={gridColor} strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="name"
                  tick={{ fill: axisColor, fontSize: 11 }}
                  axisLine={{ stroke: gridColor }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: axisColor, fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={42}
                />
                <Tooltip content={<ChartTooltip />} />
                {chart.seriesKeys.length > 1 ? (
                  <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" />
                ) : null}
                {chart.seriesKeys.map((sk, i) => (
                  <Line
                    key={sk}
                    type="monotone"
                    dataKey={sk}
                    stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                    strokeWidth={2.25}
                    dot={{ r: 3, fill: SERIES_COLORS[i % SERIES_COLORS.length], strokeWidth: 0 }}
                    activeDot={{ r: 5 }}
                  />
                ))}
              </LineChart>
            ) : chart.type === "area" ? (
              <AreaChart data={chart.rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  {chart.seriesKeys.map((sk, i) => (
                    <linearGradient key={sk} id={`lyknArea-${i}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={SERIES_COLORS[i % SERIES_COLORS.length]} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={SERIES_COLORS[i % SERIES_COLORS.length]} stopOpacity={0.02} />
                    </linearGradient>
                  ))}
                </defs>
                <CartesianGrid stroke={gridColor} strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="name"
                  tick={{ fill: axisColor, fontSize: 11 }}
                  axisLine={{ stroke: gridColor }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: axisColor, fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={42}
                />
                <Tooltip content={<ChartTooltip />} />
                {chart.seriesKeys.length > 1 ? (
                  <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" />
                ) : null}
                {chart.seriesKeys.map((sk, i) => (
                  <Area
                    key={sk}
                    type="monotone"
                    dataKey={sk}
                    stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                    strokeWidth={2}
                    fill={`url(#lyknArea-${i})`}
                  />
                ))}
              </AreaChart>
            ) : (
              <BarChart data={chart.rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={gridColor} strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="name"
                  tick={{ fill: axisColor, fontSize: 11 }}
                  axisLine={{ stroke: gridColor }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: axisColor, fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={42}
                />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(63,63,70,0.07)" }} />
                {chart.seriesKeys.length > 1 ? (
                  <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" />
                ) : null}
                {chart.seriesKeys.map((sk, i) => (
                  <Bar
                    key={sk}
                    dataKey={sk}
                    fill={SERIES_COLORS[i % SERIES_COLORS.length]}
                    radius={[6, 6, 0, 0]}
                    maxBarSize={48}
                  />
                ))}
              </BarChart>
            )}
          </ResponsiveContainer>
        </div>
      </div>
    </EmbedShell>
  );
}

type SheetSpec = {
  title?: string;
  columns?: string[];
  rows?: Array<Array<string | number | null | undefined>>;
  headers?: string[];
  data?: Array<Array<string | number | null | undefined>>;
};

function parseDelimitedSheet(raw: string): SheetSpec | null {
  const text = String(raw || "").trim();
  if (!text) return null;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 40);
  if (lines.length < 1) return null;

  const delim = lines[0].includes("\t")
    ? "\t"
    : lines[0].includes("|")
      ? "|"
      : ",";

  const split = (line: string) =>
    line
      .split(delim)
      .map((c) => c.replace(/^["']|["']$/g, "").trim())
      .slice(0, 12);

  const columns = split(lines[0]).map((c) => c || "-");
  if (!columns.length) return null;
  const rows = lines.slice(1, 25).map((l) => {
    const cells = split(l);
    while (cells.length < columns.length) cells.push("");
    return cells.slice(0, columns.length);
  });
  return { columns, rows };
}

function normalizeSheetSpec(raw: string): { title: string; columns: string[]; rows: string[][] } | null {
  const text = String(raw || "").trim();
  if (!text) return null;

  let spec: SheetSpec | null = null;
  if (text.startsWith("{")) {
    const repaired = tryRepairJsonText(text) || text;
    try {
      spec = JSON.parse(repaired) as SheetSpec;
    } catch {
      spec = null;
    }
  }
  if (!spec) spec = parseDelimitedSheet(text);
  if (!spec) return null;

  const columns = (spec.columns || spec.headers || [])
    .map((c) => String(c ?? "").slice(0, 48))
    .filter(Boolean)
    .slice(0, 12);
  const rawRows = (spec.rows || spec.data || []).slice(0, 24);
  if (!columns.length || !rawRows.length) return null;

  const rows = rawRows.map((r) => {
    const arr = Array.isArray(r) ? r : [];
    return columns.map((_, i) => {
      const v = arr[i];
      if (v == null) return "";
      return String(v).slice(0, 80);
    });
  });

  return {
    title: String(spec.title || "Data").slice(0, 80),
    columns,
    rows,
  };
}

function looksNumeric(value: string): boolean {
  if (!value) return false;
  return /^-?\$?\d[\d,]*(?:\.\d+)?%?$/.test(value.trim());
}

export function ResearchSheetEmbed({ code }: { code: string }) {
  const sheet = useMemo(() => normalizeSheetSpec(code), [code]);
  if (!sheet) return <EmbedFallback />;

  return (
    <EmbedShell label={sheet.title} hint="Mini sheet">
      <div className="overflow-x-auto">
        <table className="min-w-full border-collapse text-[12px]">
          <thead>
            <tr className="bg-black/[0.04] dark:bg-white/[0.05]">
              {sheet.columns.map((col, i) => (
                <th
                  key={i}
                  className="whitespace-nowrap border-b border-black/[0.08] px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-black/50 dark:border-white/[0.1] dark:text-white/50"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((row, ri) => (
              <tr
                key={ri}
                className={
                  ri % 2 === 0
                    ? "bg-white/60 dark:bg-white/[0.015]"
                    : "bg-[#f3eee6]/55 dark:bg-white/[0.035]"
                }
              >
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    className={
                      `border-b border-black/[0.05] px-3 py-1.5 dark:border-white/[0.06] ` +
                      (looksNumeric(cell)
                        ? "text-right font-medium tabular-nums text-[#3d5a45] dark:text-[#8fbc9a]"
                        : "text-left text-black/75 dark:text-white/75")
                    }
                  >
                    {cell || "-"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </EmbedShell>
  );
}
