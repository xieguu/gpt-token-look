const test = require("node:test");
const assert = require("node:assert/strict");

const data = require("../data.js");
const chart = require("../chart.js");
const table = require("../table.js");

const localIso = (day, hour, minute = 0) => new Date(2026, 7, day, hour, minute).toISOString();
const sessions = [
  { id: "late", name: "Late night", model: "luna", startedAt: localIso(24, 23, 30), updatedAt: localIso(24, 23, 35), input: 10, output: 5, total: 15 },
  { id: "today", name: "Morning", model: "sol", startedAt: localIso(25, 8), updatedAt: localIso(25, 8, 1), input: 20, output: 10, total: 30 }
];

test("uses local calendar dates instead of slicing UTC strings", () => {
  assert.equal(data.localDateFromSession({ startedAt: localIso(25, 0, 30) }), "2026-08-25");
});

test("filters by period, model, date range, and search", () => {
  const now = new Date(2026, 7, 25, 12);
  assert.equal(data.filterSessions(sessions, { period: "today" }, now)[0].id, "today");
  assert.equal(data.filterSessions(sessions, { period: "all" }, now).length, 2);
  assert.equal(data.filterSessions(sessions, { period: "all", modelFilter: "sol" }, now)[0].id, "today");
  assert.equal(data.filterSessions(sessions, { period: "all", dateFrom: "2026-08-25" }, now).length, 1);
  assert.equal(data.filterSessions(sessions, { period: "all", searchQuery: "late" }, now)[0].id, "late");
});

test("classifies limit freshness and source labels", () => {
  const now = Date.parse("2026-08-25T12:00:00.000Z");
  assert.equal(data.relativeTime(new Date(now - 2 * 60000).toISOString(), now).label, "更新于 2 分钟前");
  assert.equal(data.relativeTime(new Date(now - 7 * 60000).toISOString(), now).level, "aging");
  assert.equal(data.relativeTime(new Date(now - 31 * 60000).toISOString(), now).level, "stale");
  assert.deepEqual(data.rateLimitSource("codex-app-server"), { label: "官方实时数据", tone: "official" });
  assert.deepEqual(data.rateLimitSource("local-session-snapshot"), { label: "本地历史快照", tone: "snapshot" });
  assert.deepEqual(data.rateLimitSource("unavailable"), { label: "额度不可用", tone: "unavailable" });
});

test("refresh helper sends no-store request and returns API data", async () => {
  let request;
  const payload = { sessions: [], rateLimitsSource: "unavailable" };
  const fakeFetch = async (url, options) => {
    request = { url, options };
    return { ok: true, async json() { return payload; } };
  };
  assert.deepEqual(await data.fetchUsage(fakeFetch, "secret"), payload);
  assert.equal(request.url, "/api/usage");
  assert.equal(request.options.cache, "no-store");
  assert.equal(request.options.headers["x-token-lens-token"], "secret");
});

test("export helper creates CSV and JSON downloads with local filename", () => {
  const now = new Date(2026, 7, 25, 12);
  const filters = { period: "all" };
  const csv = data.serializeExport("csv", sessions, filters, now);
  assert.equal(csv.filename, "codex-token-lens-2026-08-25.csv");
  assert.match(csv.body, /date,name,model/);
  const json = data.serializeExport("json", sessions, filters, now);
  assert.equal(json.filename, "codex-token-lens-2026-08-25.json");
  assert.deepEqual(JSON.parse(json.body).filters, filters);
});

test("chart groups sessions by local day and table exposes an empty state", () => {
  const grouped = chart.groupByLocalDay(sessions);
  assert.equal(grouped.size, 2);
  const body = { innerHTML: "", querySelectorAll() { return []; } };
  table.render({ body, sessions: [], integer: new Intl.NumberFormat("en"), money: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }), escapeHtml: String, shorten: String, clipboard: null });
  assert.match(body.innerHTML, /colspan="7"/);
  assert.match(body.innerHTML, /No Codex sessions/);
});

test("pricing status reports stale and failed-update states", () => {
  const old = data.pricingStatus({ updatedAt: "2026-07-01T00:00:00.000Z" }, Date.parse("2026-08-25T00:00:00.000Z"));
  assert.equal(old.stale, true);
  const failed = data.pricingStatus({ updatedAt: "2026-08-25T00:00:00.000Z", usingOldPrices: true, updateError: "offline" }, Date.parse("2026-08-25T12:00:00.000Z"));
  assert.equal(failed.usingOldPrices, true);
  assert.equal(failed.stale, false);
  assert.equal(failed.updateError, "offline");
});
