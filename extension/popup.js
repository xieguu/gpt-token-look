const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat("zh-CN");
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 4 });
const element = (identifier) => document.getElementById(identifier);
let pending = false;
const pageConnection = TokenLensData.createPageConnection(TokenLensExtension.request, { onError: showError });

function showError(error) {
  element("errorMessage").textContent = error.message;
  element("error").hidden = false;
}

function renderLimits(limits, source, updatedAt) {
  element("limitSource").textContent = TokenLensData.rateLimitSource(source).label;
  element("limitFreshness").textContent = updatedAt ? TokenLensData.relativeTime(updatedAt).label : "暂无额度数据";
  for (const kind of ["primary", "secondary"]) {
    const value = limits?.[kind]?.remaining_percent;
    const remaining = value == null ? NaN : Number(value);
    const available = Number.isFinite(remaining);
    const percent = available ? Math.max(0, Math.min(100, remaining)) : 0;
    element(`${kind}Remaining`).textContent = available ? `${percent.toFixed(0)}%` : "—";
    element(`${kind}Progress`).value = percent;
    element(`${kind}Progress`).classList.toggle("low", available && percent < 10);
  }
}

function renderRecent(sessions) {
  const rows = sessions.slice(0, 3).map((session) => {
    const row = document.createElement("li");
    const detail = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = session.name;
    title.title = session.name;
    const model = document.createElement("span");
    model.textContent = session.model;
    const total = document.createElement("span");
    total.className = "recent-total";
    total.textContent = compact.format(session.total);
    detail.append(title, model);
    row.append(detail, total);
    return row;
  });
  if (!rows.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "暂无会话记录";
    rows.push(empty);
  }
  element("recentSessions").replaceChildren(...rows);
}

async function refresh() {
  if (pending) return;
  pending = true;
  element("overview").setAttribute("aria-busy", "true");
  element("refresh").disabled = true;
  element("error").hidden = true;
  element("connectionStatus").textContent = "正在读取本地用量…";
  try {
    await pageConnection.connect();
    const data = await TokenLensData.fetchUsage(TokenLensExtension.request);
    if (!Array.isArray(data.sessions)) throw new Error("本地服务返回了无效的会话数据。");
    if (!data.available) throw new Error("本地服务已连接，但未找到 Codex 会话目录。");
    const today = new Date();
    const sessions = TokenLensData.filterSessions(data.sessions, { period: "today" }, today);
    const summary = TokenLensData.summarizeSessions(sessions);
    element("todayDate").textContent = TokenLensData.localDateIso(today);
    element("totalTokens").textContent = compact.format(summary.total);
    element("totalTokens").title = `${integer.format(summary.total)} tokens`;
    element("costUsd").textContent = money.format(summary.costUsd);
    element("sessionCount").textContent = integer.format(sessions.length);
    element("pricingNote").textContent = `${summary.priced}/${sessions.length} 个会话已估价 · 非订阅账单`;
    element("connectionStatus").textContent = `已连接 · ${integer.format(data.sessionCount)} 个会话`;
    const scannedAt = TokenLensData.asDate(data.scannedAt);
    element("lastUpdated").textContent = scannedAt ? `${scannedAt.toLocaleTimeString("zh-CN")} 同步 · 仅连接本机` : "同步时间未知 · 仅连接本机";
    renderLimits(data.rateLimits, data.rateLimitsSource, data.rateLimitsUpdatedAt);
    renderRecent(data.sessions);
  } catch (error) {
    for (const identifier of ["totalTokens", "costUsd", "sessionCount"]) element(identifier).textContent = "—";
    element("totalTokens").removeAttribute("title");
    element("todayDate").textContent = "";
    element("pricingNote").textContent = "估算值，不是订阅账单";
    element("connectionStatus").textContent = "连接失败";
    element("lastUpdated").textContent = "未同步 · 请检查连接设置";
    renderLimits(null, "unavailable", null);
    renderRecent([]);
    showError(error);
  } finally {
    pending = false;
    element("overview").setAttribute("aria-busy", "false");
    element("refresh").disabled = false;
  }
}

element("refresh").addEventListener("click", refresh);
element("settings").addEventListener("click", () => chrome.runtime.openOptionsPage().catch(showError));
element("openDashboard").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") }).catch(showError));
const refreshTimer = setInterval(() => { if (!document.hidden) refresh(); }, 30000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
window.addEventListener("pagehide", () => { clearInterval(refreshTimer); pageConnection.disconnect(); }, { once: true });
refresh();
