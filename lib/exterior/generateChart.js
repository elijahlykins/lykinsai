const CHART_TYPES = new Set(['bar', 'line', 'pie', 'doughnut', 'radar']);

const MAX_LABELS = 24;
const MAX_DATASETS = 4;
const MAX_POINTS = 24;

function clampText(s, max) {
  return String(s || '').trim().slice(0, max);
}

function sanitizeNumber(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return v;
}

/**
 * Build a QuickChart URL + Chart.js config from structured chart input.
 */
export function generateChart(input = {}) {
  const chartType = String(input.chart_type || 'bar').trim().toLowerCase();
  if (!CHART_TYPES.has(chartType)) {
    return { ok: false, error: 'invalid_chart_type', allowed: [...CHART_TYPES] };
  }

  const labels = Array.isArray(input.labels)
    ? input.labels.slice(0, MAX_LABELS).map((l) => clampText(l, 80))
    : [];
  if (labels.length === 0) {
    return { ok: false, error: 'labels array is required' };
  }

  const rawDatasets = Array.isArray(input.datasets) ? input.datasets.slice(0, MAX_DATASETS) : [];
  if (rawDatasets.length === 0) {
    return { ok: false, error: 'datasets array is required' };
  }

  const palette = [
    '#2563EB', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6',
    '#EC4899', '#0EA5E9', '#6366F1', '#14B8A6', '#F97316',
  ];

  const datasets = [];
  for (let i = 0; i < rawDatasets.length; i++) {
    const ds = rawDatasets[i] || {};
    const data = Array.isArray(ds.data)
      ? ds.data.slice(0, MAX_POINTS).map(sanitizeNumber)
      : [];
    if (data.some((v) => v == null)) {
      return { ok: false, error: 'dataset_contains_non_numeric_values', dataset_index: i };
    }
    if (data.length !== labels.length) {
      return {
        ok: false,
        error: 'dataset_length_mismatch',
        dataset_index: i,
        expected: labels.length,
        got: data.length,
      };
    }
    datasets.push({
      label: clampText(ds.label || `Series ${i + 1}`, 80),
      data,
      backgroundColor: palette[i % palette.length],
      borderColor: palette[i % palette.length],
    });
  }

  const title = clampText(input.title, 120);
  const config = {
    type: chartType,
    data: { labels, datasets },
    options: {
      plugins: {
        title: title ? { display: true, text: title } : { display: false },
        legend: { display: datasets.length > 1 || chartType === 'pie' || chartType === 'doughnut' },
      },
      responsive: true,
    },
  };

  const encoded = encodeURIComponent(JSON.stringify(config));
  // QuickChart renders to any format via &f= — png for the inline preview, plus
  // svg (vector, scales cleanly) and pdf so the user has at least one file that
  // works in any external editor / document.
  const chartUrlFor = (fmt) =>
    `https://quickchart.io/chart?c=${encoded}&w=640&h=400&bkg=white${fmt && fmt !== 'png' ? `&f=${fmt}` : ''}`;
  const chartUrl = chartUrlFor('png');
  const slug = (title || `${chartType}-chart`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'chart';
  const downloadLinks = [
    { format: 'png', url: chartUrlFor('png'), filename: `${slug}.png` },
    { format: 'svg', url: chartUrlFor('svg'), filename: `${slug}.svg` },
    { format: 'pdf', url: chartUrlFor('pdf'), filename: `${slug}.pdf` },
  ];

  const markdownTable = [
    `| Label | ${datasets.map((ds) => ds.label).join(' | ')} |`,
    `| --- | ${datasets.map(() => '---').join(' | ')} |`,
    ...labels.map((label, idx) => {
      const vals = datasets.map((ds) => ds.data[idx]).join(' | ');
      return `| ${label} | ${vals} |`;
    }),
  ].join('\n');

  return {
    ok: true,
    chart_type: chartType,
    title: title || null,
    labels,
    datasets: datasets.map(({ label, data }) => ({ label, data })),
    chart_url: chartUrl,
    download_links: downloadLinks,
    markdown_table: markdownTable,
    usage_hint: 'Include the chart_url as a markdown image in your reply: ![title](chart_url). The chart card already offers PNG/SVG/PDF downloads — do not paste the other URLs.',
  };
}
