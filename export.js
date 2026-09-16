(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TokenLensExport = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function formatSessionToMarkdown(sessionData) {
    const { sessionId, title, model, events } = sessionData;

    const sessionMeta = events.find((e) => e.type === "session_meta");
    const startTime = new Date(sessionMeta?.payload?.timestamp || sessionMeta?.timestamp || "");
    const startTimeStr = !Number.isNaN(startTime.getTime())
      ? startTime.toLocaleString()
      : "Unknown";

    let markdown = `# ${title}\n\n`;
    markdown += `**Session ID**: ${sessionId}  \n`;
    markdown += `**Model**: ${model}  \n`;
    markdown += `**Started**: ${startTimeStr}  \n`;

    const tokenUsage = events.find((e) => e.type === "event_msg" && e.payload?.type === "token_count")?.payload?.info?.total_token_usage;
    if (tokenUsage) {
      markdown += `**Total Tokens**: ${tokenUsage.total_tokens || 0}  \n`;
    }

    markdown += "\n---\n\n";
    markdown += "## Message Record\n\n";

    const messages = events.filter((e) => e.type === "message");
    const toolCalls = events.filter((e) => e.type === "tool_call");
    const toolResults = events.filter((e) => e.type === "tool_result");
    const errors = events.filter((e) => e.type === "error");

    const timeline = [];
    messages.forEach((m) => timeline.push({ type: "message", data: m, timestamp: m.timestamp || m.sent_at }));
    toolCalls.forEach((t) => timeline.push({ type: "tool_call", data: t, timestamp: t.timestamp }));
    toolResults.forEach((r) => timeline.push({ type: "tool_result", data: r, timestamp: r.timestamp }));
    errors.forEach((e) => timeline.push({ type: "error", data: e, timestamp: e.timestamp }));

    timeline.sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")));

    timeline.forEach((item, index) => {
      const timestamp = item.timestamp ? new Date(item.timestamp).toLocaleTimeString() : "";

      if (item.type === "message") {
        const msg = item.data;
        const role = String(msg.payload?.role || msg.role || "unknown").toUpperCase();
        const content = msg.payload?.content || msg.content || "";
        markdown += `**${role}** ${timestamp ? `(${timestamp})` : ""}\n\n`;
        markdown += `${sanitizeMarkdown(content)}\n\n`;
      } else if (item.type === "tool_call") {
        const tool = item.data;
        const toolName = tool.payload?.tool_name || tool.tool_name || "Unknown Tool";
        const toolInput = tool.payload?.tool_input || tool.tool_input || {};
        markdown += `**Tool Call** ${timestamp ? `(${timestamp})` : ""}\n\n`;
        markdown += `Tool: ${toolName}\n\n`;
        markdown += `\`\`\`json\n${JSON.stringify(toolInput, null, 2)}\n\`\`\`\n\n`;
      } else if (item.type === "tool_result") {
        const result = item.data;
        const toolOutput = result.payload?.tool_output || result.tool_output || "";
        markdown += `**Tool Result**\n\n`;
        markdown += `${sanitizeMarkdown(String(toolOutput))}\n\n`;
      } else if (item.type === "error") {
        const err = item.data;
        const errorMsg = err.payload?.error || err.error || "Unknown error";
        markdown += `**Error** ${timestamp ? `(${timestamp})` : ""}\n\n`;
        markdown += `${sanitizeMarkdown(String(errorMsg))}\n\n`;
      }
    });

    if (timeline.length === 0) {
      markdown += "No messages recorded.\n\n";
    }

    markdown += "\n---\n\n";
    markdown += `*Exported on ${new Date().toISOString()}*\n`;

    return markdown;
  }

  function sanitizeMarkdown(text) {
    return String(text)
      .replace(/\\/g, "\\\\")
      .replace(/`/g, "\\`")
      .trim();
  }

  return { formatSessionToMarkdown };
});
