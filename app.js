const THEME_KEY = "codex-token-lens-theme";

function localDateIso(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const state = {
  period: "today",
  sessions: [],
  rateLimits: null,
  costSummary: null,
  pricing: null,
  source: "",
  loading: false,
  modelFilter: "all",
  dateFrom: "",
  dateTo: ""
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat("en");
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 4 });

function sessionDate(item) {
  if (item.date) return String(item.date).slice(0, 10);
  const updatedAt = new Date(item.updatedAt);
  return Number.isNaN(updatedAt.getTime()) ? "" : localDateIso(updatedAt);
}

function filteredSessions() {
  let result = [...state.sessions];
  if (state.period === "today") {
    const today = localDateIso();
    result = result.filter((item) => sessionDate(item) === today);
  } else if (state.period !== "all") {
    const days = Number(state.period);
    const threshold = Date.now() - days * 86400000;
    result = result.filter((item) => new Date(item.updatedAt || `${item.date}T12:00:00`).getTime() >= threshold);
  }
  if (state.modelFilter !== "all") result = result.filter((item) => item.model === state.modelFilter);
  if (state.dateFrom) result = result.filter((item) => (item.date || "") >= state.dateFrom);
  if (state.dateTo) result = result.filter((item) => (item.date || "") <= state.dateTo);
  return result;
}

function sum(items, field) {
  return items.reduce((total, item) => total + Number(item[field] || 0), 0);
}

function render() {
  populateModelFilter();
  const sessions = filteredSessions().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const input = sum(sessions, "input");
  const cachedInput = sum(sessions, "cachedInput");
  const output = sum(sessions, "output");
  const total = sum(sessions, "total") || input + output;
  const cost = sum(sessions, "costUsd");
  const priced = sessions.filter((item) => item.costBreakdown?.estimated).length;
  const inputPercent = total ? (input / (input + output || total)) * 100 : 0;
  const average = sessions.length ? Math.round(total / sessions.length) : 0;

  $("#totalTokens").textContent = compact.format(total);
  $("#inputTokens").textContent = compact.format(input);
  $("#outputTokens").textContent = compact.format(output);
  $("#inputBar").style.width = `${inputPercent}%`;
  $("#outputBar").style.width = `${100 - inputPercent}%`;
  $("#changeBadge").textContent = filterLabel();
  $("#costUsd").textContent = money.format(cost);
  $("#costSummary").textContent = priced ? `${priced}/${sessions.length} sessions priced` : "No priced model in current filter";

  renderRateLimits();
  $("#averageTokens").textContent = compact.format(average);
  $("#sessionSummary").textContent = `${sessions.length} real sessions loaded`;
  renderMiniBars(sessions);
  renderChart(sessions);
  renderTable(sessions);
  renderInsights(sessions, input, cachedInput, output, cost);
}

function filterLabel() {
  const parts = [];
  if (state.dateFrom || state.dateTo) parts.push(`${state.dateFrom || "start"} to ${state.dateTo || "now"}`);
  else parts.push(state.period === "all" ? "All records" : state.period === "today" ? "Today" : `Last ${state.period}d`);
  if (state.modelFilter !== "all") parts.push(state.modelFilter);
  return parts.join(" / ");
}
function populateModelFilter() {
  const select = $("#modelFilter");
  const models = [...new Set(state.sessions.map((item) => item.model).filter(Boolean))].sort();
  const previous = state.modelFilter;
  select.innerHTML = `<option value="all">All models</option>${models.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join("")}`;
  select.value = models.includes(previous) ? previous : "all";
  state.modelFilter = select.value;
}

function renderRateLimits() {
  renderLimit("primary", state.rateLimits?.primary);
  renderLimit("secondary", state.rateLimits?.secondary);
  const windowText = state.rateLimits?.primary?.window_minutes ? formatWindow(Number(state.rateLimits.primary.window_minutes)) : "Current window";
  $("#limitWindow").textContent = windowText;
}

function renderLimit(kind, limit) {
  const prefix = kind === "primary" ? "primary" : "secondary";
  if (!limit) {
    $(`#${prefix}Percent`).textContent = "--";
    $(`#${prefix}Ring`).style.setProperty("--progress", "0deg");
    $(`#${prefix}Detail`).textContent = "No limit snapshot in latest event";
    $(`#${prefix}Reset`).textContent = "Not provided";
    return;
  }
  const percent = Math.min(Number(limit.used_percent) || 0, 100);
  const minutes = Number(limit.window_minutes) || 0;
  const reset = limit.resets_at ? new Date(limit.resets_at * 1000) : null;
  $(`#${prefix}Percent`).textContent = `${Math.round(percent)}%`;
  $(`#${prefix}Ring`).style.setProperty("--progress", `${percent * 3.6}deg`);
  $(`#${prefix}Detail`).textContent = `${formatWindow(minutes)} window`;
  $(`#${prefix}Reset`).textContent = reset
    ? `${reset.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} reset`
    : "Reset unknown";
}

function formatWindow(minutes) {
  if (!minutes) return "Current";
  if (minutes >= 10080 && minutes % 10080 === 0) return `${minutes / 10080}w`;
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function renderMiniBars(sessions) {
  const values = sessions.slice(0, 12).reverse().map((item) => item.total || item.input + item.output);
  const max = Math.max(...values, 1);
  $("#miniBars").innerHTML = values.length
    ? values.map((value) => `<i style="height:${Math.max(10, (value / max) * 100)}%"></i>`).join("")
    : "<span class='muted'>No data</span>";
}

function renderChart(sessions) {
  const chart = $("#usageChart");
  const byDay = new Map();
  for (const item of sessions) {
    const day = item.date || String(item.updatedAt).slice(0, 10);
    const current = byDay.get(day) || { date: day, input: 0, output: 0 };
    current.input += item.input;
    current.output += item.output;
    byDay.set(day, current);
  }
  const ordered = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-10);
  const max = Math.max(...ordered.map((item) => item.input + item.output), 1);
  $("#yAxis").innerHTML = [1, .75, .5, .25, 0].map((step) => `<span>${compact.format(Math.round(max * step))}</span>`).join("");

  chart.innerHTML = ordered.length
    ? ordered.map((item) => {
        const totalHeight = Math.max(6, ((item.input + item.output) / max) * 88);
        const inputShare = (item.input / (item.input + item.output || 1)) * 100;
        return `
          <div class="chart-column" title="${integer.format(item.input + item.output)} tokens">
            <div class="bar-stack" style="height:${totalHeight}%">
              <span class="bar-output" style="height:${100 - inputShare}%"></span>
              <span class="bar-input" style="height:${inputShare}%"></span>
            </div>
            <label>${item.date.slice(5).replace("-", "/")}</label>
          </div>`;
      }).join("")
    : "<p class='muted'>No records in current filter</p>";
}

function renderTable(sessions) {
  $("#sessionTable").innerHTML = sessions.length
    ? sessions.slice(0, 25).map((item) => `
      <tr>
        <td class="session-name" title="${escapeHtml(item.name)}">${escapeHtml(shorten(item.name, 32))}</td>
        <td>${item.date}</td>
        <td><span class="model-pill">${escapeHtml(item.model)}</span></td>
        <td title="Cached input ${integer.format(item.cachedInput || 0)}">${integer.format(item.input)}</td>
        <td title="Reasoning output ${integer.format(item.reasoningOutput || 0)}">${integer.format(item.output)}</td>
        <td><strong>${integer.format(item.total || item.input + item.output)}</strong></td>
        <td title="${costTitle(item)}">${item.costBreakdown?.estimated ? money.format(item.costUsd) : "Unpriced"}</td>
      </tr>`).join("")
    : `<tr><td colspan="7" class="muted">No Codex sessions in current filter.</td></tr>`;
}

function costTitle(item) {
  if (!item.costBreakdown?.estimated) return "Model did not match the built-in or custom API pricing table.";
  return `Matched ${item.costBreakdown.modelMatched}; input ${money.format(item.costBreakdown.inputUsd)}, cached ${money.format(item.costBreakdown.cachedInputUsd)}, cache write ${money.format(item.costBreakdown.cacheWriteInputUsd || 0)}, output ${money.format(item.costBreakdown.outputUsd)}`;
}

function renderInsights(sessions, input, cachedInput, output, cost) {
  const peak = sessions.reduce((best, item) => !best || item.total > best.total ? item : best, null);
  const ratio = output ? input / output : 0;
  const cacheRate = input ? (cachedInput / input) * 100 : 0;

  $("#peakSession").textContent = peak ? compact.format(peak.total) : "--";
  $("#tokenRatio").textContent = output ? `${ratio.toFixed(1)} : 1` : "--";

  let insight = "Load real Codex sessions to get a quick usage note.";
  if (sessions.length) {
    insight = cost > 0
      ? `Current filter is roughly ${money.format(cost)} in API-equivalent cost. This is an estimate, not your subscription quota or bill.`
      : "The current filter has usage, but none of its models matched the pricing table.";
    if (cacheRate >= 60) insight += ` Cached input is ${Math.round(cacheRate)}%, so context reuse is doing useful work.`;
    else if (ratio > 4) insight += " Input dominates output; trimming workspace context can reduce usage.";
    else if (ratio < 1.8) insight += " Output is a large share; shorter requested answers can reduce usage.";
  }
  $("#insightText").textContent = insight;
}

function exportSessions(format) {
  const sessions = filteredSessions();
  const filename = `codex-token-lens-${new Date().toISOString().slice(0, 10)}.${format}`;
  if (format === "json") {
    download(filename, "application/json", JSON.stringify({ exportedAt: new Date().toISOString(), filters: currentFilters(), sessions }, null, 2));
    return;
  }
  const columns = ["date", "name", "model", "input", "cachedInput", "output", "reasoningOutput", "total", "costUsd", "priced"];
  const rows = [columns.join(","), ...sessions.map((item) => columns.map((column) => csvCell(column === "priced" ? Boolean(item.costBreakdown?.estimated) : item[column])).join(","))];
  download(filename, "text/csv", rows.join("\n"));
}

function currentFilters() {
  return {
    period: state.period,
    model: state.modelFilter,
    dateFrom: state.dateFrom,
    dateTo: state.dateTo
  };
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function download(filename, type, body) {
  const blob = new Blob([body], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function shorten(value, limit) {
  const text = String(value || "Codex session");
  return text.length > limit ? `${text.slice(0, limit - 1)}...` : text;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[char]);
}

function setConnectionStatus(kind, message) {
  const status = $("#sourceStatus");
  status.classList.toggle("error", kind === "error");
  status.classList.toggle("loading", kind === "loading");
  status.lastChild.textContent = ` ${message}`;
}

async function loadRealUsage() {
  if (state.loading) return;
  state.loading = true;
  $("#refreshButton").classList.add("loading");
  setConnectionStatus("loading", "Reading Codex");
  try {
    const response = await fetch("/api/usage", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || data.error || `HTTP ${response.status}`);
    state.sessions = data.sessions || [];
    state.rateLimits = data.rateLimits;
    state.costSummary = data.costSummary;
    state.pricing = data.pricing;
    state.source = data.source;
    $("#lastUpdated").textContent = `${new Date(data.scannedAt).toLocaleTimeString("zh-CN")} synced / ${data.scanDurationMs}ms`;
    $("#sourcePath").textContent = data.source;
    if (data.available) setConnectionStatus("ready", `Connected / ${data.sessionCount} sessions`);
    else {
      setConnectionStatus("error", "Codex data not found");
      $("#lastUpdated").textContent = `Missing data directory: ${data.source}`;
    }
    render();
  } catch (error) {
    setConnectionStatus("error", "Connection failed");
    $("#lastUpdated").textContent = error.message;
    $("#sessionTable").innerHTML = `<tr><td colspan="7" class="muted">Start the local server with start.cmd or npm start. Opening index.html directly cannot read local Codex data.</td></tr>`;
  } finally {
    state.loading = false;
    $("#refreshButton").classList.remove("loading");
  }
}

$$('.period-switch button').forEach((button) => {
  button.addEventListener("click", () => {
    $$(".period-switch button").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    state.period = button.dataset.period;
    state.dateFrom = "";
    state.dateTo = "";
    $("#dateFrom").value = "";
    $("#dateTo").value = "";
    render();
  });
});
$("#modelFilter").addEventListener("change", (event) => {
  state.modelFilter = event.target.value;
  render();
});
function activateCustomDateRange() {
  state.period = "all";
  $$(".period-switch button").forEach((item) => item.classList.remove("active"));
}

$("#dateFrom").addEventListener("change", (event) => {
  state.dateFrom = event.target.value;
  activateCustomDateRange();
  render();
});
$("#dateTo").addEventListener("change", (event) => {
  state.dateTo = event.target.value;
  activateCustomDateRange();
  render();
});
$("#clearFilters").addEventListener("click", () => {
  state.period = "today";
  state.modelFilter = "all";
  state.dateFrom = "";
  state.dateTo = "";
  $("#modelFilter").value = "all";
  $("#dateFrom").value = "";
  $("#dateTo").value = "";
  $$(".period-switch button").forEach((item) => item.classList.toggle("active", item.dataset.period === "today"));
  render();
});
$("#exportJson").addEventListener("click", () => exportSessions("json"));
$("#exportCsv").addEventListener("click", () => exportSessions("csv"));
$("#refreshButton").addEventListener("click", loadRealUsage);
$("#themeToggle").addEventListener("click", () => {
  document.body.classList.toggle("dark");
  localStorage.setItem(THEME_KEY, document.body.classList.contains("dark") ? "dark" : "light");
});

if (localStorage.getItem(THEME_KEY) === "dark") document.body.classList.add("dark");
loadRealUsage();
setInterval(loadRealUsage, 30000);
