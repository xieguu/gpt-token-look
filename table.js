(function (root, factory) {
  const data = root.TokenLensData || (typeof require === "function" ? require("./data") : null);
  const api = factory(data);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TokenLensTable = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (data) {
  const pageSize = 50;

  function paginate(sessions, requestedPage = 1) {
    const total = sessions.length;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const page = Number.isInteger(requestedPage) ? Math.max(1, Math.min(requestedPage, pageCount)) : 1;
    const offset = (page - 1) * pageSize;
    return { rows: sessions.slice(offset, offset + pageSize), page, pageCount, total, start: total ? offset + 1 : 0, end: Math.min(offset + pageSize, total) };
  }

  function emptyRow(colspan, message) {
    return `<tr><td colspan="${colspan}" class="muted empty-state">${message}</td></tr>`;
  }

  function render({ body, sessions, page = 1, integer, money, escapeHtml, shorten, clipboard }) {
    const pagination = paginate(sessions, page);
    const { rows } = pagination;
    body.innerHTML = rows.length
      ? rows.map((item, index) => `<tr><td class="session-name" title="${escapeHtml(item.name)}"><span class="session-name-text">${escapeHtml(shorten(item.name, 32))}</span><button class="copy-btn" type="button" data-idx="${index}" title="Copy token details" aria-label="Copy token details for ${escapeHtml(item.name)}">📋</button></td><td>${data.localDateFromSession(item)}</td><td><span class="model-pill">${escapeHtml(item.model)}</span></td><td title="Cached input ${integer.format(item.cachedInput || 0)}">${integer.format(item.input)}</td><td title="Reasoning output ${integer.format(item.reasoningOutput || 0)}">${integer.format(item.output)}</td><td><strong>${integer.format(item.total || item.input + item.output)}</strong></td><td title="${escapeHtml(costTitle(item, money))}">${item.costBreakdown?.estimated ? money.format(item.costUsd) : "Unpriced"}</td><td><button class="export-btn" type="button" data-session-id="${escapeHtml(item.id)}" data-session-name="${escapeHtml(item.name)}" title="Export to Markdown" aria-label="Export ${escapeHtml(item.name)} to Markdown">📥</button></td></tr>`).join("")
      : emptyRow(8, "No Codex sessions in current filter.");

    for (const button of body.querySelectorAll(".copy-btn")) {
      button.onclick = async (event) => {
        event.stopPropagation();
        const item = rows[Number(button.dataset.idx)];
        if (!item || button.disabled) return;
        button.disabled = true;
        try {
          if (!clipboard?.writeText) throw new Error("Clipboard is not available in this browser.");
          const total = Number(item.total) || Number(item.input || 0) + Number(item.output || 0);
          const text = `Session: ${item.name}\nDate: ${data.localDateFromSession(item)}\nModel: ${item.model}\nInput: ${item.input}\nCached Input: ${item.cachedInput || 0}\nCache Write Input: ${item.cacheWriteInput || 0}\nOutput: ${item.output}\nReasoning Output: ${item.reasoningOutput || 0}\nTotal: ${total}\nCost: ${item.costBreakdown?.estimated ? money.format(item.costUsd) : "Unpriced"}`;
          await clipboard.writeText(text);
          button.textContent = "✓";
          button.title = "Token details copied";
          setTimeout(() => { button.textContent = "📋"; button.title = "Copy token details"; }, 1200);
        } catch (error) {
          button.textContent = "✗";
          button.title = `Copy failed: ${error.message}`;
        } finally {
          button.disabled = false;
        }
      };
    }
    return pagination;
  }

  function costTitle(item, money) {
    if (!item.costBreakdown?.estimated) return "Model did not match the built-in or custom API pricing table.";
    return `Matched ${item.costBreakdown.modelMatched}; input ${money.format(item.costBreakdown.inputUsd)}, cached ${money.format(item.costBreakdown.cachedInputUsd)}, cache write ${money.format(item.costBreakdown.cacheWriteInputUsd || 0)}, output ${money.format(item.costBreakdown.outputUsd)}`;
  }

  return { costTitle, emptyRow, paginate, render };
});
