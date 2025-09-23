/* =========================================================
   reports.js — Reports (charts + fallbacks), unit-aware + stacked
   Depends on: window.Chart (optional), fmt(), escapeHtml()
   Exposes: window.renderReports({
     labels,
     generationWh,
     consumptionWh,
     systemVoltage,
     // OPTIONAL breakdowns for stacked chart (per-day series)
     genBreakdown: [{ label: string, series: number[] }, ...],
     useBreakdown: [{ label: string, series: number[] }, ...],
     // OPTIONAL: threshold (0..1) for “major” contributors (default 0.10 = 10%)
     majorThreshold: 0.10
   })
   ========================================================= */

(function () {
  let reportsBarChart = null;
  let reportsLineChart = null;
  let reportsStackedChart = null;

  // -- helpers ---------------------------------------------------------------

  function getUnitMode() {
    // Prefer the DOM radios (works regardless of variable scoping),
    // fallback to window.unitMode, default to "Ah"
    const ahRadio = document.getElementById("unitAh");
    const whRadio = document.getElementById("unitWh");
    if (ahRadio && whRadio) return ahRadio.checked ? "Ah" : "Wh";
    if (typeof window.unitMode !== "undefined") return window.unitMode === "Ah" ? "Ah" : "Wh";
    return "Ah";
  }

  function clamp01(x) {
    x = +x || 0;
    if (x < 0) return 0;
    if (x > 1) return 1;
    return x;
  }

  // ---------- Public entry ----------
  window.renderReports = function ({
    labels,
    generationWh,
    consumptionWh,
    systemVoltage,
    genBreakdown,
    useBreakdown,
    majorThreshold = 0.10,
  }) {
    updateReportsFromModel({
      labels,
      generationWh,
      consumptionWh,
      systemVoltage,
      genBreakdown,
      useBreakdown,
      majorThreshold,
    });
  };

  // ---------- Update dispatcher ----------
  function updateReportsFromModel(model) {
    if (!model || !Array.isArray(model.labels)) return;

    const labels = model.labels.slice();
    const genWh = (model.generationWh || []).map((x) => +x || 0);
    const useWh = (model.consumptionWh || []).map((x) => +x || 0);
    const v = +model.systemVoltage || 12;

    // Normalize lengths
    const len = Math.max(labels.length, genWh.length, useWh.length);
    while (labels.length < len) labels.push(String(labels.length + 1));
    while (genWh.length < len) genWh.push(0);
    while (useWh.length < len) useWh.push(0);

    // Units (from DOM radios or window fallback)
    const isAh = getUnitMode() === "Ah";
    const unitLabel = isAh ? "Ah" : "Wh";
    const yTitle = isAh ? "Amp-hours (Ah)" : "Watt-hours (Wh)";

    const gen = isAh ? genWh.map((x) => x / v) : genWh.slice();
    const use = isAh ? useWh.map((x) => x / v) : useWh.slice();
    const net = gen.map((g, i) => g - use[i]);

    // Cumulative for line chart
    const cumulativeUse = [];
    use.reduce((acc, val, i) => ((cumulativeUse[i] = acc + val), acc + val), 0);

    const hasChart = typeof window.Chart !== "undefined";

    // Classic bar + line
    renderReportsBar({ labels, gen, use, net, hasChart, unitLabel, yTitle });
    renderReportsLine({ labels, cumulativeUse, hasChart, unitLabel, yTitle });

    // Optional stacked chart (only if breakdown provided)
    const hasBreakdowns =
      (model.genBreakdown && model.genBreakdown.length) ||
      (model.useBreakdown && model.useBreakdown.length);

    if (hasBreakdowns) {
      // Convert breakdown series to the current unit
      const convertSeries = (series) =>
        isAh ? series.map((x) => (+x || 0) / v) : series.map((x) => +x || 0);

      const genBD =
        (model.genBreakdown || []).map((b) => ({
          label: String(b.label || "Unnamed"),
          series: convertSeries(b.series || []),
        })) || [];

      const useBD =
        (model.useBreakdown || []).map((b) => ({
          label: String(b.label || "Unnamed"),
          series: convertSeries(b.series || []),
        })) || [];

      // Normalize series to labels length (pad/truncate)
      normalizeBreakdownLengths(genBD, len);
      normalizeBreakdownLengths(useBD, len);

      renderReportsStacked({
        labels,
        genBD,
        useBD,
        totalsGen: gen, // already unit-converted
        totalsUse: use, // already unit-converted
        hasChart,
        unitLabel,
        yTitle,
        majorThreshold: clamp01(model.majorThreshold ?? 0.1),
      });
    } else {
      // Hide/destroy stacked if present
      hideAndDestroyStacked();
    }
  }

  // ---------- Classic: Bar ----------
  function renderReportsBar({
    labels,
    gen,
    use,
    net,
    hasChart,
    unitLabel,
    yTitle,
  }) {
    const canvas = document.getElementById("reportsBar");
    const fallback = document.getElementById("reportsBarFallback");
    if (!canvas) return;

    if (hasChart) {
      fallback.style.display = "none";
      canvas.style.display = "";
      if (reportsBarChart) {
        try { reportsBarChart.destroy(); } catch {}
        reportsBarChart = null;
      }
      const negUse = use.map((v) => -v);
      reportsBarChart = new Chart(canvas.getContext("2d"), {
        type: "bar",
        data: {
          labels,
          datasets: [
            { label: `Generation (${unitLabel})`, data: gen, borderWidth: 1 },
            { label: `Consumption (${unitLabel})`, data: negUse, borderWidth: 1 },
            { label: `Net (${unitLabel})`, data: net, borderWidth: 1 },
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
      fallback.innerHTML = buildBarFallbackTable(labels, gen, use, net, unitLabel);
    }
  }

  // ---------- Classic: Line ----------
  function renderReportsLine({
    labels,
    cumulativeUse,
    hasChart,
    unitLabel,
    yTitle,
  }) {
    const canvas = document.getElementById("reportsLine");
    const fallback = document.getElementById("reportsLineFallback");
    if (!canvas) return;

    if (hasChart) {
      fallback.style.display = "none";
      canvas.style.display = "";
      if (reportsLineChart) {
        try { reportsLineChart.destroy(); } catch {}
        reportsLineChart = null;
      }
      reportsLineChart = new Chart(canvas.getContext("2d"), {
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

  // ---------- NEW: Stacked ----------
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

    // Build contributor datasets, filter small ones, group into “Other”
    const genDatasets = buildStackedDatasets({
      breakdown: genBD,
      totals: totalsGen,
      positive: true,
      majorThreshold,
    });
    const useDatasets = buildStackedDatasets({
      breakdown: useBD,
      totals: totalsUse,
      positive: false, // negative stack for consumption
      majorThreshold,
    });

    if (hasChart) {
      fallback.style.display = "none";
      canvas.style.display = "";
      if (reportsStackedChart) {
        try { reportsStackedChart.destroy(); } catch {}
        reportsStackedChart = null;
      }

      reportsStackedChart = new Chart(canvas.getContext("2d"), {
        type: "bar",
        data: {
          labels,
          datasets: [...genDatasets, ...useDatasets],
        },
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
                  const val = ctx.parsed.y;
                  const dataset = ctx.dataset || {};
                  const idx = ctx.dataIndex ?? 0;
                  const pct = (dataset.rawPct && dataset.rawPct[idx]) ? dataset.rawPct[idx] : "0.0";
                  const magnitude = typeof window.fmt === "function"
                    ? window.fmt(Math.abs(val))
                    : Math.abs(val).toFixed(2);
                  return ` ${dataset.label}: ${val < 0 ? "-" : ""}${magnitude} ${unitLabel} (${pct}%)`;
                },
              },
            },
          },
        },
      });
    } else {
      canvas.style.display = "none";
      fallback.style.display = "";
      fallback.innerHTML = buildStackedFallbackTable({
        labels,
        genDatasets,
        useDatasets,
        unitLabel,
      });
    }
  }

  // Build datasets for Chart.js stacked bar chart
 function buildStackedDatasets({
  breakdown,
  totals,
  positive,
  majorThreshold,
}) {
  // total magnitude across all days (for share)
  const totalMag = Math.max(
    1e-9,
    totals.reduce((s, v) => s + Math.abs(+v || 0), 0)
  );

  const withShare = breakdown.map((b) => {
    const mag = (b.series || []).reduce((s, v) => s + Math.abs(+v || 0), 0);
    return {
      label: b.label,
      series: b.series.slice(),
      mag,
      share: mag / totalMag,
    };
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

  // % per day relative to this side's total
  const pctPerDay = (series, totals) => {
    const L = Math.max(series.length, totals.length);
    const out = Array.from({ length: L }, () => 0);
    for (let i = 0; i < L; i++) {
      const denom = Math.max(1e-9, Math.abs(+totals[i] || 0));
      const num = Math.abs(+series[i] || 0);
      out[i] = (num / denom) * 100;
    }
    return out;
  };

  return combined.map((c) => {
    const signed = c.series.map((v) => (positive ? +v || 0 : -Math.abs(+v || 0)));
    const pct = pctPerDay(c.series, totals).map((p) => p.toFixed(1));
    return {
      label: c.label,
      data: signed,     // numeric array OK (we removed parsing:false)
      borderWidth: 1,
      rawPct: pct,      // used in tooltip
    };
  });
}


  function normalizeBreakdownLengths(bd, len) {
    bd.forEach((b) => {
      const s = Array.isArray(b.series) ? b.series.slice() : [];
      while (s.length < len) s.push(0);
      if (s.length > len) s.length = len; // truncate if longer
      b.series = s;
    });
  }

  // ---------- Fallback tables ----------
  function buildBarFallbackTable(labels, gen, use, net, unitLabel) {
    const _fmt = window.fmt || ((x) => x);
    const _escapeHtml = window.escapeHtml || ((s) => String(s));
    const rows = labels.map((l, i) => `
      <tr>
        <td>${_escapeHtml(l)}</td>
        <td style="text-align:right">${_fmt(gen[i])}</td>
        <td style="text-align:right">${_fmt(use[i])}</td>
        <td style="text-align:right">${_fmt(net[i])}</td>
      </tr>
    `).join("");
    return `
      <div class="muted" style="margin-bottom:8px">
        Chart library not found; showing data table instead.
      </div>
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
    const _escapeHtml = window.escapeHtml || ((s) => String(s));
    const rows = labels.map((l, i) => `
      <tr>
        <td>${_escapeHtml(l)}</td>
        <td style="text-align:right">${_fmt(cumulative[i])}</td>
      </tr>
    `).join("");
    return `
      <div class="muted" style="margin-bottom:8px">
        Chart library not found; showing data table instead.
      </div>
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
    const _escapeHtml = window.escapeHtml || ((s) => String(s));

    const rows = labels.map((l, idx) => {
      const genSum = genDatasets.reduce((s, d) => s + (+d.data[idx] || 0), 0);
      const useSum = useDatasets.reduce((s, d) => s + (+d.data[idx] || 0), 0);
      const pieces = [
        `<td>${_escapeHtml(l)}</td>`,
        `<td style="text-align:right">${_fmt(genSum)}</td>`,
        `<td style="text-align:right">${_fmt(useSum)}</td>`,
        `<td style="text-align:right">${_fmt(genSum + useSum)}</td>`,
      ];
      return `<tr>${pieces.join("")}</tr>`;
    }).join("");

    const legends = (title, datasets) =>
      `<div style="margin:6px 0"><b>${title}</b>: ${datasets
        .map((d) => _escapeHtml(d.label))
        .join(", ")}</div>`;

    return `
      <div class="muted" style="margin-bottom:8px">
        Chart library not found; showing stacked totals table instead.
      </div>
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

  function hideAndDestroyStacked() {
    const canvas = document.getElementById("reportsStacked");
    const fallback = document.getElementById("reportsStackedFallback");
    if (reportsStackedChart) {
      try { reportsStackedChart.destroy(); } catch {}
      reportsStackedChart = null;
    }
    if (canvas) canvas.style.display = "none";
    if (fallback) fallback.style.display = "none";
  }
})();
