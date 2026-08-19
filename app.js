const THEME_KEY = "codex-token-lens-theme";

const state = {
  period: "30",
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

function filteredSessions() {
  let result = [...state.sessions];
  if (state.period !== "all") {
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
  $("#costSummary").textContent = priced ? `${priced}/${sessions.length} 个会话可估算` : "当前筛选无可估算模型";

  renderRateLimits();
  $("#averageTokens").textContent = compact.format(average);
  $("#sessionSummary").textContent = `共读取 ${sessions.length} 次真实会话`;
  renderMiniBars(sessions);
  renderChart(sessions);
  renderTable(sessions);
  renderInsights(sessions, input, cachedInput, output, cost);
}

function filterLabel() {
  const parts = [];
  parts.push(state.period === "all" ? "全部记录" : `近 ${state.period} 天`);
  if (state.modelFilter !== "all") parts.push(state.modelFilter);
  if (state.dateFrom || state.dateTo) parts.push(`${state.dateFrom || "起始"} → ${state.dateTo || "现在"}`);
  return parts.join(" · ");
}

function populateModelFilter() {
  const select = $("#modelFilter");
  const models = [...new Set(state.sessions.map((item) => item.model).filter(Boolean))].sort();
  const previous = state.modelFilter;
  select.innerHTML = `<option value="all">全部模型</option>${models.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join("")}`;
  select.value = models.includes(previous) ? previous : "all";
  state.modelFilter = select.value;
}

function renderRateLimits() {
  renderLimit("primary", state.rateLimits?.primary);
  renderLimit("secondary", state.rateLimits?.secondary);
  const windowText = state.rateLimits?.primary?.window_minutes ? formatWindow(Number(state.rateLimits.primary.window_minutes)) : "当前窗口";
  $("#limitWindow").textContent = windowText;
}

function renderLimit(kind, limit) {
  const prefix = kind === "primary" ? "primary" : "secondary";
  if (!limit) {
    $(`#${prefix}Percent`).textContent = "—";
    $(`#${prefix}Ring`).style.setProperty("--progress", "0deg");
    $(`#${prefix}Detail`).textContent = "当前事件未提供限额信息";
    $(`#${prefix}Reset`).textContent = "未提供";
    return;
  }
  const percent = Math.min(Number(limit.used_percent) || 0, 100);
  const minutes = Number(limit.window_minutes) || 0;
  const reset = limit.resets_at ? new Date(limit.resets_at * 1000) : null;
  $(`#${prefix}Percent`).textContent = `${Math.round(percent)}%`;
  $(`#${prefix}Ring`).style.setProperty("--progress", `${percent * 3.6}deg`);
  $(`#${prefix}Detail`).textContent = `${formatWindow(minutes)} 使用窗口`;
  $(`#${prefix}Reset`).textContent = reset
    ? `${reset.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 重置`
    : "重置时间未知";
}

function formatWindow(minutes) {
  if (!minutes) return "当前";
  if (minutes >= 10080 && minutes % 10080 === 0) return `${minutes / 10080} 周`;
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

function renderMiniBars(sessions) {
  const values = sessions.slice(0, 12).reverse().map((item) => item.total || item.input + item.output);
  const max = Math.max(...values, 1);
  $("#miniBars").innerHTML = values.length
    ? values.map((value) => `<i style="height:${Math.max(10, (value / max) * 100)}%"></i>`).join("")
    : "<span class='muted'>暂无数据</span>";
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
    : "<p class='muted'>当前筛选暂无记录</p>";
}

function renderTable(sessions) {
  $("#sessionTable").innerHTML = sessions.length
    ? sessions.slice(0, 25).map((item) => `
      <tr>
        <td class="session-name" title="${escapeHtml(item.name)}">${escapeHtml(shorten(item.name, 32))}</td>
        <td>${item.date}</td>
        <td><span class="model-pill">${escapeHtml(item.model)}</span></td>
        <td title="其中缓存输入 ${integer.format(item.cachedInput || 0)}">${integer.format(item.input)}</td>
        <td title="其中推理输出 ${integer.format(item.reasoningOutput || 0)}">${integer.format(item.output)}</td>
        <td><strong>${integer.format(item.total || item.input + item.output)}</strong></td>
        <td title="${costTitle(item)}">${item.costBreakdown?.estimated ? money.format(item.costUsd) : "未匹配"}</td>
      </tr>`).join("")
    : `<tr><td colspan="7" class="muted">当前筛选暂无 Codex 会话记录。</td></tr>`;
}

function costTitle(item) {
  if (!item.costBreakdown?.estimated) return "模型未匹配内置 API 定价表";
  return `匹配 ${item.costBreakdown.modelMatched}；input ${money.format(item.costBreakdown.inputUsd)}，cached ${money.format(item.costBreakdown.cachedInputUsd)}，output ${money.format(item.costBreakdown.outputUsd)}`;
}

function renderInsights(sessions, input, cachedInput, output, cost) {
  const peak = sessions.reduce((best, item) => !best || item.total > best.total ? item : best, null);
  const ratio = output ? input / output : 0;
  const cacheRate = input ? (cachedInput / input) * 100 : 0;

  $("#peakSession").textContent = peak ? compact.format(peak.total) : "—";
  $("#tokenRatio").textContent = output ? `${ratio.toFixed(1)} : 1` : "—";

  let insight = "读取到真实 Codex 会话后，这里会生成简单的使用建议。";
  if (sessions.length) {
    if (cost > 0) insight = `当前筛选 API 等价估算约 ${money.format(cost)}。这是按内置官方公开价换算，不等于你的订阅额度。`;
    if (cacheRate >= 60) insight += ` 缓存输入占 ${Math.round(cacheRate)}%，上下文复用效果不错。`;
    else if (ratio > 4) insight += " 输入占比偏高，缩小工作区上下文能降消耗。";
    else if (ratio < 1.8) insight += " 输出占比偏高，可在提示里限制答案长度。";
  }
  $("#insightText").textContent = insight;
}

function shorten(value, limit) {
  const text = String(value || "Codex 会话");
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
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
  setConnectionStatus("loading", "正在读取 Codex");
  try {
    const response = await fetch("/api/usage", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || data.error || `HTTP ${response.status}`);
    state.sessions = data.sessions || [];
    state.rateLimits = data.rateLimits;
    state.costSummary = data.costSummary;
    state.pricing = data.pricing;
    state.source = data.source;
    $("#lastUpdated").textContent = `${new Date(data.scannedAt).toLocaleTimeString("zh-CN")} 同步 · ${data.scanDurationMs}ms`;
    $("#sourcePath").textContent = data.source;
    if (data.available) setConnectionStatus("ready", `已连接 · ${data.sessionCount} 个会话`);
    else {
      setConnectionStatus("error", "未找到 Codex 数据");
      $("#lastUpdated").textContent = `数据目录不存在：${data.source}`;
    }
    render();
  } catch (error) {
    setConnectionStatus("error", "连接失败");
    $("#lastUpdated").textContent = error.message;
    $("#sessionTable").innerHTML = `<tr><td colspan="7" class="muted">请通过 start.cmd 启动本地数据服务，不能直接双击 index.html。</td></tr>`;
  } finally {
    state.loading = false;
    $("#refreshButton").classList.remove("loading");
  }
}

$$(".period-switch button").forEach((button) => {
  button.addEventListener("click", () => {
    $$(".period-switch button").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    state.period = button.dataset.period;
    render();
  });
});

$("#modelFilter").addEventListener("change", (event) => {
  state.modelFilter = event.target.value;
  render();
});
$("#dateFrom").addEventListener("change", (event) => {
  state.dateFrom = event.target.value;
  render();
});
$("#dateTo").addEventListener("change", (event) => {
  state.dateTo = event.target.value;
  render();
});
$("#clearFilters").addEventListener("click", () => {
  state.modelFilter = "all";
  state.dateFrom = "";
  state.dateTo = "";
  $("#dateFrom").value = "";
  $("#dateTo").value = "";
  render();
});

$("#refreshButton").addEventListener("click", loadRealUsage);
$("#themeToggle").addEventListener("click", () => {
  document.body.classList.toggle("dark");
  localStorage.setItem(THEME_KEY, document.body.classList.contains("dark") ? "dark" : "light");
});

if (localStorage.getItem(THEME_KEY) === "dark") document.body.classList.add("dark");
loadRealUsage();
setInterval(loadRealUsage, 30000);
