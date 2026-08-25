const THEME_KEY = "codex-theme";
const API_TOKEN_KEY = "codex-token-lens-api-token";

const tokenFromUrl = new URLSearchParams(window.location.search).get("token");
if (tokenFromUrl) {
  sessionStorage.setItem(API_TOKEN_KEY, tokenFromUrl);
  const cleanUrl = new URL(window.location.href);
  cleanUrl.searchParams.delete("token");
  history.replaceState(null, "", `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
}

function localDateIso(date = new Date()) {
  return TokenLensData.localDateIso(date);
}

const state = {
  period: "today",
  sessions: [],
  rateLimits: null,
  rateLimitsSource: "unavailable",
  rateLimitsUpdatedAt: null,
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

function filteredSessions() {
  return TokenLensData.filterSessions(state.sessions, state);
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
  renderPricingStatus();
  $("#averageTokens").textContent = compact.format(average);
  $("#sessionSummary").textContent = `${sessions.length} sessions · ${state.searchQuery ? `search: "${escapeHtml(state.searchQuery)}"` : "no filter"}`;
  TokenLensChart.renderMiniBars($("#miniBars"), sessions);
  TokenLensChart.render({ sessions, granularity: state.chartGranularity, period: state.period, chart: $("#usageChart"), yAxis: $("#yAxis"), compact, integer });
  TokenLensTable.render({ body: $("#sessionTable"), sessions, integer, money, escapeHtml, shorten, clipboard: navigator.clipboard });
  renderInsights(sessions, input, cachedInput, output, cost);
  TokenLensNotifications.renderAlerts({ banner: $("#alertBanner"), messageNode: $("#alertMsg"), rateLimits: state.rateLimits, alerts: state.alerts, cost, money });
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
  $("#limitWindow").textContent = windowText;
  const source = TokenLensData.rateLimitSource(state.rateLimitsSource);
  const sourceNode = $("#limitSource");
  sourceNode.dataset.source = source.tone;
  sourceNode.lastElementChild.textContent = source.label;
}

function renderLimit(kind, limit) {
  const prefix = kind === "primary" ? "primary" : "secondary";
  if (!limit) {
    $(`#${prefix}Percent`).textContent = "--";
    $(`#${prefix}Ring`).style.setProperty("--progress", "0deg");
    $(`#${prefix}Detail`).textContent = "No limit snapshot in latest event";
    $(`#${prefix}Updated`).textContent = "更新时间未知";
    $(`#${prefix}Updated`).dataset.freshness = "unknown";
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
  const freshness = TokenLensData.relativeTime(state.rateLimitsUpdatedAt);
  const updatedNode = $(`#${prefix}Updated`);
  updatedNode.textContent = freshness.level === "stale" ? `${freshness.label} · 快照可能过期` : freshness.label;
  updatedNode.dataset.freshness = freshness.level;
  $(`#${prefix}Reset`).textContent = reset
    ? `${reset.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} reset`
    : "Reset unknown";
}

function renderPricingStatus() {
  const info = TokenLensData.pricingStatus(state.pricing);
  const status = $("#pricingStatus");
  const parts = [`价格更新于 ${info.dateLabel}`];
  if (info.stale) parts.push(info.ageDays == null ? "更新时间不可验证，请更新价格表" : `已超过 30 天（${info.ageDays} 天），请更新`);
  if (info.usingOldPrices) parts.push(`更新失败，仍在使用旧价格${info.updateError ? `：${info.updateError}` : ""}`);
  else if (info.updateError) parts.push(`价格状态异常：${info.updateError}`);
  parts.push("这是 API 等价估算，不是订阅额度或账单");
  status.textContent = parts.join("。") + "。";
  status.dataset.status = info.usingOldPrices ? "error" : info.stale ? "warning" : "fresh";
}

function formatWindow(minutes) {
  if (!minutes) return "Current";
  if (minutes >= 10080 && minutes % 10080 === 0) return `${minutes / 10080}w`;
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
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

async function requestNotifications() {
  await TokenLensNotifications.requestPermission();
}

async function updatePricing() {
  const button = $("#updatePricingButton");
  const status = $("#pricingStatus");
  button.disabled = true;
  button.classList.add("loading");
  status.textContent = "Fetching official pricing page…";
  try {
    const token = sessionStorage.getItem(API_TOKEN_KEY);
    const data = await TokenLensData.updatePricing(fetch, token);
    const count = data.pricing?.models?.length || 0;
    state.pricing = data.pricing || state.pricing;
    status.textContent = `已从官方页面更新 ${count} 个模型价格，更新日期 ${TokenLensData.localDateIso(data.pricing.updatedAt)}。`;
    await loadRealUsage();
  } catch (error) {
    if (error.pricing) state.pricing = error.pricing;
    status.textContent = `价格更新失败，仍在使用旧价格：${error.message}`;
    status.dataset.status = "error";
  } finally {
    button.disabled = false;
    button.classList.remove("loading");
  }
}

function exportSessions(format) {
  const sessions = filteredSessions();
  const output = TokenLensData.serializeExport(format, sessions, currentFilters());
  download(output.filename, output.type, output.body);
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
    const data = await TokenLensData.fetchUsage(fetch, token);
    state.sessions = data.sessions || [];
    state.rateLimits = data.rateLimits;
    state.rateLimitsSource = data.rateLimitsSource || "unavailable";
    state.rateLimitsUpdatedAt = data.rateLimitsUpdatedAt || null;
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
    $("#sessionTable").innerHTML = TokenLensTable.emptyRow(7, "Connection failed. Click Retry to try again.");
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
