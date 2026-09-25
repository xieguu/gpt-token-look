const element = (identifier) => document.getElementById(identifier);

function setStatus(message, failed = false) {
  element("settingsStatus").textContent = message;
  element("settingsStatus").classList.toggle("failed", failed);
}

element("showToken").addEventListener("change", (event) => { element("apiToken").type = event.target.checked ? "text" : "password"; });
element("openDashboard").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") }).catch((error) => setStatus(error.message, true)));
element("settingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  element("settingsFields").disabled = true;
  let saved = false;
  try {
    const settings = await TokenLensExtension.saveSettings({ port: element("port").value, apiToken: element("apiToken").value });
    saved = true;
    element("port").value = settings.port;
    element("apiToken").value = settings.apiToken;
    setStatus("设置已保存，正在测试连接…");
    const data = await TokenLensData.fetchUsage(TokenLensExtension.request);
    if (!data.available) throw new Error("服务已连接，但未找到 Codex 会话目录。");
    if (!Array.isArray(data.sessions)) throw new Error("服务返回了无效的会话数据。");
    setStatus(`连接成功 · 端口 ${settings.port} · ${data.sessionCount} 个会话。`);
  } catch (error) {
    setStatus(`${saved ? "设置已保存，连接测试失败：" : "保存失败："}${error.message}`, true);
  } finally { element("settingsFields").disabled = false; }
});

TokenLensExtension.getSettings().then((settings) => {
  element("port").value = settings.port;
  element("apiToken").value = settings.apiToken;
  element("settingsFields").disabled = false;
  setStatus("配置仅保存在此浏览器本机。");
}).catch((error) => setStatus(`读取配置失败：${error.message}`, true));
