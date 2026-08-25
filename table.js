(function (root, factory) {
  const data = root.TokenLensData || (typeof require === "function" ? require("./data") : null);
  const api = factory(data);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TokenLensTable = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (data) {
  function emptyRow(colspan, message) {
    return `<tr><td colspan="${colspan}" class="muted empty-state">${message}</td></tr>`;
  }

  function render({ body, sessions, integer, money, escapeHtml, shorten, clipboard }) {
    const rows = sessions.slice(0, 50);
    body.innerHTML = rows.length
      ? rows.map((item, index) => `<tr><td class="session-name" title="${escapeHtml(item.name)}"><span class="session-name-text">${escapeHtml(shorten(item.name, 32))}</span><button class="copy-btn" data-idx="${index}" title="Copy token details">📋</button></td><td>${data.localDateFromSession(item)}</td><td><span class="model-pill">${escapeHtml(item.model)}</span></td><td title="Cached input ${integer.format(item.cachedInput || 0)}">${integer.format(item.input)}</td><td title="Reasoning output ${integer.format(item.reasoningOutput || 0)}">${integer.format(item.output)}</td><td><strong>${integer.format(item.total || item.input + item.output)}</strong></td><td title="${costTitle(item, money)}">${item.costBreakdown?.estimated ? money.format(item.costUsd) : "Unpriced"}</td></tr>`).join("")
      : emptyRow(7, "No Codex sessions in current filter.");

    for (const button of body.querySelectorAll(".copy-btn")) {
      button.onclick = async (event) => {
        event.stopPropagation();
        const item = rows[Number(button.dataset.idx)];
        if (!item || !clipboard?.writeText) return;
        const text = `Session: ${item.name}\nDate: ${data.localDateFromSession(item)}\nModel: ${item.model}\nInput: ${item.input}\nCached Input: ${item.cachedInput}\nOutput: ${item.output}\nReasoning Output: ${item.reasoningOutput}\nTotal: ${item.total}\nCost: ${item.costBreakdown?.estimated ? money.format(item.costUsd) : "Unpriced"}`;
        await clipboard.writeText(text);
        button.textContent = "✓";
        setTimeout(() => { button.textContent = "📋"; }, 1200);
      };
    }
  }

  function costTitle(item, money) {
    if (!item.costBreakdown?.estimated) return "Model did not match the built-in or custom API pricing table.";
    return `Matched ${item.costBreakdown.modelMatched}; input ${money.format(item.costBreakdown.inputUsd)}, cached ${money.format(item.costBreakdown.cachedInputUsd)}, cache write ${money.format(item.costBreakdown.cacheWriteInputUsd || 0)}, output ${money.format(item.costBreakdown.outputUsd)}`;
  }

  return { costTitle, emptyRow, render };
});
