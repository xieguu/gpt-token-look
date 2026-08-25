const THEME_KEY = "codex-theme";
const API_TOKEN_KEY = "codex-token-lens-api-token";
const NOTIFICATION_KEY = "codex-token-lens-last-notification";

const tokenFromUrl = new URLSearchParams(window.location.search).get("token");
if (tokenFromUrl) {
  sessionStorage.setItem(API_TOKEN_KEY, tokenFromUrl);
  const cleanUrl = new URL(window.location.href);
  cleanUrl.searchParams.delete("token");
  history.replaceState(null, "", `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
}

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
  rateLimitsSource: "unavailable",
  accountUsage: null,
  costSummary: null,
  pricing: null,
  source: "",
  loading: false,
  modelFilter: "all",
  dateFrom: "",
  dateTo: "",
  searchQuery: "",
  chartGranularity: "day",
  error: null,
  alerts: { dailyCostUsd: null, remainingPercent: 10 }
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat("en");
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 4 });
const pct = new Intl.NumberFormat("en", { style: "percent", signDisplay: "exceptZero", minimumFractionDigits: 0, maximumFractionDigits: 1 });

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
  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    result = result.filter((item) => (item.name || "").toLowerCase().includes(q) || (item.model || "").toLowerCase().includes(q));
  }
  return result;
}

function sum(items, field) {
  return items.reduce((total, item) => total + Number(item[field] || 0), 0);
}

function setState(patch, shouldRender = true) {
  Object.assign(state, patch);
  if (shouldRender) render();
}

function matchesSecondaryFilters(item) {
  if (state.modelFilter !== "all" && item.model !== state.modelFilter) return false;
  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    if (!(item.name || "").toLowerCase().includes(q) && !(item.model || "").toLowerCase().includes(q)) return false;
  }
  return true;
}

function comparisonWindow() {
  const day = 86400000;
  const now = new Date();
  if (state.dateFrom || state.dateTo) {
    const currentStart = new Date(`${state.dateFrom || state.dateTo}T00:00:00`).getTime();
    const currentEnd = new Date(`${state.dateTo || state.dateFrom}T23:59:59.999`).getTime();
    const duration = Math.max(day, currentEnd - currentStart + 1);
    return { from: currentStart - duration, to: currentStart, label: "previous range" };
  }
  if (state.period === "today") {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return { from: today - day, to: today, label: "yesterday" };
  }
  if (state.period === "7" || state.period === "30") {
    const duration = Number(state.period) * day;
    const currentStart = Date.now() - duration;
    return { from: currentStart - duration, to: currentStart, label: `previous ${state.period}d` };
  }
  return null;
}

function comparisonSessions() {
  const window = comparisonWindow();
  if (!window) return { sessions: null, label: "" };
  return {
    label: window.label,
    sessions: state.sessions.filter((item) => {
      const timestamp = new Date(item.updatedAt || `${item.date}T12:00:00`).getTime();
      return matchesSecondaryFilters(item) && timestamp >= window.from && timestamp < window.to;
    })
  };
}

function computeComparison(sessions) {
  const comparison = comparisonSessions();
  if (!sessions.length || !comparison.sessions) return null;
  const prevTotal = sum(comparison.sessions, "total") || sum(comparison.sessions, "input") + sum(comparison.sessions, "output");
  const curTotal = sum(sessions, "total") || sum(sessions, "input") + sum(sessions, "output");
  const prevCost = sum(comparison.sessions, "costUsd");
  const curCost = sum(sessions, "costUsd");
  if (!prevTotal && !prevCost) return null;
  return {
    tokens: prevTotal ? (curTotal - prevTotal) / prevTotal : null,
    cost: prevCost ? (curCost - prevCost) / prevCost : null,
    label: comparison.label
  };
}

function formatDelta(ratio) {
  if (ratio == null || !Number.isFinite(ratio)) return "";
  const text = pct.format(ratio);
  const cls = ratio > 0 ? "delta-up" : ratio < 0 ? "delta-down" : "";
  return `<span class="${cls}">${text}</span>`;
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

  const comp = computeComparison(sessions);
  $("#tokenDelta").innerHTML = comp?.tokens != null ? `${formatDelta(comp.tokens)} <span class="delta-label">vs ${comp.label}</span>` : "";
  $("#costDelta").innerHTML = comp?.cost != null ? `${formatDelta(comp.cost)} <span class="delta-label">vs ${comp.label}</span>` : "";

  renderAccountUsage();
  renderRateLimits();
  $("#averageTokens").textContent = compact.format(average);
  $("#sessionSummary").textContent = `${sessions.length} sessions · ${state.searchQuery ? `search: "${escapeHtml(state.searchQuery)}"` : "no filter"}`;
  renderMiniBars(sessions);
  renderChart(sessions);
  renderTable(sessions);
  renderInsights(sessions, input, cachedInput, output, cost);
  renderAlerts(sessions, cost);
}

function renderAccountUsage() {
  const usage = state.accountUsage;
  const summary = usage?.summary;
  const lifetime = Number(summary?.lifetimeTokens);
  const peak = Number(summary?.peakDailyTokens);
  $("#accountUsageBadge").textContent = summary ? "Official" : "Unavailable";
  $("#lifetimeTokens").textContent = Number.isFinite(lifetime) && lifetime >= 0 ? compact.format(lifetime) : "--";
  $("#accountUsageSummary").textContent = summary
    ? `${usage.dailyUsageBuckets?.length || 0} daily buckets returned`
    : "Requires a logged-in Codex app-server.";
  $("#peakDailyTokens").textContent = Number.isFinite(peak) && peak >= 0 ? `Peak day: ${compact.format(peak)}` : "Peak day: --";
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
  const sourceText = state.rateLimitsSource === "codex-app-server" ? "Official" : state.rateLimitsSource === "local-session-snapshot" ? "Local snapshot" : "Unavailable";
  $("#limitWindow").textContent = `${windowText} · ${sourceText}`;
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
  const usedPercent = Math.min(Math.max(Number(limit.used_percent) || 0, 0), 100);
  const remainingPercent = Number.isFinite(Number(limit.remaining_percent))
    ? Math.min(Math.max(Number(limit.remaining_percent), 0), 100)
    : 100 - usedPercent;
  const minutes = Number(limit.window_minutes) || 0;
  const reset = limit.resets_at ? new Date(limit.resets_at * 1000) : null;
  $(`#${prefix}Percent`).textContent = `${Math.round(remainingPercent)}%`;
  $(`#${prefix}Ring`).style.setProperty("--progress", `${remainingPercent * 3.6}deg`);
  $(`#${prefix}Detail`).textContent = `${Math.round(usedPercent)}% used · ${formatWindow(minutes)} window`;
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
  const yAxis = $("#yAxis");

  if (state.chartGranularity === "hour" && state.period === "today") {
    renderHourlyChart(sessions, chart, yAxis);
  } else {
    renderDailyChart(sessions, chart, yAxis);
  }
}

function renderDailyChart(sessions, chart, yAxis) {
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
  yAxis.innerHTML = [1, .75, .5, .25, 0].map((step) => `<span>${compact.format(Math.round(max * step))}</span>`).join("");
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

function renderHourlyChart(sessions, chart, yAxis) {
  const byHour = new Map();
  for (let h = 0; h < 24; h++) byHour.set(h, { hour: h, input: 0, output: 0 });
  for (const item of sessions) {
    const ts = new Date(item.startedAt || item.updatedAt);
    if (isNaN(ts.getTime())) continue;
    const h = ts.getHours();
    const bucket = byHour.get(h);
    if (bucket) {
      bucket.input += item.input;
      bucket.output += item.output;
    }
  }
  const ordered = [...byHour.values()];
  const max = Math.max(...ordered.map((item) => item.input + item.output), 1);
  yAxis.innerHTML = [1, .75, .5, .25, 0].map((step) => `<span>${compact.format(Math.round(max * step))}</span>`).join("");
  chart.innerHTML = ordered.map((item) => {
    const total = item.input + item.output;
    const totalHeight = total > 0 ? Math.max(6, (total / max) * 88) : 0;
    const inputShare = total > 0 ? (item.input / total) * 100 : 0;
    return `
      <div class="chart-column" title="${item.hour}:00 — ${integer.format(total)} tokens">
        <div class="bar-stack" style="height:${totalHeight}%">
          <span class="bar-output" style="height:${100 - inputShare}%"></span>
          <span class="bar-input" style="height:${inputShare}%"></span>
        </div>
        <label>${String(item.hour).padStart(2, "0")}</label>
      </div>`;
  }).join("");
}

function renderTable(sessions) {
  const rows = sessions.slice(0, 50);
  $("#sessionTable").innerHTML = rows.length
    ? rows.map((item, idx) => `
      <tr>
        <td class="session-name" title="${escapeHtml(item.name)}"><span class="session-name-text">${escapeHtml(shorten(item.name, 32))}</span><button class="copy-btn" data-idx="${idx}" title="Copy token details">📋</button></td>
        <td>${item.date}</td>
        <td><span class="model-pill">${escapeHtml(item.model)}</span></td>
        <td title="Cached input ${integer.format(item.cachedInput || 0)}">${integer.format(item.input)}</td>
        <td title="Reasoning output ${integer.format(item.reasoningOutput || 0)}">${integer.format(item.output)}</td>
        <td><strong>${integer.format(item.total || item.input + item.output)}</strong></td>
        <td title="${costTitle(item)}">${item.costBreakdown?.estimated ? money.format(item.costUsd) : "Unpriced"}</td>
      </tr>`).join("")
    : `<tr><td colspan="7" class="muted">No Codex sessions in current filter.</td></tr>`;

  // attach copy handlers
  $$(".copy-btn").forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const i = Number(btn.dataset.idx);
      const item = rows[i];
      if (!item) return;
      const text = `Session: ${item.name}\nDate: ${item.date}\nModel: ${item.model}\nInput: ${item.input}\nCached Input: ${item.cachedInput}\nOutput: ${item.output}\nReasoning Output: ${item.reasoningOutput}\nTotal: ${item.total}\nCost: ${item.costBreakdown?.estimated ? money.format(item.costUsd) : 'Unpriced'}`;
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = "✓";
        setTimeout(() => { btn.textContent = "📋"; }, 1200);
      });
    };
  });
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

function renderAlerts(sessions, cost) {
  const limits = [state.rateLimits?.primary, state.rateLimits?.secondary].filter(Boolean);
  const lowLimit = limits.find((limit) => Number(limit.remaining_percent) < Number(state.alerts.remainingPercent || 10));
  const dailyThreshold = Number(state.alerts.dailyCostUsd || 0);
  const message = lowLimit
    ? `Rate limit is low: ${Math.round(Number(lowLimit.remaining_percent))}% remaining.`
    : dailyThreshold > 0 && cost >= dailyThreshold
      ? `Daily API-equivalent cost reached ${money.format(cost)}.`
      : "";
  const banner = $("#alertBanner");
  if (!banner) return;
  banner.hidden = !message;
  $("#alertMsg").textContent = message;
  if (!message || !("Notification" in window) || Notification.permission !== "granted") return;
  const signature = `${message}:${new Date().toISOString().slice(0, 10)}`;
  if (localStorage.getItem(NOTIFICATION_KEY) === signature) return;
  new Notification("Codex Token Lens", { body: message });
  localStorage.setItem(NOTIFICATION_KEY, signature);
}

async function requestNotifications() {
  if (!("Notification" in window) || Notification.permission !== "default") return;
  try { await Notification.requestPermission(); } catch { /* Browser may deny notification prompts. */ }
}

async function updatePricing() {
  const button = $("#updatePricingButton");
  const status = $("#pricingStatus");
  button.disabled = true;
  button.classList.add("loading");
  status.textContent = "Fetching official pricing page…";
  try {
    const token = sessionStorage.getItem(API_TOKEN_KEY);
    const response = await fetch("/api/pricing/update", {
      method: "POST",
      headers: token ? { "x-token-lens-token": token } : {}
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    const count = data.pricing?.models?.length || 0;
    status.textContent = `Updated ${count} model prices from the official page at ${new Date(data.pricing.updatedAt).toLocaleTimeString("zh-CN")}.`;
    await loadRealUsage();
  } catch (error) {
    status.textContent = `Price update failed: ${error.message}`;
  } finally {
    button.disabled = false;
    button.classList.remove("loading");
  }
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
    dateTo: state.dateTo,
    searchQuery: state.searchQuery
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
  state.error = null;
  $("#refreshButton").classList.add("loading");
  $("#errorBanner").style.display = "none";
  setConnectionStatus("loading", "Reading Codex");
  try {
    const token = sessionStorage.getItem(API_TOKEN_KEY);
    const response = await fetch("/api/usage", {
      cache: "no-store",
      headers: token ? { "x-token-lens-token": token } : {}
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || data.error || `HTTP ${response.status}`);
    state.sessions = data.sessions || [];
    state.rateLimits = data.rateLimits;
    state.rateLimitsSource = data.rateLimitsSource || "unavailable";
    state.accountUsage = data.accountUsage;
    state.costSummary = data.costSummary;
    state.pricing = data.pricing;
    state.source = data.source;
    state.alerts = data.alerts || state.alerts;
    $("#lastUpdated").textContent = `${new Date(data.scannedAt).toLocaleTimeString("zh-CN")} synced / ${data.scanDurationMs}ms`;
    $("#sourcePath").textContent = data.source;
    if (data.available) setConnectionStatus("ready", `Connected / ${data.sessionCount} sessions`);
    else {
      setConnectionStatus("error", "Codex data not found");
      $("#lastUpdated").textContent = `Missing data directory: ${data.source}`;
    }
    render();
  } catch (error) {
    state.error = error.message;
    setConnectionStatus("error", "Connection failed");
    $("#lastUpdated").textContent = error.message;
    $("#errorBanner").style.display = "flex";
    $("#errorBanner").querySelector("#errorMsg").textContent = error.message;
    $("#sessionTable").innerHTML = `<tr><td colspan="7" class="muted">Connection failed. Click Retry to try again.</td></tr>`;
  } finally {
    state.loading = false;
    $("#refreshButton").classList.remove("loading");
  }
}

$$('.period-switch button').forEach((button) => {
  button.addEventListener("click", () => {
    $$('.period-switch button').forEach((item) => item.classList.remove("active"));
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
  $$('.period-switch button').forEach((item) => item.classList.remove("active"));
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

$("#searchInput").addEventListener("input", (event) => {
  state.searchQuery = event.target.value.trim();
  render();
});

$("#clearFilters").addEventListener("click", () => {
  state.period = "today";
  state.modelFilter = "all";
  state.dateFrom = "";
  state.dateTo = "";
  state.searchQuery = "";
  $("#modelFilter").value = "all";
  $("#dateFrom").value = "";
  $("#dateTo").value = "";
  $("#searchInput").value = "";
  $$('.period-switch button').forEach((item) => item.classList.toggle("active", item.dataset.period === "today"));
  render();
});

// Chart granularity toggle (hourly only for today)
$$(".granularity-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    $$(".granularity-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    state.chartGranularity = btn.dataset.granularity;
    render();
  });
});

$("#exportJson").addEventListener("click", () => exportSessions("json"));
$("#exportCsv").addEventListener("click", () => exportSessions("csv"));
$("#refreshButton").addEventListener("click", loadRealUsage);
$("#retryButton").addEventListener("click", loadRealUsage);
$("#enableNotifications").addEventListener("click", requestNotifications);
$("#updatePricingButton").addEventListener("click", updatePricing);

$("#themeToggle").addEventListener("click", () => {
  document.body.classList.toggle("dark");
  localStorage.setItem(THEME_KEY, document.body.classList.contains("dark") ? "dark" : "light");
});

if (localStorage.getItem(THEME_KEY) === "dark") document.body.classList.add("dark");
loadRealUsage();
setInterval(loadRealUsage, 30000);
