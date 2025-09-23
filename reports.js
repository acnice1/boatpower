/* =========================================================
   reports.js — Reports (charts + fallbacks), unit-aware
   Depends on: window.Chart (optional), global unitMode, fmt(), escapeHtml()
   Exposes: window.renderReports({ labels, generationWh, consumptionWh, systemVoltage })
   ========================================================= */

(function () {
  let reportsBarChart = null;
  let reportsLineChart = null;

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

    // Unit handling relies on global unitMode
    const isAh = (typeof window.unitMode !== "undefined" ? window.unitMode : "Ah") === "Ah";
    const gen = isAh ? genWh.map((x) => x / v) : genWh.slice();
    const use = isAh ? useWh.map((x) => x / v) : useWh.slice();
    const net = gen.map((g, i) => g - use[i]);

    // Cumulative consumption series for the line chart
    const cumulativeUse = [];
    use.reduce((acc, val, i) => ((cumulativeUse[i] = acc + val), acc + val), 0);

    const hasChart = typeof window.Chart !== "undefined";
    const unitLabel = isAh ? "Ah" : "Wh";
    const yTitle = isAh ? "Amp-hours (Ah)" : "Watt-hours (Wh)";

    renderReportsBar({ labels, gen, use, net, hasChart, unitLabel, yTitle });
    renderReportsLine({ labels, cumulativeUse, hasChart, unitLabel, yTitle });
  }

  function renderReportsBar({ labels, gen, use, net, hasChart, unitLabel, yTitle }) {
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

  function renderReportsLine({ labels, cumulativeUse, hasChart, unitLabel, yTitle }) {
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

  function buildBarFallbackTable(labels, gen, use, net, unitLabel) {
    const _fmt = (window.fmt || ((x) => x));
    const _escapeHtml = (window.escapeHtml || ((s) => String(s)));
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
    const _fmt = (window.fmt || ((x) => x));
    const _escapeHtml = (window.escapeHtml || ((s) => String(s)));
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

  // Public API — preserve the same name from app calls
  window.renderReports = function ({ labels, generationWh, consumptionWh, systemVoltage }) {
    updateReportsFromModel({ labels, generationWh, consumptionWh, systemVoltage });
  };
})();
