(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TokenLensExtension = api.createClient({ storage: root.chrome.storage.local, fetchImpl: root.fetch.bind(root) });
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const defaults = Object.freeze({ port: 4173, apiToken: "" });

  function normalizeSettings(settings) {
    const rawPort = settings.port === undefined ? defaults.port : settings.port;
    const port = Number(rawPort);
    if (!["string", "number"].includes(typeof rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("端口必须是 1–65535 之间的整数。");
    }
    const rawToken = settings.apiToken === undefined ? defaults.apiToken : settings.apiToken;
    if (typeof rawToken !== "string" || /[^\x21-\x7e]/.test(rawToken.trim())) {
      throw new Error("API Token 只能包含可打印 ASCII 字符，不能包含空格或换行。");
    }
    return { port, apiToken: rawToken.trim() };
  }

  function createClient({ storage, fetchImpl, timeoutMs = 15000 }) {
    async function getSettings() {
      return normalizeSettings(await storage.get(defaults));
    }

    async function saveSettings(settings) {
      const normalized = normalizeSettings(settings);
      await storage.set(normalized);
      return normalized;
    }

    async function request(requestPath, options = {}) {
      if (typeof requestPath !== "string" || !requestPath.startsWith("/api/")) throw new Error("只允许访问本地 Token Lens API。");
      const settings = await getSettings();
      const origin = `http://127.0.0.1:${settings.port}`;
      const url = new URL(requestPath, origin);
      if (url.origin !== origin || !url.pathname.startsWith("/api/")) throw new Error("只允许访问本地 Token Lens API。");
      const headers = new Headers(options.headers);
      headers.delete("x-token-lens-token");
      if (settings.apiToken) headers.set("x-token-lens-token", settings.apiToken);
      return fetchImpl(url.href, {
        ...options,
        headers,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: options.signal || AbortSignal.timeout(timeoutMs)
      });
    }

    return { getSettings, saveSettings, request };
  }

  return { createClient, normalizeSettings };
});
