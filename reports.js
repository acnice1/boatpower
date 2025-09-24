/* =========================================================
   reports.js — Charts (bar/line/stacked) + Gauge + SOC
   Depends on: window.Chart (optional), global window.unitMode,
               window.fmt(), window.escapeHtml()
   Public API:
     window.renderReports({
       labels,                 // ["Day 1", ...]
       generationWh,           // per-day Wh array
       consumptionWh,          // per-day Wh array
       systemVoltage,          // number (12/24/48...)
       genBreakdown?: [{label, series:number[]}], // per-day Wh
       useBreakdown?: [{label, series:number[]}], // per-day Wh
       majorThreshold?: number,   // 0..1 (stacked "Other" cutoff)
       cumulativeNetWh?: number[],// per-step cumulative in Wh (optional)
       tripWh?: number,           // loads-only trip Wh (still used for KPIs elsewhere)
       tripNetWh?: number,        // NEW: (loads - gen) * days (Wh); positive => battery supplies energy
       bankUsableWh?: number      // Usable bank energy in Wh (DoD/derate applied)
     })
   ========================================================= */

(function () {
  // Keep references if we re-render
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

    window.__reportsOpts = model; // expose current model to gauge/SOC renderers

    const labels = model.labels.slice();
    const genWh = (model.generationWh || []).map((x) => +x || 0);
    const useWh = (model.consumptionWh || []).map((x) => +x || 0);
    const v = +model.systemVoltage || 12;

    // Normalize array lengths
    const len = Math.max(labels.length, genWh.length, useWh.length);
    while (labels.length < len) labels.push(String(labels.length + 1));
    while (genWh.length < len) genWh.push(0);
    while (useWh.length < len) useWh.push(0);

    // Unit mode from toggle (default Ah)
    const isAh = (typeof window.unitMode !== "undefined" ? window.unitMode : "Ah") === "Ah";
    const unitLabel = isAh ? "Ah" : "Wh";
    const yTitle = isAh ? "Amp-hours (Ah)" : "Watt-hours (Wh)";

    // Convert to chart units
    const gen = isAh ? genWh.map((x) => x / v) : genWh.slice();
    const use = isAh ? useWh.map((x) => x / v) : useWh.slice();
    const net = gen.map((g, i) => g - use[i]);

    // Cumulative consumption (line chart)
    const cumulativeUse = [];
    use.reduce((acc, val, i) => ((cumulativeUse[i] = acc + val), acc + val), 0);

    // Optional cumulative net overlay (now as bars on same axis)
    let cumNet = null;
    if (Array.isArray(model.cumulativeNetWh)) {
      cumNet = isAh
        ? model.cumulativeNetWh.map((x) => (+x || 0) / v)
        : model.cumulativeNetWh.map((x) => +x || 0);
      while (cumNet.length < labels.length) {
        cumNet.push(cumNet.length ? cumNet[cumNet.length - 1] : 0);
      }
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

    // Gauge + SOC
    const bankWh = +model.bankUsableWh || 0;
    const bankU  = isAh ? (bankWh / v) : bankWh; // SOC expects display unit (Ah/Wh)

    // --- Gauge is AH-ONLY to avoid unit/voltage mismatches ---
    const tripNetWh = +model.tripNetWh || 0;        // if missing, assume 0
    const bankAh    = bankWh / v;
    const tripNetAh = tripNetWh / v;

    renderGaugeTripVsBank({ hasChart, bankAh, tripNetAh });
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
          yAxisID: "y",
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
    theFallback(canvas, "reportsLineFallback", hasChart, () => {
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
    });
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
      const signed = c.series.map((v) => (positive ? (+v || 0) : -Math.abs(+v || 0)));
      const percentPerDay = percentagesPerDay(c.series, totals);
      return {
        label: c.label,
        data: signed,
        borderWidth: 1,
        rawPct: percentPerDay.map((p) => (p * 100).toFixed(1)),
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

  // ---------- Gauge (Trip Net vs Usable Bank; DEGREES; AH-ONLY INPUTS) ----------
  // Expects: { hasChart, bankAh, tripNetAh }
// ---------- Gauge (Trip Net vs Usable Bank; AH-ONLY INPUTS) ----------
function renderGaugeTripVsBank({ hasChart, bankAh, tripNetAh }) {
  const canvas = document.getElementById("chartGauge");
  const fallback = document.getElementById("chartGaugeFallback");
  if (!canvas) return;

  // Degrees → radians (no direct Math.PI usage elsewhere)
  const toRad = (deg) => deg * 0.017453292519943295; // π/180

  // Gauge geometry
  const GAUGE_ROT_DEG   = 270; // start at top
  const GAUGE_SWEEP_DEG = 180; // sweep to bottom (semicircle)

  const _bankAhUsable = Math.max(0, +bankAh || 0);
  const drawAh        = Math.max(0, +tripNetAh || 0); // positive => battery supplies energy

  // Also pick up nameplate bank if provided by model (passed via renderReports)
  const model = window.__reportsOpts || {};
  const v = +model.systemVoltage || 12;
  const bankNameplateWh = +model.bankNameplateWh || 0;
  const _bankAhNameplate = bankNameplateWh > 0 ? (bankNameplateWh / v) : _bankAhUsable;

  // Remaining (clip at 0)
  const remainingUsableAh    = Math.max(0, _bankAhUsable   - drawAh);
  const remainingNameplateAh = Math.max(0, _bankAhNameplate - drawAh);

  // Fractions for the doughnut
  const remainingFrac = _bankAhUsable > 0 ? (remainingUsableAh / _bankAhUsable) : 0;
  const zoneData = [remainingFrac, 1 - remainingFrac];
  const fmt = (n) => (typeof window.fmt === "function" ? window.fmt(n) : Math.round(n));

  if (!hasChart) {
    canvas.style.display = "none";
    fallback.style.display = "";
    fallback.innerHTML = `
      <div class="muted">Gauge unavailable.</div>
      <div>Remaining (usable): <b>${fmt(remainingUsableAh)}</b> Ah
        • Remaining (nameplate margin): <b>${fmt(remainingNameplateAh)}</b> Ah
      </div>`;
    return;
  }

  canvas.style.display = "";
  fallback.style.display = "none";
  destroyIfAny(canvas);

  // Draw the needle AFTER datasets are laid out, using chartArea center & true radius
  const needlePlugin = {
    id: "gaugeNeedleAhDeg",
afterDatasetsDraw(chart) {
  const { ctx } = chart;

  // Get a representative arc (dataset 0, first slice)
  const meta0 = chart.getDatasetMeta(0);
  const arc = meta0 && meta0.data && meta0.data[0];
  if (!arc) return;

  // Center & radii from Chart.js (radians for angles)
  const cx = arc.x;
  const cy = arc.y;
  const inner = arc.innerRadius || 0;
  const outer = arc.outerRadius || Math.min(chart.width, chart.height) / 2;

  // Actual visible sweep
  let start = typeof arc.startAngle === "number" ? arc.startAngle : (-Math.PI / 2);
  let end   = typeof arc.endAngle   === "number" ? arc.endAngle   : ( Math.PI / 2);
  if (end < start) end += Math.PI * 2; // normalize
  const sweep = Math.max(1e-6, end - start);

  // remainingFrac is defined in the outer scope of renderGaugeTripVsBank
  const rf = Math.max(0, Math.min(1, remainingFrac));

  // Angle at the green/red seam
  const seam = start + rf * sweep;

  // Needle runs radially from just inside the inner edge to just shy of the outer
  const r0 = inner + Math.max(2, outer * 0.01); // 1–2px inside the inner edge
  const r1 = outer - Math.max(2, outer * 0.02); // a hair before the outer edge

  const x0 = cx + r0 * Math.cos(seam);
  const y0 = cy + r0 * Math.sin(seam);
  const x1 = cx + r1 * Math.cos(seam);
  const y1 = cy + r1 * Math.sin(seam);

  // Draw needle on top
  ctx.save();
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.strokeStyle = "#fff";
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();

  // Small hub at the inner edge
  ctx.beginPath();
  ctx.arc(x0, y0, 5, 0, Math.PI * 2);
  ctx.fillStyle = "#fff";
  ctx.fill();
  ctx.restore();

  // ---- Center labels (using outer-scope values you already compute) ----
  ctx.save();
  ctx.fillStyle = "#e6edf3";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "600 15px system-ui, -apple-system, Segoe UI, Roboto, Ubuntu";
  ctx.fillText(`${fmt(remainingUsableAh)} Ah usable`, cx, cy - 7);
  ctx.font = "500 12px system-ui, -apple-system, Segoe UI, Roboto, Ubuntu";
  ctx.fillText(`${fmt(remainingNameplateAh)} Ah of nameplate`, cx, cy + 11);
  ctx.restore();
}




  };

  new Chart(canvas.getContext("2d"), {
    type: "doughnut",
    data: {
      datasets: [{
        data: zoneData,
        borderWidth: 0,
        backgroundColor: [
          "rgba(34,197,94,0.9)", // remaining (green)
          "rgba(239,68,68,0.7)"  // used (red)
        ]
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      rotation: GAUGE_ROT_DEG,
      circumference: GAUGE_SWEEP_DEG,
      cutout: "55%",
      plugins: { legend: { display: false } }
    },
    plugins: [needlePlugin]
  });
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
    let level = bank; // start at 100% usable in display unit
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
      const rows = labels.map((l, i) => `<div>${escapeHtmlSafe(l)}: ${soc[i]}%</div>`).join("");
      fallback.innerHTML = `<div class="muted">Chart unavailable; SOC values:</div>${rows}`;
    }
  }

  // ---------- Fallback helpers ----------
  function theFallback(canvas, fallbackId, hasChart, onChart) {
    const fallback = document.getElementById(fallbackId);
    if (!canvas) return;
    if (hasChart) {
      fallback && (fallback.style.display = "none");
      canvas.style.display = "";
      onChart();
    } else {
      canvas.style.display = "none";
      fallback && (fallback.style.display = "");
    }
  }

  function buildBarFallbackTable(labels, gen, use, net, unitLabel) {
    const _fmt = window.fmt || ((x) => x);
    const _esc = escapeHtmlSafe;
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
    const _esc = escapeHtmlSafe;
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
    const _esc = escapeHtmlSafe;

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

  // ---------- Small utils ----------
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

  function escapeHtmlSafe(s) {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
    return String(s).replace(/[&<>"]/g, (c) => map[c]);
  }
})();
