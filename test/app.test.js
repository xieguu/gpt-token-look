const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const data = require("../data");
const table = require("../table");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

test("search bursts render once and do not rebuild the model selector", async () => {
  const app = await createApp();
  const modelWrites = app.element("#modelFilter").htmlWrites;
  for (const value of ["Project", "Project A", "Project A&B"]) app.element("#searchInput").listeners.input({ target: { value } });
  assert.equal(app.renders.length, 1);
  assert.equal(app.timeouts.size, 1);
  const [timerId, timer] = [...app.timeouts][0];
  assert.equal(timer.delay, 150);
  app.timeouts.delete(timerId);
  timer.callback();
  assert.equal(app.renders.length, 2);
  assert.equal(app.renders[1].sessions.length, 1);
  assert.equal(app.element("#modelFilter").htmlWrites, modelWrites);
  assert.match(app.element("#sessionSummary").textContent, /Project A&B/);
});

test("immediate filter changes cancel a pending search render", async () => {
  const app = await createApp();
  app.element("#searchInput").listeners.input({ target: { value: "unused" } });
  app.element("#clearFilters").listeners.click();
  assert.equal(app.timeouts.size, 0);
  assert.equal(app.renders.length, 2);
  assert.deepEqual(Array.from(app.renders[1].sessions, (session) => session.id), ["newer", "older"]);
});

test("automatic refresh pauses while hidden and resumes on visibility", async () => {
  const app = await createApp();
  assert.equal(app.requests.length, 1);
  assert.equal(app.intervals[0].delay, 30000);
  app.document.hidden = true;
  app.intervals[0].callback();
  app.document.listeners.visibilitychange();
  await flush();
  assert.equal(app.requests.length, 1);
  app.document.hidden = false;
  app.document.listeners.visibilitychange();
  await flush();
  assert.equal(app.requests.length, 2);
});

test("export and synchronization send API tokens in headers, never in URLs", async () => {
  const app = await createApp();
  await vm.runInContext("exportAllSessions()", app.context);
  app.prompts.push("fixture-github-token");
  await vm.runInContext("uploadToGist()", app.context);
  app.prompts.push("abc123", "");
  await vm.runInContext("importFromGist()", app.context);
  assert.deepEqual(app.requests.map((request) => request.url), ["/api/usage", "/api/export/all", "/api/sync/upload-gist", "/api/sync/download-gist"]);
  for (const request of app.requests) assert.equal(request.options.headers["x-token-lens-token"], "fixture-api-token");
});

test("refresh errors keep the table's eight-column layout", async () => {
  const app = await createApp();
  app.context.fetch = async () => ({ ok: false, status: 500, async json() { return { error: "fixture failure" }; } });
  await vm.runInContext("loadRealUsage()", app.context);
  assert.match(app.element("#sessionTable").innerHTML, /colspan="8"/);
  assert.equal(app.element("#errorMsg").textContent, "fixture failure");
});

test("paging changes only the table and keeps totals and exports on the full filter", async () => {
  const app = await createApp(todaySessions(125));
  const total = app.element("#totalTokens").textContent;
  assert.equal(app.element("#sessionPageSummary").textContent, "1–50 of 125 sessions");
  assert.equal(app.element("#sessionPrevious").disabled, true);
  app.element("#sessionNext").listeners.click();
  assert.equal(app.element("#sessionPageSummary").textContent, "51–100 of 125 sessions");
  assert.equal(app.element("#sessionPageStatus").textContent, "Page 2 of 3");
  assert.equal(app.chartRenders.length, 1);
  assert.equal(app.requests.length, 1);
  assert.equal(app.element("#totalTokens").textContent, total);
  let exported;
  app.context.download = (filename, type, body) => { exported = JSON.parse(body); };
  app.element("#exportJson").listeners.click();
  assert.equal(exported.sessions.length, 125);
  app.element("#sessionNext").listeners.click();
  assert.equal(app.element("#sessionPageSummary").textContent, "101–125 of 125 sessions");
  assert.equal(app.element("#sessionNext").disabled, true);
  app.element("#sessionPrevious").listeners.click();
  assert.equal(app.element("#sessionPageStatus").textContent, "Page 2 of 3");
});

test("chart granularity changes only redraw the chart and preserve the selected page", async () => {
  const app = await createApp(todaySessions(125));
  app.element("#sessionNext").listeners.click();
  const sessions = app.chartRenders[0].sessions;
  const total = app.element("#totalTokens").textContent;
  app.granularityButtons.hour.listeners.click();
  assert.equal(app.chartRenders.length, 2);
  assert.equal(app.chartRenders[1].granularity, "hour");
  assert.strictEqual(app.chartRenders[1].sessions, sessions);
  assert.equal(app.renders.length, 2);
  assert.equal(app.element("#sessionPageStatus").textContent, "Page 2 of 3");
  assert.equal(app.element("#totalTokens").textContent, total);
  assert.equal(app.requests.length, 1);
});

test("selecting the active chart granularity skips redundant rendering", async () => {
  const app = await createApp();
  app.granularityButtons.day.listeners.click();
  assert.equal(app.chartRenders.length, 1);
  app.granularityButtons.hour.listeners.click();
  app.granularityButtons.hour.listeners.click();
  assert.equal(app.chartRenders.length, 2);
  assert.equal(app.renders.length, 1);
});

test("chart changes apply pending search once before reusing filtered sessions", async () => {
  const app = await createApp(todaySessions(125));
  app.element("#sessionNext").listeners.click();
  app.element("#searchInput").listeners.input({ target: { value: "Session 12" } });
  app.granularityButtons.hour.listeners.click();
  assert.equal(app.timeouts.size, 0);
  assert.equal(app.chartRenders.length, 2);
  assert.equal(app.chartRenders[1].sessions.length, 6);
  assert.equal(app.renders.length, 3);
  assert.equal(app.element("#sessionPageStatus").textContent, "Page 1 of 1");
  app.granularityButtons.day.listeners.click();
  assert.strictEqual(app.chartRenders[2].sessions, app.chartRenders[1].sessions);
  assert.equal(app.renders.length, 3);
});

test("selecting the active chart granularity still flushes pending search", async () => {
  const app = await createApp();
  app.element("#searchInput").listeners.input({ target: { value: "Project A&B" } });
  app.granularityButtons.day.listeners.click();
  assert.equal(app.timeouts.size, 0);
  assert.equal(app.chartRenders.length, 2);
  assert.equal(app.chartRenders[1].sessions.length, 1);
  assert.equal(app.renders.length, 2);
});

test("filtering resets pagination and empty results disable both page controls", async () => {
  const app = await createApp(todaySessions(125));
  app.element("#sessionNext").listeners.click();
  app.element("#searchInput").listeners.input({ target: { value: "Session 12" } });
  const [timer] = app.timeouts.values();
  timer.callback();
  assert.equal(app.element("#sessionPageStatus").textContent, "Page 1 of 1");
  assert.equal(app.element("#sessionPageSummary").textContent, "1–6 of 6 sessions");
  app.element("#searchInput").listeners.input({ target: { value: "missing" } });
  const [emptyTimer] = app.timeouts.values();
  emptyTimer.callback();
  assert.equal(app.element("#sessionPageSummary").textContent, "0 sessions");
  assert.equal(app.element("#sessionPrevious").disabled, true);
  assert.equal(app.element("#sessionNext").disabled, true);
  app.element("#clearFilters").listeners.click();
  assert.equal(app.element("#sessionPageSummary").textContent, "1–50 of 125 sessions");
});

test("refresh preserves the page and clamps it when sessions disappear", async () => {
  const sessions = todaySessions(125);
  const app = await createApp(sessions);
  app.element("#sessionNext").listeners.click();
  app.element("#sessionNext").listeners.click();
  await vm.runInContext("loadRealUsage()", app.context);
  assert.equal(app.element("#sessionPageStatus").textContent, "Page 3 of 3");
  sessions.splice(20);
  await vm.runInContext("loadRealUsage()", app.context);
  assert.equal(app.element("#sessionPageStatus").textContent, "Page 1 of 1");
  assert.equal(app.element("#sessionPageSummary").textContent, "1–20 of 20 sessions");
});

test("paging applies pending search filters instead of displaying stale results", async () => {
  const app = await createApp(todaySessions(125));
  app.element("#searchInput").listeners.input({ target: { value: "missing" } });
  app.element("#sessionNext").listeners.click();
  assert.equal(app.timeouts.size, 0);
  assert.equal(app.element("#sessionPageSummary").textContent, "0 sessions");
  assert.equal(app.element("#sessionPageStatus").textContent, "Page 1 of 1");
});

test("failed refresh disables pagination until a successful retry", async () => {
  const app = await createApp(todaySessions(125));
  app.element("#sessionNext").listeners.click();
  const originalFetch = app.context.fetch;
  app.context.fetch = async () => { throw new Error("fixture offline"); };
  await vm.runInContext("loadRealUsage()", app.context);
  assert.equal(app.element("#sessionPageSummary").textContent, "Sessions unavailable");
  assert.equal(app.element("#sessionPrevious").disabled, true);
  assert.equal(app.element("#sessionNext").disabled, true);
  const renders = app.renders.length;
  app.element("#sessionPrevious").listeners.click();
  app.element("#clearFilters").listeners.click();
  assert.equal(app.renders.length, renders);
  assert.match(app.element("#sessionTable").innerHTML, /Connection failed/);
  app.context.fetch = originalFetch;
  await vm.runInContext("loadRealUsage()", app.context);
  assert.equal(app.element("#sessionPageSummary").textContent, "51–100 of 125 sessions");
  assert.equal(app.element("#sessionNext").disabled, false);
});

function todaySessions(count) {
  const today = new Date();
  today.setHours(8, 0, 0, 0);
  return Array.from({ length: count }, (unused, index) => ({ id: `session-${index}`, name: `Session ${index}`, model: "test-model", startedAt: today.toISOString(), updatedAt: new Date(today.getTime() + index * 1000).toISOString(), input: 10, output: 5, total: 15 }));
}

async function createApp(suppliedSessions) {
  const elements = new Map();
  function element(selector) {
    if (!elements.has(selector)) {
      const node = {
        listeners: {}, value: "", textContent: "", dataset: {}, style: { setProperty() {} },
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        lastChild: { textContent: "" }, lastElementChild: { textContent: "" },
        html: "", htmlWrites: 0,
        get innerHTML() { return this.html; },
        set innerHTML(value) { this.html = value; this.htmlWrites += 1; },
        addEventListener(name, callback) { this.listeners[name] = callback; },
        querySelector: element, querySelectorAll() { return []; }, setAttribute() {}, append() {}, click() {}, remove() {}
      };
      elements.set(selector, node);
    }
    return elements.get(selector);
  }
  const granularityButtons = {
    day: element('[data-granularity="day"]'),
    hour: element('[data-granularity="hour"]')
  };
  for (const [granularity, button] of Object.entries(granularityButtons)) button.dataset.granularity = granularity;
  const document = {
    hidden: false, listeners: {}, body: element("body"), querySelector: element,
    querySelectorAll(selector) { return selector === ".granularity-btn" ? Object.values(granularityButtons) : []; }, createElement: element,
    addEventListener(name, callback) { this.listeners[name] = callback; }
  };
  const requests = [];
  const renders = [];
  const chartRenders = [];
  const timeouts = new Map();
  const intervals = [];
  const prompts = [];
  let nextTimer = 0;
  const today = new Date();
  today.setHours(8, 0, 0, 0);
  const sessions = suppliedSessions || [
    { id: "older", name: "Project A&B", model: "luna", startedAt: today.toISOString(), updatedAt: today.toISOString(), input: 10, output: 5, total: 15 },
    { id: "newer", name: "Second project", model: "sol", startedAt: today.toISOString(), updatedAt: new Date(today.getTime() + 1000).toISOString(), input: 20, output: 10, total: 30 }
  ];
  const context = vm.createContext({
    document, console, URL, URLSearchParams, Blob, Date,
    window: { location: { search: "", href: "http://127.0.0.1:4173/" } },
    navigator: { userAgent: "fixture-browser/1", clipboard: null },
    sessionStorage: { getItem() { return "fixture-api-token"; } }, localStorage: { getItem() { return null; }, setItem() {} },
    prompt() { return prompts.shift(); }, alert() {},
    setTimeout(callback, delay) { const timer = ++nextTimer; timeouts.set(timer, { callback, delay }); return timer; },
    clearTimeout(timer) { timeouts.delete(timer); },
    setInterval(callback, delay) { intervals.push({ callback, delay }); },
    TokenLensData: data,
    TokenLensChart: { render(options) { chartRenders.push(options); }, renderMiniBars() {} },
    TokenLensTable: { render(options) { renders.push(options); return table.paginate(options.sessions, options.page); }, emptyRow: table.emptyRow },
    TokenLensNotifications: { renderAlerts() {}, requestPermission() {} },
    async fetch(url, options) {
      requests.push({ url, options });
      const payload = url === "/api/usage"
        ? { sessions, available: true, sessionCount: sessions.length, scannedAt: today.toISOString(), source: "fixture", rateLimits: null }
        : { ok: true, sessions: [], gistId: "abc123", gistUrl: "https://gist.github.com/fixture/abc123", importedCount: 0 };
      return { ok: true, async json() { return payload; } };
    }
  });
  vm.runInContext(source, context, { filename: "app.js" });
  await flush();
  assert.equal(vm.runInContext("state.error", context), null);
  return { context, document, element, requests, renders, chartRenders, timeouts, intervals, prompts, granularityButtons };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}
