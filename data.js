(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TokenLensData = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function asDate(value) {
    if (value == null || value === "") return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function localDateIso(value) {
    const date = asDate(value) || new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function localDateFromSession(item) {
    const timestamp = asDate(item?.startedAt) || asDate(item?.updatedAt);
    if (timestamp) return localDateIso(timestamp);
    const date = String(item?.date || "").slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
  }

  function filterSessions(sessions, filters, now = new Date()) {
    const state = { period: "today", modelFilter: "all", dateFrom: "", dateTo: "", searchQuery: "", ...filters };
    const today = state.period === "today" ? localDateIso(now) : null;
    const threshold = state.period !== "all" && !today ? now.getTime() - Number(state.period) * 86400000 : null;
    const query = state.searchQuery.toLowerCase();
    return sessions.filter((item) => {
      if (state.modelFilter !== "all" && item.model !== state.modelFilter) return false;
      if (query && !(item.name || "").toLowerCase().includes(query) && !(item.model || "").toLowerCase().includes(query)) return false;
      if (threshold !== null && !((asDate(item.updatedAt) || asDate(item.startedAt))?.getTime() >= threshold)) return false;
      if (today || state.dateFrom || state.dateTo) {
        const date = localDateFromSession(item);
        if (today && date !== today) return false;
        if (state.dateFrom && date < state.dateFrom) return false;
        if (state.dateTo && date > state.dateTo) return false;
      }
      return true;
    });
  }

  function summarizeSessions(sessions) {
    return sessions.reduce((summary, session) => {
      const input = Number(session.input) || 0;
      const output = Number(session.output) || 0;
      summary.input += input;
      summary.cachedInput += Number(session.cachedInput) || 0;
      summary.output += output;
      summary.total += Number(session.total) || input + output;
      summary.costUsd += Number(session.costUsd) || 0;
      if (session.costBreakdown?.estimated) summary.priced += 1;
      return summary;
    }, { input: 0, cachedInput: 0, output: 0, total: 0, costUsd: 0, priced: 0 });
  }

  function relativeTime(value, now = Date.now()) {
    const date = asDate(value);
    if (!date) return { label: "更新时间未知", minutes: null, level: "unknown" };
    const ageMs = Math.max(0, now - date.getTime());
    const minutes = Math.floor(ageMs / 60000);
    let relative;
    if (minutes < 1) relative = "刚刚";
    else if (minutes === 1) relative = "1 分钟前";
    else if (minutes < 60) relative = `${minutes} 分钟前`;
    else {
      const hours = Math.floor(minutes / 60);
      relative = hours === 1 ? "1 小时前" : `${hours} 小时前`;
    }
    return { label: `更新于 ${relative}`, minutes, level: ageMs > 30 * 60000 ? "stale" : ageMs > 5 * 60000 ? "aging" : "fresh" };
  }

  function pricingStatus(pricing, now = Date.now()) {
    const date = asDate(pricing?.updatedAt);
    const ageMs = date ? Math.max(0, now - date.getTime()) : null;
    const ageDays = ageMs == null ? null : Math.floor(ageMs / 86400000);
    return {
      dateLabel: date ? localDateIso(date) : "未知",
      ageDays,
      stale: pricing?.stale === true || ageMs == null || ageMs > 30 * 86400000,
      usingOldPrices: pricing?.usingOldPrices === true,
      updateError: pricing?.updateError || null
    };
  }

  function rateLimitSource(source) {
    if (source === "codex-app-server") return { label: "官方实时数据", tone: "official" };
    if (source === "local-session-snapshot") return { label: "本地历史快照", tone: "snapshot" };
    return { label: "额度不可用", tone: "unavailable" };
  }

  async function fetchUsage(fetchImpl, token) {
    const response = await fetchImpl("/api/usage", { cache: "no-store", headers: token ? { "x-token-lens-token": token } : {} });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || data.error || `HTTP ${response.status}`);
    return data;
  }

  async function updatePricing(fetchImpl, token) {
    const response = await fetchImpl("/api/pricing/update", { method: "POST", headers: token ? { "x-token-lens-token": token } : {} });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || `HTTP ${response.status}`);
      error.pricing = data.pricing || null;
      throw error;
    }
    return data;
  }

  function serializeExport(format, sessions, filters, now = new Date()) {
    const filename = `codex-token-lens-${localDateIso(now)}.${format}`;
    const normalized = sessions.map((item) => ({ ...item, date: localDateFromSession(item) }));
    if (format === "json") return { filename, type: "application/json", body: JSON.stringify({ exportedAt: now.toISOString(), filters, sessions: normalized }, null, 2) };
    const columns = ["date", "name", "model", "input", "cachedInput", "cacheWriteInput", "output", "reasoningOutput", "total", "costUsd", "priced"];
    const rows = [columns.join(","), ...normalized.map((item) => columns.map((column) => csvCell(column === "priced" ? Boolean(item.costBreakdown?.estimated) : item[column])).join(","))];
    return { filename, type: "text/csv", body: rows.join("\n") };
  }

  function csvCell(value) {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }

  return { asDate, fetchUsage, filterSessions, localDateIso, localDateFromSession, pricingStatus, rateLimitSource, relativeTime, serializeExport, summarizeSessions, updatePricing };
});
