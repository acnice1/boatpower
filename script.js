"use strict";

/* =========================================================
   Core app logic (UI, state, math, CSV, autosave)
   Depends on: reports.js (optional), Chart.js (optional)
   Exposes helpers used by reports.js: window.fmt, window.escapeHtml
   ========================================================= */

const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

const DEFAULTS = {
  chemistry: "LFP",
  dodByChem: { LFP: 88, AGM: 50, GEL: 55 },
  voltage: 12,
  reserve: 20,
  days: 2,
  invEff: 90,
  invStandby: 6,
  derate: 0,
  actualBankAh: 100,  
};
const CATS = [
  "Lights",
  "Nav/Comms",
  "Instruments",
  "Pumps",
  "Comfort",
  "Galley",
  "Entertainment",
  "Misc",
];

const LIB = [
  libW("Anchor Light (LED)", "Lights", 2, 8, 0, 100, 1, "DC"),
  libW("Anchor Light (Incandescent 25 W)", "Lights", 25, 8, 0, 100, 1, "DC"),
  libA("Cabin Lights (LED group avg)", "Lights", 0.6, 3, 0, 100, 1, "DC"),
  libW("Running/Nav Lights (LED set)", "Lights", 6, 0, 4, 100, 1, "DC"),
  libA("VHF (standby avg)", "Nav/Comms", 0.3, 0, 5, 100, 1, "DC"),
  libA("Chartplotter/MFD", "Instruments", 1.0, 0, 5, 100, 1, "DC"),
  libA("Depth/Wind (avg)", "Instruments", 0.4, 0, 5, 100, 1, "DC"),
  libA("Cabin Fan", "Comfort", 0.18, 12, 0, 100, 1, "DC"),
  libW("Laptop (USB-PD 35 W)", "Misc", 35, 4, 0, 100, 1, "DC"),
  libW("Laptop (AC 65 W via inverter)", "Misc", 65, 4, 0, 100, 1, "AC"),
  libW("Fridge (60 W @ 35% duty)", "Misc", 60, 24, 0, 35, 1, "DC"),
  libW("Microwave 900 W (10 min)", "Galley", 900, 0.17, 0, 100, 1, "AC"),
  libW("Coffee Maker 900 W (10 min)", "Galley", 900, 0.17, 0, 100, 1, "AC"),
  libA("Stereo (avg listening)", "Entertainment", 2.0, 6, 0, 100, 1, "DC"),
];
function libW(name, cat, watts, hA, hS, duty, qty, type) {
  return {
    name,
    category: cat,
    type: type || "DC",
    entry: "W",
    value: watts,
    hAnchor: hA,
    hSail: hS,
    duty,
    qty,
  };
}
function libA(name, cat, amps, hA, hS, duty, qty, type) {
  return {
    name,
    category: cat,
    type: type || "DC",
    entry: "A",
    value: amps,
    hAnchor: hA,
    hSail: hS,
    duty,
    qty,
  };
}

let state = {
  settings: { ...DEFAULTS },
  rows: [],
  gen: [],
  editId: null,
};
const newId = () => Math.random().toString(36).slice(2, 10);

// Unit toggle — exposed for reports.js
let unitMode = "Ah";
window.unitMode = unitMode;

// Refs
const voltage = $("#voltage"),
  chemistry = $("#chemistry"),
  dod = $("#dod"),
  reserve = $("#reserve"),
  days = $("#days"),
  invEff = $("#invEff"),
  invStandby = $("#invStandby"),
  derate = $("#derate"),
  actualBankAhEl = $("#actualBankAh");
const tbody = $("#tbody"),
  libSelect = $("#libSelect");
const tabLoads = $("#tab-loads"),
  tabGen = $("#tab-gen"),
  tabReports = $("#tab-reports"),
  tabManual = $("#tab-manual"),
  tabRange = $("#tab-range");
const paneLoads = $("#pane-loads"),
  paneGen = $("#pane-gen"),
  paneReports = $("#pane-reports"),
  paneManual = $("#pane-manual"),
  paneRange = $("#pane-range");
const genType = $("#gen-type"),
  genName = $("#gen-name"),
  genFields = $("#gen-fields"),
  genHours = $("#gen-hours"),
  genQty = $("#gen-qty"),
  genAddBtn = $("#gen-add"),
  genUpdateBtn = $("#gen-update"),
  genCancelBtn = $("#gen-cancel"),
  genEditingLabel = $("#gen-editing"),
  genBody = $("#genBody");

// Helpers exposed for reports.js fallbacks
function escapeHtml(s = "") {
  return String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}
function escapeAttr(s = "") {
  return escapeHtml(s).replace(/'/g, "&#39;");
}
function clamp(x, a, b) {
  return Math.min(b, Math.max(a, x));
}
function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}
function fmt(x) {
  if (!isFinite(x)) return "0";
  if (Math.abs(x) < 10) return x.toFixed(2);
  if (Math.abs(x) < 100) return x.toFixed(1);
  return Math.round(x).toLocaleString();
}
function toast(msg) {
  const t = document.createElement("div");
  t.textContent = msg;
  Object.assign(t.style, {
    position: "fixed",
    bottom: "16px",
    left: "50%",
    transform: "translateX(-50%)",
    padding: "8px 12px",
    background: "#0c1626",
    color: "var(--text)",
    border: "1px solid var(--line)",
    borderRadius: "10px",
    zIndex: 1000,
  });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1600);
}
// expose for reports.js fallbacks
window.fmt = fmt;
window.escapeHtml = escapeHtml;

// Init settings defaults
voltage.value = DEFAULTS.voltage;
chemistry.value = DEFAULTS.chemistry;
dod.value = DEFAULTS.dodByChem[DEFAULTS.chemistry];

let manualDodChange = false;
chemistry.addEventListener("change", () => {
  if (!manualDodChange) dod.value = DEFAULTS.dodByChem[chemistry.value] || 80;
  recalc();
});
dod.addEventListener("input", () => {
  manualDodChange = true;
  recalc();
});


[voltage, reserve, days, invEff, invStandby, derate, actualBankAhEl].forEach((el) =>
  el.addEventListener("input", recalc)
);

$$('input[name="unitMode"]').forEach((r) =>
  r.addEventListener("change", (e) => {
    unitMode = e.target.value === "Ah" ? "Ah" : "Wh";
    window.unitMode = unitMode;
    recalc();
  })
);

// Library & toolbar
function refreshLib() {
  libSelect.innerHTML = LIB.map(
    (it, i) => `<option value="${i}">${escapeHtml(it.name)} — ${it.category}</option>`
  ).join("");
}
refreshLib();
$("#addFromLib").addEventListener("click", () => {
  const i = +libSelect.value;
  if (!isNaN(i)) addRow({ ...LIB[i] });
});
$("#addRow").addEventListener("click", () => addRow());
$("#exportCsv").addEventListener("click", exportCSV);
$("#saveScenario").addEventListener("click", () => {
  localStorage.setItem("boatSizerScenario", JSON.stringify(state));
  toast("Scenario saved to this browser.");
});
$("#loadScenario").addEventListener("click", () => {
  const raw = localStorage.getItem("boatSizerScenario");
  if (!raw) return toast("No saved scenario found.");
  try {
    loadState(JSON.parse(raw));
    toast("Scenario loaded.");
  } catch (e) {
    toast("Failed to load scenario.");
  }
});
$("#resetAll").addEventListener("click", () => {
  if (confirm("Clear all rows and reset settings?")) {
    localStorage.removeItem("boatSizerAutosaveV2");
    state.rows = [];
    tbody.innerHTML = "";
    state.gen = [];
    genBody.innerHTML = "";
    seedDefaults();
    setGenType("Solar");
    genName.value = "Solar: 200 W × 2";
    $("#field-panelW").value = 200;
    $("#field-panels").value = 2;
    $("#field-sun").value = 4.5;
    $("#field-derate").value = 15;
    $("#field-ctrl").value = 96;
    genHours.value = 4.5;
    genQty.value = 1;
    onAddGen();
    voltage.value = 12;
    chemistry.value = "LFP";
    dod.value = DEFAULTS.dodByChem["LFP"];
    reserve.value = 20;
    days.value = 2;
    invEff.value = 90;
    invStandby.value = 6;
    derate.value = 0;
    unitMode = "Ah";
    window.unitMode = unitMode;
    $("#unitWh").checked = false;
    $("#unitAh").checked = true;
    recalc();
  }
});

// Tabs
function setTab(which) {
  const set = (tab, pane, active) => {
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
    pane.classList.toggle("active", active);
  };
  set(tabLoads, paneLoads, which === "loads");
  set(tabGen, paneGen, which === "gen");
  set(tabReports, paneReports, which === "reports");
  set(tabRange, paneRange, which === "range");
  set(tabManual, paneManual, which === "manual");
  if (which === "reports") recalc(); // ensure charts render when coming to reports
}
tabLoads.addEventListener("click", () => setTab("loads"));
tabGen.addEventListener("click", () => setTab("gen"));
tabReports.addEventListener("click", () => setTab("reports"));
tabRange.addEventListener("click", () => setTab("range"));
tabManual.addEventListener("click", () => setTab("manual"));

// Rows
function addRow(row) {
  const r = Object.assign(
    {
      name: "New Load",
      category: CATS[0],
      type: "DC",
      entry: "W",
      value: 1,
      hAnchor: 0,
      hSail: 0,
      duty: 100,
      qty: 1,
    },
    row || {}
  );
  state.rows.push(r);
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><input aria-label="Name" value="${escapeAttr(r.name)}"/></td>
    <td>${catSelect(r.category)}</td>
    <td>
      <select aria-label="Type">
        <option value="DC" ${r.type === "DC" ? "selected" : ""}>DC</option>
        <option value="AC" ${r.type === "AC" ? "selected" : ""}>AC via inverter</option>
      </select>
    </td>
    <td>
      <select aria-label="Entry">
        <option value="W" ${r.entry === "W" ? "selected" : ""}>Watts</option>
        <option value="A" ${r.entry === "A" ? "selected" : ""}>Amps</option>
      </select>
    </td>
    <td><input type="number" step="0.01" class="number" aria-label="Value" value="${r.value}"/></td>
    <td><input type="number" step="0.1" class="number" aria-label="Hours at Anchor" value="${r.hAnchor}"/></td>
    <td><input type="number" step="0.1" class="number" aria-label="Hours Underway" value="${r.hSail}"/></td>
    <td><input type="number" step="1" class="qty" aria-label="Duty %" value="${r.duty}"/></td>
    <td><input type="number" step="1" class="qty" aria-label="Qty" value="${r.qty}"/></td>
    <td class="center"><button title="Delete" aria-label="Delete row">✕</button></td>`;
  tbody.appendChild(tr);
  const [iName, iCat, iType, iEntry, iVal, iHA, iHS, iDuty, iQty, iDel] = [
    tr.children[0].firstElementChild,
    tr.children[1].firstElementChild,
    tr.children[2].firstElementChild,
    tr.children[3].firstElementChild,
    tr.children[4].firstElementChild,
    tr.children[5].firstElementChild,
    tr.children[6].firstElementChild,
    tr.children[7].firstElementChild,
    tr.children[8].firstElementChild,
    tr.children[9].firstElementChild,
  ];
  const sync = () => {
    r.name = iName.value;
    r.category = iCat.value;
    r.type = iType.value;
    r.entry = iEntry.value;
    r.value = num(iVal.value);
    r.hAnchor = num(iHA.value);
    r.hSail = num(iHS.value);
    r.duty = clamp(num(iDuty.value), 0, 100);
    r.qty = Math.max(0, Math.round(num(iQty.value)) || 0);
    recalc();
  };
  [iName, iCat, iType, iEntry, iVal, iHA, iHS, iDuty, iQty].forEach((el) =>
    el.addEventListener("input", sync)
  );
  iDel.addEventListener("click", () => {
    state.rows = state.rows.filter((x) => x !== r);
    tr.remove();
    recalc();
  });
  recalc();
}
function catSelect(val) {
  return `<select>${CATS.map(
    (c) => `<option ${c === val ? "selected" : ""}>${c}</option>`
  ).join("")}</select>`;
}

// Generation form & list
function setGenType(type) {
  genType.value = type;
  renderGenFields(type);
}
function renderGenFields(type) {
  if (type === "Solar") {
    genFields.innerHTML = `
      <div class="pair"><label for="field-panelW">Panel wattage (W)</label><input id="field-panelW" type="number" min="0" step="1" value="200"></div>
      <div class="pair"><label for="field-panels"># of panels</label><input id="field-panels" type="number" min="1" step="1" value="2"></div>
      <div class="pair"><label for="field-sun">Sun hours (h/day)</label><input id="field-sun" type="number" min="0" step="0.1" value="4.5"></div>
      <div class="pair"><label for="field-derate">Derate (%)</label><input id="field-derate" type="number" min="0" max="100" step="1" value="15"></div>
      <div class="pair"><label for="field-ctrl">Controller eff (%)</label><input id="field-ctrl" type="number" min="0" max="100" step="1" value="96"></div>`;
    genHours.value = 4.5;
  }
  if (type === "Wind") {
    genFields.innerHTML = `
      <div class="pair"><label for="field-rated">Rated power (W)</label><input id="field-rated" type="number" min="0" step="1" value="400"></div>
      <div class="pair"><label for="field-cf">Capacity factor (%)</label><input id="field-cf" type="number" min="0" max="100" step="1" value="20"></div>`;
    genHours.value = 24;
  }
  if (type === "Alternator") {
    genFields.innerHTML = `<div class="pair"><label for="field-amps">DC charge current (A)</label><input id="field-amps" type="number" min="0" step="0.1" value="40"></div>`;
    genHours.value = 2;
  }
  if (type === "AC Charger") {
    genFields.innerHTML = `
      <div class="pair"><label for="field-amps">DC charge current (A)</label><input id="field-amps" type="number" min="0" step="0.1" value="30"></div>
      <div class="pair"><label for="field-eff">Charging efficiency (%)</label><input id="field-eff" type="number" min="0" max="100" step="1" value="92"></div>`;
    genHours.value = 4;
  }
}
genType.addEventListener("change", () => renderGenFields(genType.value));

function readGenForm() {
  const type = genType.value;
  const base = {
    id: state.editId ?? newId(),
    type,
    name: genName.value.trim() || type,
    qty: Math.max(1, Math.round(num(genQty.value) || 1)),
    hours: Math.max(0, num(genHours.value) || 0),
  };
  if (type === "Solar")
    return {
      ...base,
      panelW: num($("#field-panelW").value),
      panels: Math.max(1, Math.round(num($("#field-panels").value) || 1)),
      sunHrs: num($("#field-sun").value),
      deratePct: clamp(num($("#field-derate").value), 0, 100),
      ctrlEffPct: clamp(num($("#field-ctrl").value), 0, 100),
    };
  if (type === "Wind")
    return {
      ...base,
      ratedW: num($("#field-rated").value),
      capacityPct: clamp(num($("#field-cf").value), 0, 100),
    };
  if (type === "Alternator")
    return { ...base, dcAmps: num($("#field-amps").value) };
  if (type === "AC Charger")
    return {
      ...base,
      dcAmps: num($("#field-amps").value),
      effPct: clamp(num($("#field-eff").value), 0, 100),
    };
  return base;
}

function onAddGen() {
  const entry = readGenForm();
  state.gen.push(entry);
  clearGenForm();
  renderGenList();
  recalc();
}
genAddBtn.addEventListener("click", onAddGen);
function onUpdateGen() {
  const entry = readGenForm();
  const idx = state.gen.findIndex((x) => x.id === entry.id);
  if (idx >= 0) {
    state.gen[idx] = entry;
  }
  clearGenForm();
  renderGenList();
  recalc();
}
genUpdateBtn.addEventListener("click", onUpdateGen);
genCancelBtn.addEventListener("click", clearGenForm);

function clearGenForm() {
  state.editId = null;
  genEditingLabel.textContent = "";
  genUpdateBtn.style.display = "none";
  genCancelBtn.style.display = "none";
  genAddBtn.style.display = "inline-block";
  genName.value = "";
  genQty.value = 1;
  setGenType(genType.value || "Solar");
}

function editGen(id) {
  const e = state.gen.find((x) => x.id === id);
  if (!e) return;
  state.editId = id;
  genAddBtn.style.display = "none";
  genUpdateBtn.style.display = "inline-block";
  genCancelBtn.style.display = "inline-block";
  genEditingLabel.textContent = `Editing: ${e.name}`;
  setGenType(e.type);
  genName.value = e.name;
  genHours.value = e.hours;
  genQty.value = e.qty;
  if (e.type === "Solar") {
    $("#field-panelW").value = e.panelW;
    $("#field-panels").value = e.panels;
    $("#field-sun").value = e.sunHrs;
    $("#field-derate").value = e.deratePct;
    $("#field-ctrl").value = e.ctrlEffPct;
  } else if (e.type === "Wind") {
    $("#field-rated").value = e.ratedW;
    $("#field-cf").value = e.capacityPct;
  } else if (e.type === "Alternator") {
    $("#field-amps").value = e.dcAmps;
  } else if (e.type === "AC Charger") {
    $("#field-amps").value = e.dcAmps;
    $("#field-eff").value = e.effPct;
  }
}
function delGen(id) {
  state.gen = state.gen.filter((x) => x.id !== id);
  renderGenList();
  recalc();
}

function detailsText(e) {
  if (e.type === "Solar")
    return `${e.panelW}W × ${e.panels}, ${e.sunHrs}h, −${e.deratePct}% derate, ${e.ctrlEffPct}% ctrl`;
  if (e.type === "Wind") return `${e.ratedW}W @ ${e.capacityPct}% × ${e.hours}h`;
  if (e.type === "Alternator") return `${e.dcAmps}A × ${e.hours}h`;
  if (e.type === "AC Charger") return `${e.dcAmps}A × ${e.hours}h @ ${e.effPct}%`;
  return "";
}

function renderGenList() {
  const v = state.settings.voltage || DEFAULTS.voltage;
  genBody.innerHTML = "";
  for (const e of state.gen) {
    const wh = genEntryWh(e, v),
      ah = wh / v;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(e.name)}</td>
      <td><span class="badge">${e.type}</span></td>
      <td>${escapeHtml(detailsText(e))}</td>
      <td class="center">${e.qty}</td>
      <td class="center">${fmt(wh)}</td>
      <td class="center">${fmt(ah)}</td>
      <td class="actions center"><span class="link" data-act="edit">Edit</span> &nbsp;|&nbsp; <span class="link danger" data-act="del">Delete</span></td>`;
    tr.addEventListener("click", (ev) => {
      const act = ev.target?.dataset?.act;
      if (act === "edit") editGen(e.id);
      if (act === "del") delGen(e.id);
    });
    genBody.appendChild(tr);
  }
}

function genEntryWh(e, v) {
  const qty = e.qty || 1;
  if (e.type === "Solar") {
    const { panelW = 0, panels = 0, sunHrs = 0, deratePct = 0, ctrlEffPct = 100 } = e;
    return qty * (panelW * panels * sunHrs * (1 - deratePct / 100) * (ctrlEffPct / 100));
  }
  if (e.type === "Wind") {
    const { ratedW = 0, capacityPct = 0, hours = 0 } = e;
    return qty * (ratedW * (capacityPct / 100) * hours);
  }
  if (e.type === "Alternator") {
    const { dcAmps = 0, hours = 0 } = e;
    return qty * (dcAmps * v * hours);
  }
  if (e.type === "AC Charger") {
    const { dcAmps = 0, hours = 0, effPct = 100 } = e;
    return qty * (dcAmps * v * hours * (effPct / 100));
  }
  return 0;
}

// KPI helpers
function setKpiPair(whId, ahId, whVal, ahVal) {
  const whEl = $("#" + whId)?.closest(".kpi");
  const ahEl = $("#" + ahId)?.closest(".kpi");
  if (!whEl || !ahEl) return;
  if (unitMode === "Wh") {
    $("#" + whId).textContent = `${fmt(whVal)} Wh/day`;
    whEl.classList.remove("hidden");
    ahEl.classList.add("hidden");
  } else {
    $("#" + ahId).textContent = `${fmt(ahVal)} Ah/day`;
    ahEl.classList.remove("hidden");
    whEl.classList.add("hidden");
  }
}

// Core math & render
function recalc() {
  state.settings = {
    voltage: +voltage.value,
    chemistry: chemistry.value,
    dod: clamp(num(dod.value), 10, 99),
    reserve: clamp(num(reserve.value), 0, 100),
    days: Math.max(1, Math.round(num(days.value) || 1)),
    invEff: clamp(num(invEff.value), 50, 100),
    invStandby: Math.max(0, num(invStandby.value) || 0),
    derate: clamp(num(derate.value), 0, 80),
    actualBankAh: Math.max(0, num(actualBankAhEl.value) || DEFAULTS.actualBankAh), // <-- NEW
  };
  $("#vLabel").textContent = state.settings.voltage;
  $("#vLabel2").textContent = state.settings.voltage;

  let anchorWh = 0,
    sailWh = 0,
    acAnchorHours = 0,
    acSailHours = 0;

  for (const r of state.rows) {
    const duty = (r.duty || 0) / 100,
      qty = r.qty || 0;
    const whA = rowWh(r, r.hAnchor, duty, qty),
      whS = rowWh(r, r.hSail, duty, qty);
    if (r.type === "AC") {
      acAnchorHours = Math.max(acAnchorHours, r.hAnchor || 0);
      acSailHours = Math.max(acSailHours, r.hSail || 0);
    }
    anchorWh += whA;
    sailWh += whS;
  }

  const standbyWhDay = state.settings.invStandby * (acAnchorHours + acSailHours);
  const whDayTotal = anchorWh + sailWh + standbyWhDay;
  const ahDayTotal = whDayTotal / state.settings.voltage;

  // Generation per day
  let genWhDay = 0;
  for (const e of state.gen) genWhDay += genEntryWh(e, state.settings.voltage);
  const genAhDay = genWhDay / state.settings.voltage;

  const netWh = genWhDay - whDayTotal;
  const netAh = genAhDay - ahDayTotal;

  const tripWh = whDayTotal * state.settings.days;
  const tripAh = ahDayTotal * state.settings.days;

  const usableDoD = state.settings.dod / 100;
  const withReserveAh = tripAh * (1 + state.settings.reserve / 100);
  let nameplateAh = withReserveAh / usableDoD;
  if (state.settings.derate > 0) {
    nameplateAh = nameplateAh / (1 - state.settings.derate / 100);
  }
  const withReserveWh = withReserveAh * state.settings.voltage;
  const nameplateWh = nameplateAh * state.settings.voltage;
  const modules100 = Math.max(1, Math.ceil(nameplateAh / 100));
  const layout = `${modules100} × 100 Ah @ ${state.settings.voltage} V`;

  const netWhEl = $("#netWhDay")?.closest(".kpi");
  const netAhEl = $("#netAhDay")?.closest(".kpi");
  [netWhEl, netAhEl].forEach((el) => el && el.classList.remove("ok", "warn", "bad"));
  const netMetric = unitMode === "Wh" ? netWh : netAh;
  const threshold = unitMode === "Wh" ? 200 : 200 / state.settings.voltage;
  const targetEl = unitMode === "Wh" ? netWhEl : netAhEl;
  if (targetEl) {
    if (netMetric > 0) targetEl.classList.add("ok");
    else if (Math.abs(netMetric) < threshold) targetEl.classList.add("warn");
    else targetEl.classList.add("bad");
  }

  setKpiPair("whDay", "ahDay", whDayTotal, ahDayTotal);
  setKpiPair("genWhDay", "genAhDay", genWhDay, genAhDay);
  setKpiPair("netWhDay", "netAhDay", netWh, netAh);

  $("#tripWhAh").textContent =
    unitMode === "Wh" ? `${fmt(tripWh)} Wh` : `${fmt(tripAh)} Ah`;
  $("#bankAh").textContent =
    unitMode === "Wh"
      ? `${fmt(withReserveWh)} Wh / ${fmt(nameplateWh)} Wh`
      : `${fmt(withReserveAh)} Ah / ${fmt(nameplateAh)} Ah`;
  $("#anchorWhAh").textContent =
    unitMode === "Wh"
      ? `${fmt(anchorWh)} Wh/day`
      : `${fmt(anchorWh / state.settings.voltage)} Ah/day`;
  $("#sailWhAh").textContent =
    unitMode === "Wh"
      ? `${fmt(sailWh)} Wh/day`
      : `${fmt(sailWh / state.settings.voltage)} Ah/day`;
  $("#invStandbyWh").textContent =
    unitMode === "Wh"
      ? `${fmt(standbyWhDay)} Wh/day`
      : `${fmt(standbyWhDay / state.settings.voltage)} Ah/day`;
  $("#suggestLayout").textContent = layout;

  // Autosave
  const autosave = {
    settings: state.settings,
    rows: state.rows,
    gen: state.gen,
  };
  localStorage.setItem("boatSizerAutosaveV2", JSON.stringify(autosave));

  renderGenList();

  // Build reports data (per-day bars stay constant; overlay cumulative net line)
  const d = state.settings.days;
  const labels = Array.from({ length: d }, (_, i) => `Day ${i + 1}`);
  const generationWh = Array.from({ length: d }, () => genWhDay);
  const consumptionWh = Array.from({ length: d }, () => whDayTotal);
  const cumulativeNetWh = labels.map((_, i) => (genWhDay - whDayTotal) * (i + 1));

  // (Optional) stacked breakdowns
  const genBreakdown = buildGenBreakdownSeries(d, state.settings.voltage);
  const useBreakdown = buildUseBreakdownSeries(d);

  // Derived usable bank energy for gauge/SOC (based on suggested nameplate)
 // Derived usable bank energy for gauge/SOC (based on ACTUAL bank input)
// Derived usable bank energy for gauge/SOC (based on ACTUAL bank input)
const V = state.settings.voltage;
const der = state.settings.derate / 100;
const actualUsableBankWh =
  state.settings.actualBankAh * V * usableDoD * (1 - der);

// Render only on Reports tab
if (tabReports.classList.contains("active") && typeof window.renderReports === "function") {
  window.unitMode = unitMode; // ensure reports sees the current toggle
  window.renderReports({
    labels,
    generationWh,
    consumptionWh,
    systemVoltage: V,
    genBreakdown,
    useBreakdown,
    majorThreshold: 0.10,

    // New analytics
    cumulativeNetWh,
    tripWh,
    bankUsableWh: actualUsableBankWh,   // <-- now driven by user input
  });
}
}



function rowWh(r, hours, duty, qty) {
  const v = state.settings.voltage,
    eff = state.settings.invEff / 100;
  const h = Math.max(0, hours || 0) * Math.max(0, duty || 0) * (qty || 0);
  if (h <= 0) return 0;
  if (r.type === "AC") {
    if (r.entry === "W") return ((r.value || 0) * h) / eff;
    return ((r.value || 0) * 120 * h) / eff;
  } else {
    if (r.entry === "W") return (r.value || 0) * h;
    return (r.value || 0) * v * h;
  }
}

function exportCSV() {
  const headers = [
    "Name",
    "Category",
    "Type",
    "Entry",
    "Value",
    "Hours_Anchor",
    "Hours_Underway",
    "Duty_%",
    "Qty",
  ];
  const rows = state.rows.map((r) => [
    r.name,
    r.category,
    r.type,
    r.entry,
    r.value,
    r.hAnchor,
    r.hSail,
    r.duty,
    r.qty,
  ]);
  const netText = unitMode === "Wh" ? $("#netWhDay").textContent : $("#netAhDay").textContent;
  const totals = [
    [],
    ["Summary", "", "", "", ""],
    ["Loads", "", "", "", unitMode === "Wh" ? $("#whDay").textContent : $("#ahDay").textContent],
    ["Gen", "", "", "", unitMode === "Wh" ? $("#genWhDay").textContent : $("#genAhDay").textContent],
    ["Net", "", "", "", netText],
    ["Trip (loads only)", "", "", "", $("#tripWhAh").textContent],
    ["Usable (bank)", "", "", "", $("#bankAh").textContent.split("/")[0].trim()],
    ["Nameplate (bank)", "", "", "", $("#bankAh").textContent.split("/")[1].trim()],
  ];
  const csv = [headers, ...rows, ...totals]
    .map((r) =>
      r
        .map((v) => String(v ?? "").replace(/"/g, '""'))
        .map((v) => `"${v}"`)
        .join(",")
    )
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "boat-battery-loads.csv";
  a.click();
  URL.revokeObjectURL(url);
}

// Defaults
function seedDefaults() {
  const wanted = [
    "Anchor Light (LED)",
    "Running/Nav Lights (LED set)",
    "Chartplotter/MFD",
    "Depth/Wind (avg)",
    "Cabin Fan",
    "Stereo (avg listening)",
    "Laptop (USB-PD 35 W)",
  ];
  const existing = new Set(state.rows.map((r) => r.name));
  for (const n of wanted) {
    if (!existing.has(n)) {
      const it = LIB.find((x) => x.name === n);
      if (it) addRow({ ...it });
    }
  }
}

(function init() {
  setGenType("Solar");
  const raw = localStorage.getItem("boatSizerAutosaveV2");
  if (raw) {
    try {
      loadState(JSON.parse(raw));
      recalc();
      return;
    } catch (e) {
      console.warn("autosave v2 parse failed", e);
    }
  }
  seedDefaults();
  genName.value = "Solar: 200 W × 2";
  $("#field-panelW").value = 200;
  $("#field-panels").value = 2;
  $("#field-sun").value = 4.5;
  $("#field-derate").value = 15;
  $("#field-ctrl").value = 96;
  genHours.value = 4.5;
  onAddGen();
  recalc();
})();

function loadState(data) {
  try {
    voltage.value = data.settings.voltage ?? 12;
    chemistry.value = data.settings.chemistry ?? "LFP";
    dod.value = data.settings.dod ?? DEFAULTS.dodByChem[chemistry.value];
    reserve.value = data.settings.reserve ?? 20;
    days.value = data.settings.days ?? 2;
    invEff.value = data.settings.invEff ?? 90;
    invStandby.value = data.settings.invStandby ?? 6;
    derate.value = data.settings.derate ?? 0;
    
        // NEW:
    if (data.settings.actualBankAh != null) {
      actualBankAhEl.value = data.settings.actualBankAh;
    } else {
      actualBankAhEl.value = DEFAULTS.actualBankAh;
    }

    tbody.innerHTML = "";
    state.rows = [];
    (data.rows || []).forEach((r) => addRow(r));
    state.gen = [];
    genBody.innerHTML = "";
    (data.gen || []).forEach((e) => state.gen.push(e));
    renderGenList();
    unitMode = "Ah";
    window.unitMode = unitMode;
    $("#unitWh").checked = false;
    $("#unitAh").checked = true;
  } catch (e) {
    console.error(e);
  }
}

/* ======= Reports breakdown builders (for stacked) ======= */

// Generation breakdown by type (Solar/Wind/Alternator/AC Charger)
function buildGenBreakdownSeries(daysCount, V) {
  if (!Array.isArray(state.gen) || !state.gen.length) return undefined;
  // Sum by type (per-day Wh)
  const byType = new Map();
  for (const e of state.gen) {
    const wh = genEntryWh(e, V);
    byType.set(e.type, (byType.get(e.type) || 0) + wh);
  }
  const labels = Array.from(byType.keys());
  if (!labels.length) return undefined;
  return labels.map((label) => ({
    label,
    series: Array.from({ length: daysCount }, () => byType.get(label) || 0),
  }));
}

// Loads breakdown by Category (per-day Wh)
function buildUseBreakdownSeries(daysCount) {
  if (!Array.isArray(state.rows) || !state.rows.length) return undefined;
  const byCat = new Map();
  for (const r of state.rows) {
    const duty = (r.duty || 0) / 100,
      qty = r.qty || 0;
    const whA = rowWh(r, r.hAnchor, duty, qty);
    const whS = rowWh(r, r.hSail, duty, qty);
    const wh = whA + whS;
    byCat.set(r.category, (byCat.get(r.category) || 0) + wh);
  }
  // Add inverter standby as its own "category"
  const inv = state.settings.invStandby * (Math.max(...state.rows.filter(x=>x.type==="AC").map(x=>x.hAnchor||0),0) + Math.max(...state.rows.filter(x=>x.type==="AC").map(x=>x.hSail||0),0));
  if (inv > 0) byCat.set("Inverter Standby", (byCat.get("Inverter Standby") || 0) + inv);

  const labels = Array.from(byCat.keys());
  if (!labels.length) return undefined;
  return labels.map((label) => ({
    label,
    series: Array.from({ length: daysCount }, () => byCat.get(label) || 0),
  }));
}
