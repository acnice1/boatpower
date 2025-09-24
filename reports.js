/* =========================================================
   reports.js — Charts (bar/line/stacked) + Gauge + SOC
   Depends on: window.Chart (optional), global window.unitMode,
               window.fmt(), window.escapeHtml()
   Public API:
     window.renderReports({
       labels,
       generationWh,
       consumptionWh,
       systemVoltage,
       genBreakdown?: [{label, series:number[]}],
       useBreakdown?: [{label, series:number[]}],
       majorThreshold?: number,   // 0..1
       cumulativeNetWh?: number[],// overlay line on bar
       tripWh?: number,           // for gauge
       bankUsableWh?: number      // for gauge & SOC
     })
   ========================================================= */

(function () {
  let reportsBarChart = null;
  let reportsLineChart = null;
  let reportsStackedChart = null;
  let chartGauge = null;
  let chartSoc = null;

  function destroyIfAny(canvasEl) {
    if (!canvasEl || !window.Chart) return;
    if (typeof Chart.getChart === "function") {
      const existing = Chart.getChart(canvasEl);
      if (existing) {
        try { existing.destroy(); } catch {}
      }
    }
  }

  // ---------- Public entry ----------
  window.renderReports = function (opts) {
    updateReportsFromModel(opts || {});
  };

  // ---------- Dispatcher ----------
  function updateReportsFromModel(model) {
    if (!model || !Array.isArray(model.labels)) return;

    const labels = model.labels.slice();
    const genWh = (model.generationWh || []).map((x) => +x || 0);
    const useWh = (model.consumptionWh || []).map((x) => +x || 0);
    const v = +model.systemVoltage || 12;

    // Normalize array lengths
    const len = Math.max(labels.length, genWh.length, useWh.length);
    while (labels.length < len) labels.push(String(labels.length + 1));
    while (genWh.length < len) genWh.push(0);
    while (useWh.length < len) useWh.push(0);

    const isAh = (typeof window.unitMode !== "undefined" ? window.unitMode : "Ah") === "Ah";
    const unitLabel = isAh ? "Ah" : "Wh";
    const yTitle = isAh ? "Amp-hours (Ah)" : "Watt-hours (Wh)";

    const gen = isAh ? genWh.map((x) => x / v) : genWh.slice();
    const use = isAh ? useWh.map((x) => x / v) : useWh.slice();
    const net = gen.map((g, i) => g - use[i]);

    // Cumulative consumption for line
    const cumulativeUse = [];
    use.reduce((acc, val, i) => ((cumulativeUse[i] = acc + val), acc + val), 0);

    // Optional cumulative net overlay
    let cumNet = null;
    if (Array.isArray(model.cumulativeNetWh)) {
      cumNet = isAh
        ? model.cumulativeNetWh.map((x) => (+x || 0) / v)
        : model.cumulativeNetWh.map((x) => +x || 0);
      while (cumNet.length < labels.length) cumNet.push( (cumNet[cumNet.length-1]||0) );
    }

    const hasChart = typeof window.Chart !== "undefined";

    // Classic charts
    renderReportsBar({ labels, gen, use, net, cumNet, hasChart, unitLabel, yTitle });
    renderReportsLine({ labels, cumulativeUse, hasChart, unitLabel, yTitle });

    // Stacked (optional)
    const hasBreakdowns =
      (model.genBreakdown && model.genBreakdown.length) ||
      (model.useBreakdown && model.useBreakdown.length);
    if (hasBreakdowns) {
      const convertSeries = (series) =>
        isAh ? series.map((x) => (+x || 0) / v) : series.map((x) => +x || 0);
      const genBD = (model.genBreakdown || []).map((b) => ({
        label: String(b.label || "Unnamed"),
        series: convertSeries(b.series || []),
      }));
      const useBD = (model.useBreakdown || []).map((b) => ({
        label: String(b.label || "Unnamed"),
        series: convertSeries(b.series || []),
      }));
      normalizeBreakdownLengths(genBD, len);
      normalizeBreakdownLengths(useBD, len);

      renderReportsStacked({
        labels,
        genBD,
        useBD,
        totalsGen: gen,
        totalsUse: use,
        hasChart,
        unitLabel,
        yTitle,
        majorThreshold: clamp01(model.majorThreshold ?? 0.1),
      });
    } else {
      hideStackedFallback();
    }

    // Gauge + SOC (optional, need bank)
    const trip = +model.tripWh || 0;
    const bankWh = +model.bankUsableWh || 0;

    const tripU = isAh ? trip / v : trip;
    const bankU = isAh ? bankWh / v : bankWh;

    renderGaugeTripVsBank({ hasChart, unitLabel, trip: tripU, bank: bankU });
    renderSoc({ labels, hasChart, bank: bankU, perDayNet: net });
  }

  // ---------- Bar with optional overlay ----------
  function renderReportsBar({ labels, gen, use, net, cumNet, hasChart, unitLabel, yTitle }) {
    const canvas = document.getElementById("reportsBar");
    const fallback = document.getElementById("reportsBarFallback");
    if (!canvas) return;

    if (hasChart) {
      fallback.style.display = "none";
      canvas.style.display = "";
      destroyIfAny(canvas);

      const negUse = use.map((v) => -v);
      const datasets = [
        { label: `Generation (${unitLabel})`, data: gen, borderWidth: 1, yAxisID: "y" },
        { label: `Consumption (${unitLabel})`, data: negUse, borderWidth: 1, yAxisID: "y" },
        { label: `Net (${unitLabel})`, data: net, borderWidth: 1, yAxisID: "y" },
      ];
   if (Array.isArray(cumNet)) {
  datasets.push({
    label: `Cumulative Net (${unitLabel})`,
    data: cumNet,
    borderWidth: 1,
    yAxisID: "y"
  });

      }

      new Chart(canvas.getContext("2d"), {
        type: "bar",
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: { grid: { display: false } },
            y: { beginAtZero: true, title: { display: true, text: yTitle } },
          },
          plugins: {
            legend: { position: "top" },
            tooltip: { mode: "index", intersect: false },
          },
        },
      });
    } else {
      canvas.style.display = "none";
      fallback.style.display = "";
      fallback.innerHTML = buildBarFallbackTable(labels, gen, use, net, unitLabel);
    }
  }

  // ---------- Line ----------
  function renderReportsLine({ labels, cumulativeUse, hasChart, unitLabel, yTitle }) {
    const canvas = document.getElementById("reportsLine");
    const fallback = document.getElementById("reportsLineFallback");
    if (!canvas) return;

    if (hasChart) {
      fallback.style.display = "none";
      canvas.style.display = "";
      destroyIfAny(canvas);

      new Chart(canvas.getContext("2d"), {
        type: "line",
        data: {
          labels,
          datasets: [
            {
              label: `Cumulative Consumption (${unitLabel})`,
              data: cumulativeUse,
              borderWidth: 2,
              pointRadius: 0,
              tension: 0.25,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: { grid: { display: false } },
            y: { beginAtZero: true, title: { display: true, text: yTitle } },
          },
          plugins: {
            legend: { position: "top" },
            tooltip: { mode: "index", intersect: false },
          },
        },
      });
    } else {
      canvas.style.display = "none";
      fallback.style.display = "";
      fallback.innerHTML = buildLineFallbackTable(labels, cumulativeUse, unitLabel);
    }
  }

  // ---------- Stacked ----------
  function renderReportsStacked({
    labels,
    genBD,
    useBD,
    totalsGen,
    totalsUse,
    hasChart,
    unitLabel,
    yTitle,
    majorThreshold,
  }) {
    const canvas = document.getElementById("reportsStacked");
    const fallback = document.getElementById("reportsStackedFallback");
    if (!canvas) return;

    const genDatasets = buildStackedDatasets({
      breakdown: genBD,
      totals: totalsGen,
      positive: true,
      majorThreshold,
    });
    const useDatasets = buildStackedDatasets({
      breakdown: useBD,
      totals: totalsUse,
      positive: false,
      majorThreshold,
    });

    if (hasChart) {
      fallback.style.display = "none";
      canvas.style.display = "";
      destroyIfAny(canvas);

      new Chart(canvas.getContext("2d"), {
        type: "bar",
        data: { labels, datasets: [...genDatasets, ...useDatasets] },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: { stacked: true, grid: { display: false } },
            y: { stacked: true, beginAtZero: true, title: { display: true, text: yTitle } },
          },
          plugins: {
            legend: { position: "top" },
            tooltip: {
              mode: "index",
              intersect: false,
              callbacks: {
                label(ctx) {
                  const unit = unitLabel;
                  const ds = ctx.dataset || {};
                  const rawPct = Array.isArray(ds.rawPct) ? ds.rawPct[ctx.dataIndex] : null;
                  const pct = rawPct != null ? ` (${rawPct}%)` : "";
                  const val = ctx.parsed.y;
                  const mag = typeof window.fmt === "function" ? window.fmt(Math.abs(val)) : Math.abs(val).toFixed(2);
                  return ` ${ds.label}: ${val < 0 ? "-" : ""}${mag} ${unit}${pct}`;
                },
              },
            },
          },
        },
      });
    } else {
      canvas.style.display = "none";
      fallback.style.display = "";
      fallback.innerHTML = buildStackedFallbackTable({ labels, genDatasets, useDatasets, unitLabel });
    }
  }

  function buildStackedDatasets({ breakdown, totals, positive, majorThreshold }) {
    const totalMag = Math.max(1e-9, totals.reduce((s, v) => s + Math.abs(+v || 0), 0));
    const withShare = breakdown.map((b) => {
      const mag = (b.series || []).reduce((s, v) => s + Math.abs(+v || 0), 0);
      return { label: b.label, series: b.series.slice(), mag, share: mag / totalMag };
    });
    const majors = withShare.filter((x) => x.share >= majorThreshold);
    const minors = withShare.filter((x) => x.share < majorThreshold);

    let other = null;
    if (minors.length) {
      const L = totals.length;
      const agg = Array.from({ length: L }, () => 0);
      minors.forEach((m) => {
        for (let i = 0; i < L; i++) agg[i] += +m.series[i] || 0;
      });
      const mag = agg.reduce((s, v) => s + Math.abs(+v || 0), 0);
      other = { label: "Other", series: agg, mag, share: mag / totalMag };
    }

    const combined = other ? [...majors, other] : majors;

return combined.map((c) => {
  // keep numbers; Chart.js will parse numbers fine when parsing !== false
  const signed = c.series.map((v) =>
    positive ? (+v || 0) : -Math.abs(+v || 0)
  );
  const percentPerDay = percentagesPerDay(c.series, totals);

  return {
    label: c.label,
    data: signed,            // <-- array of numbers is OK
    borderWidth: 1,
    // keep your extra payload for tooltips:
    rawPct: percentPerDay.map((p) => (p * 100).toFixed(1)),
    // DO NOT set parsing:false here
    // put gen/use on separate stacks (optional but recommended):
    stack: positive ? "gen" : "use",
  };
});
  }

  function percentagesPerDay(series, totals) {
    const L = Math.max(series.length, totals.length);
    const pct = Array.from({ length: L }, () => 0);
    for (let i = 0; i < L; i++) {
      const denom = Math.max(1e-9, Math.abs(+totals[i] || 0));
      const num = Math.abs(+series[i] || 0);
      pct[i] = num / denom;
    }
    return pct;
  }

  function normalizeBreakdownLengths(bd, len) {
    bd.forEach((b) => {
      const s = b.series || [];
      while (s.length < len) s.push(0);
      b.series = s;
    });
  }

  // ---------- Gauge ----------
 // ---------- Gauge (semicircle with needle) ----------
function renderGaugeTripVsBank({ hasChart, unitLabel, trip, bank }) {
  const canvas = document.getElementById("chartGauge");
  const fallback = document.getElementById("chartGaugeFallback");
  if (!canvas) return;

  const valid = (bank > 0) && (trip >= 0);
  if (!valid) {
    if (fallback) {
      canvas.style.display = "none";
      fallback.style.display = "";
      fallback.innerHTML = `<div class="muted">Provide a usable bank value to show this gauge.</div>`;
    }
    return;
  }

  // percent used (clamped 0..1)
  const pctUsed = Math.max(0, Math.min(1, trip / bank));
  const pctText = Math.round(pctUsed * 100);

  // Zone cutoffs (tweak to taste)
  const z1 = 0.60; // green up to 60%
  const z2 = 0.85; // yellow up to 85%, red to 100%

  // Build zone dataset as three wedge segments that always fill 100%
  // The needle shows where pctUsed lands.
  const zoneData = [
    Math.min(pctUsed, z1),                    // actual used within green
    Math.max(0, Math.min(pctUsed, z2) - z1),  // used within yellow
    Math.max(0, pctUsed - z2),                // used within red
    Math.max(0, z1 - pctUsed),                // remaining in green
    Math.max(0, z2 - Math.max(pctUsed, z1)),  // remaining in yellow
    Math.max(0, 1 - Math.max(pctUsed, z2)),   // remaining in red
  ];

  // Guard against tiny floating errors
  const sum = zoneData.reduce((a,b)=>a+b,0) || 1;
  for (let i=0;i<zoneData.length;i++) zoneData[i] = zoneData[i]/sum;

  if (hasChart) {
    fallback.style.display = "none";
    canvas.style.display = "";
    destroyIfAny(canvas);

    // Custom plugin to draw a needle & center text
    const needlePlugin = {
      id: "gaugeNeedle",
      afterDraw(chart) {
        const { ctx, chartArea, scales } = chart;
        const meta = chart.getDatasetMeta(0);
        if (!meta || !meta.data || !meta.data.length) return;

        const center = meta.data[0].getProps(["x","y"], true);
        const x = center.x;
        const y = center.y;

        // Needle angle: map [0..1] to [-PI .. 0] (left to right semicircle)
        const angle = -Math.PI + (Math.PI * pctUsed);

        // Needle length is a bit less than outer radius
        const arc = meta.data[0];
        const outerRadius = arc.outerRadius || (Math.min(chart.width, chart.height) / 2);
        const needleLen = outerRadius * 0.9;

        ctx.save();

        // Draw needle
        ctx.translate(x, y);
        ctx.rotate(angle);
        ctx.beginPath();
        ctx.moveTo(-4, 0);
        ctx.lineTo(needleLen, 0);
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#fff";
        ctx.stroke();
        ctx.closePath();

        // Needle hub
        ctx.beginPath();
        ctx.arc(0, 0, 5, 0, 2 * Math.PI);
        ctx.fillStyle = "#fff";
        ctx.fill();

        ctx.restore();

        // Center text (% + values)
        ctx.save();
        ctx.fillStyle = "#e6edf3";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = "600 16px system-ui, -apple-system, Segoe UI, Roboto, Ubuntu";
        ctx.fillText(`${pctText}% used`, x, y - 6);
        ctx.font = "500 12px system-ui, -apple-system, Segoe UI, Roboto, Ubuntu";
        const fmt = (n) => (typeof window.fmt === "function" ? window.fmt(n) : (Math.round(n*10)/10));
        ctx.fillText(`${fmt(trip)} ${unitLabel} / ${fmt(bank)} ${unitLabel}`, x, y + 12);
        ctx.restore();
      }
    };


    new Chart(canvas.getContext("2d"), {
  type: "doughnut",
  data: {
    datasets: [{
      data: zoneData,
      borderWidth: 1,
      backgroundColor: [
        "#22c55e", "#f59e0b", "#ef4444",
        "rgba(34,197,94,0.35)", "rgba(245,158,11,0.35)", "rgba(239,68,68,0.35)"
      ],
      borderColor: "rgba(31,42,68,0.6)",
    }],
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,   // let container set height
    rotation: 270,           // start at 180° (left)
    circumference: 180,       // draw 180°
    cutout: "55%",
    plugins: {
      legend: { display: false },
      // tooltip: { enabled: false }, // optional
    },
  },
  plugins: [needlePlugin],
});

  } else {
    canvas.style.display = "none";
    fallback.style.display = "";
    const _fmt = window.fmt || ((x) => x);
    fallback.innerHTML = `
      <div class="muted">Gauge unavailable (no chart lib). Summary:</div>
      <div>Trip: <b>${_fmt(trip)}</b> ${unitLabel} • Bank usable: <b>${_fmt(bank)}</b> ${unitLabel} • <b>${pctText}%</b> used</div>`;
  }
}


  // ---------- SOC ----------
  function renderSoc({ labels, hasChart, bank, perDayNet }) {
    const canvas = document.getElementById("chartSoc");
    const fallback = document.getElementById("chartSocFallback");
    if (!canvas) return;

    if (!(bank > 0) || !Array.isArray(perDayNet)) {
      if (fallback) {
        canvas.style.display = "none";
        fallback.style.display = "";
        fallback.innerHTML = `<div class="muted">SOC needs a usable bank value.</div>`;
      }
      return;
    }

    const soc = [];
    let level = bank; // start at 100% usable
    for (let i = 0; i < labels.length; i++) {
      level += perDayNet[i] || 0;
      const pct = Math.max(0, Math.min(100, (level / bank) * 100));
      soc.push(+pct.toFixed(1));
    }

    if (hasChart) {
      fallback.style.display = "none";
      canvas.style.display = "";
      destroyIfAny(canvas);

      new Chart(canvas.getContext("2d"), {
        type: "line",
        data: {
          labels,
          datasets: [{
            label: "SOC (%)",
            data: soc,
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.25,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: { grid: { display: false } },
            y: { min: 0, max: 100, title: { display: true, text: "State of Charge (%)" } },
          },
          plugins: {
            legend: { position: "top" },
            tooltip: { mode: "index", intersect: false },
          },
        },
      });
    } else {
      canvas.style.display = "none";
      fallback.style.display = "";
      const rows = labels.map((l, i) => `<div>${window.escapeHtml ? window.escapeHtml(l) : l}: ${soc[i]}%</div>`).join("");
      fallback.innerHTML = `<div class="muted">Chart unavailable; SOC values:</div>${rows}`;
    }
  }

  // ---------- Fallback tables ----------
  function buildBarFallbackTable(labels, gen, use, net, unitLabel) {
    const _fmt = window.fmt || ((x) => x);
    const _esc = window.escapeHtml || ((s) => String(s));
    const rows = labels.map((l, i) => `
      <tr>
        <td>${_esc(l)}</td>
        <td style="text-align:right">${_fmt(gen[i])}</td>
        <td style="text-align:right">${_fmt(use[i])}</td>
        <td style="text-align:right">${_fmt(net[i])}</td>
      </tr>`).join("");
    return `
      <div class="muted" style="margin-bottom:8px">Chart library not found; showing data table instead.</div>
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr>
            <th style="text-align:left;padding:6px;border-bottom:1px solid var(--line, #ccc)">Step</th>
            <th style="text-align:right;padding:6px;border-bottom:1px solid var(--line, #ccc)">Generation (${unitLabel})</th>
            <th style="text-align:right;padding:6px;border-bottom:1px solid var(--line, #ccc)">Consumption (${unitLabel})</th>
            <th style="text-align:right;padding:6px;border-bottom:1px solid var(--line, #ccc)">Net (${unitLabel})</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function buildLineFallbackTable(labels, cumulative, unitLabel) {
    const _fmt = window.fmt || ((x) => x);
    const _esc = window.escapeHtml || ((s) => String(s));
    const rows = labels.map((l, i) => `
      <tr>
        <td>${_esc(l)}</td>
        <td style="text-align:right">${_fmt(cumulative[i])}</td>
      </tr>`).join("");
    return `
      <div class="muted" style="margin-bottom:8px">Chart library not found; showing data table instead.</div>
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr>
            <th style="text-align:left;padding:6px;border-bottom:1px solid var(--line, #ccc)">Step</th>
            <th style="text-align:right;padding:6px;border-bottom:1px solid var(--line, #ccc)">Cumulative Consumption (${unitLabel})</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function buildStackedFallbackTable({ labels, genDatasets, useDatasets, unitLabel }) {
    const _fmt = window.fmt || ((x) => x);
    const _esc = window.escapeHtml || ((s) => String(s));

    const rows = labels.map((l, idx) => {
      const genSum = genDatasets.reduce((s, d) => s + (+d.data[idx] || 0), 0);
      const useSum = useDatasets.reduce((s, d) => s + (+d.data[idx] || 0), 0);
      return `<tr>
        <td>${_esc(l)}</td>
        <td style="text-align:right">${_fmt(genSum)}</td>
        <td style="text-align:right">${_fmt(useSum)}</td>
        <td style="text-align:right">${_fmt(genSum + useSum)}</td>
      </tr>`;
    }).join("");

    const legends = (title, datasets) =>
      `<div style="margin:6px 0"><b>${_esc(title)}</b>: ${datasets.map((d) => _esc(d.label)).join(", ")}</div>`;

    return `
      <div class="muted" style="margin-bottom:8px">Chart library not found; showing stacked totals table instead.</div>
      ${legends("Generation stacks", genDatasets)}
      ${legends("Consumption stacks", useDatasets)}
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr>
            <th style="text-align:left;padding:6px;border-bottom:1px solid var(--line, #ccc)">Step</th>
            <th style="text-align:right;padding:6px;border-bottom:1px solid var(--line, #ccc)">Gen total (${unitLabel})</th>
            <th style="text-align:right;padding:6px;border-bottom:1px solid var(--line, #ccc)">Use total (${unitLabel})</th>
            <th style="text-align:right;padding:6px;border-bottom:1px solid var(--line, #ccc)">Net (${unitLabel})</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function hideStackedFallback() {
    const canvas = document.getElementById("reportsStacked");
    const fallback = document.getElementById("reportsStackedFallback");
    if (canvas) canvas.style.display = "none";
    if (fallback) fallback.style.display = "none";
  }

  function clamp01(x) {
    x = +x || 0;
    if (x < 0) return 0;
    if (x > 1) return 1;
    return x;
  }
})();
