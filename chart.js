(function (root, factory) {
  const data = root.TokenLensData || (typeof require === "function" ? require("./data") : null);
  const api = factory(data);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TokenLensChart = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (data) {
  function groupByLocalDay(items) {
    const result = new Map();
    for (const item of items) {
      const date = data.localDateFromSession(item);
      if (!date) continue;
      const current = result.get(date) || { date, input: 0, output: 0 };
      current.input += Number(item.input || 0);
      current.output += Number(item.output || 0);
      result.set(date, current);
    }
    return result;
  }

  function hourOf(item) {
    const date = data.asDate(item?.startedAt) || data.asDate(item?.updatedAt);
    return date ? date.getHours() : null;
  }

  function renderMiniBars(container, sessions) {
    const values = sessions.slice(0, 12).reverse().map((item) => Number(item.total || item.input + item.output || 0));
    const max = Math.max(...values, 1);
    container.innerHTML = values.length
      ? values.map((value) => `<i style="height:${Math.max(10, (value / max) * 100)}%"></i>`).join("")
      : "<span class='muted'>No data</span>";
  }

  function render({ sessions, granularity, period, chart, yAxis, compact, integer }) {
    if (granularity === "hour" && period === "today") renderHourly(sessions, chart, yAxis, compact, integer);
    else renderDaily(sessions, chart, yAxis, compact, integer);
  }

  function renderDaily(sessions, chart, yAxis, compact, integer) {
    const ordered = [...groupByLocalDay(sessions).values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-10);
    const max = Math.max(...ordered.map((item) => item.input + item.output), 1);
    yAxis.innerHTML = [1, .75, .5, .25, 0].map((step) => `<span>${compact.format(Math.round(max * step))}</span>`).join("");
    chart.innerHTML = ordered.length
      ? ordered.map((item) => {
          const totalHeight = Math.max(6, ((item.input + item.output) / max) * 88);
          const inputShare = (item.input / (item.input + item.output || 1)) * 100;
          return `<div class="chart-column" title="${integer.format(item.input + item.output)} tokens"><div class="bar-stack" style="height:${totalHeight}%"><span class="bar-output" style="height:${100 - inputShare}%"></span><span class="bar-input" style="height:${inputShare}%"></span></div><label>${item.date.slice(5).replace("-", "/")}</label></div>`;
        }).join("")
      : "<p class='muted'>No records in current filter</p>";
  }

  function renderHourly(sessions, chart, yAxis, compact, integer) {
    const byHour = new Map();
    for (let hour = 0; hour < 24; hour++) byHour.set(hour, { hour, input: 0, output: 0 });
    for (const item of sessions) {
      const hour = hourOf(item);
      if (hour == null) continue;
      const bucket = byHour.get(hour);
      bucket.input += Number(item.input || 0);
      bucket.output += Number(item.output || 0);
    }
    const ordered = [...byHour.values()];
    const max = Math.max(...ordered.map((item) => item.input + item.output), 1);
    yAxis.innerHTML = [1, .75, .5, .25, 0].map((step) => `<span>${compact.format(Math.round(max * step))}</span>`).join("");
    chart.innerHTML = ordered.map((item) => {
      const total = item.input + item.output;
      const totalHeight = total > 0 ? Math.max(6, (total / max) * 88) : 0;
      const inputShare = total > 0 ? (item.input / total) * 100 : 0;
      return `<div class="chart-column" title="${item.hour}:00 — ${integer.format(total)} tokens"><div class="bar-stack" style="height:${totalHeight}%"><span class="bar-output" style="height:${100 - inputShare}%"></span><span class="bar-input" style="height:${inputShare}%"></span></div><label>${String(item.hour).padStart(2, "0")}</label></div>`;
    }).join("");
  }

  return { groupByLocalDay, hourOf, render, renderMiniBars };
});
