(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TokenLensNotifications = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  async function requestPermission() {
    if (!("Notification" in root) || root.Notification.permission !== "default") return;
    try { await root.Notification.requestPermission(); } catch { /* Permission prompts may be blocked. */ }
  }

  function showOnce(message, key) {
    if (!message || !("Notification" in root) || root.Notification.permission !== "granted" || !root.localStorage) return;
    const today = root.TokenLensData?.localDateIso?.() || new Date().toLocaleDateString("sv-SE");
    const signature = `${key || message}:${today}`;
    if (root.localStorage.getItem("codex-token-lens-last-notification") === signature) return;
    new root.Notification("Codex Token Lens", { body: message });
    root.localStorage.setItem("codex-token-lens-last-notification", signature);
  }

  function renderAlerts({ banner, messageNode, rateLimits, alerts, cost, money }) {
    const limits = [rateLimits?.primary, rateLimits?.secondary].filter(Boolean);
    const lowLimit = limits.find((limit) => Number(limit.remaining_percent) < Number(alerts?.remainingPercent || 10));
    const dailyThreshold = Number(alerts?.dailyCostUsd || 0);
    const message = lowLimit
      ? `Rate limit is low: ${Math.round(Number(lowLimit.remaining_percent))}% remaining.`
      : dailyThreshold > 0 && cost >= dailyThreshold
        ? `Daily API-equivalent cost reached ${money.format(cost)}.`
        : "";
    banner.hidden = !message;
    messageNode.textContent = message;
    showOnce(message, message);
    return message;
  }

  return { renderAlerts, requestPermission, showOnce };
});
