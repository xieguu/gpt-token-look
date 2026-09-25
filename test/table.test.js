const test = require("node:test");
const assert = require("node:assert/strict");
const table = require("../table");

test("pagination exposes every session without changing source order", () => {
  const sessions = Array.from({ length: 125 }, (unused, index) => session(index));
  const original = [...sessions];
  const pages = [1, 2, 3].map((page) => table.paginate(sessions, page));
  assert.deepEqual(pages.map((page) => page.rows.length), [50, 50, 25]);
  assert.deepEqual(pages.map((page) => [page.start, page.end]), [[1, 50], [51, 100], [101, 125]]);
  assert.deepEqual(pages.flatMap((page) => page.rows), sessions);
  assert.deepEqual(sessions, original);
  assert.ok(pages.every((page) => page.total === 125 && page.pageCount === 3));
});

test("pagination handles empty, exact-size, and out-of-range pages", () => {
  assert.deepEqual(table.paginate([], 5), { rows: [], page: 1, pageCount: 1, total: 0, start: 0, end: 0 });
  const sessions = Array.from({ length: 100 }, (unused, index) => session(index));
  for (const requested of [-1, 0, null, NaN, Infinity, 1.5]) assert.equal(table.paginate(sessions, requested).page, 1);
  assert.equal(table.paginate(sessions, 99).page, 2);
  assert.equal(table.paginate(sessions, 2).rows.length, 50);
});

test("table rendering uses only the selected page and keeps eight columns", () => {
  const sessions = Array.from({ length: 125 }, (unused, index) => session(index));
  const { body, pagination } = renderTable(sessions, { page: 3 });
  assert.equal(pagination.page, 3);
  assert.equal((body.innerHTML.match(/<tr>/g) || []).length, 25);
  assert.equal((body.innerHTML.match(/<td[ >]/g) || []).length, 25 * 8);
  assert.match(body.innerHTML, /data-session-id="session-100"/);
  assert.doesNotMatch(body.innerHTML, /data-session-id="session-0"/);
  assert.match(renderTable([]).body.innerHTML, /colspan="8"/);
});

test("pricing tooltips escape model names before inserting HTML attributes", () => {
  const item = { ...session(0), costBreakdown: { estimated: true, modelMatched: 'model" onmouseover="alert(1)', inputUsd: 0, cachedInputUsd: 0, outputUsd: 0 } };
  const { body } = renderTable([item]);
  assert.match(body.innerHTML, /model&quot; onmouseover=&quot;alert\(1\)/);
  assert.doesNotMatch(body.innerHTML, /" onmouseover="/);
});

test("copy uses the selected page, includes cache writes, and prevents duplicate clicks", async (context) => {
  const sessions = Array.from({ length: 51 }, (unused, index) => session(index));
  let complete;
  let copied;
  let writes = 0;
  let reset;
  context.mock.method(global, "setTimeout", (callback) => { reset = callback; });
  const clipboard = { writeText(text) { copied = text; writes += 1; return new Promise((resolve) => { complete = resolve; }); } };
  const { button } = renderTable(sessions, { page: 2, clipboard });
  const click = { stopPropagation() {} };
  const pending = button.onclick(click);
  assert.equal(button.disabled, true);
  await button.onclick(click);
  assert.equal(writes, 1);
  complete();
  await pending;
  assert.match(copied, /^Session: Session 50\n/);
  assert.match(copied, /Cache Write Input: 4\n/);
  assert.match(copied, /Total: 15\n/);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "✓");
  reset();
  assert.equal(button.textContent, "📋");
});

test("copy failures remain visible without unhandled rejections", async () => {
  const clipboard = { async writeText() { throw new Error("Permission denied"); } };
  const { button } = renderTable([session(0)], { clipboard });
  await assert.doesNotReject(button.onclick({ stopPropagation() {} }));
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "✗");
  assert.equal(button.title, "Copy failed: Permission denied");
});

test("unavailable clipboard reports an explicit failure", async () => {
  const { button } = renderTable([session(0)]);
  await button.onclick({ stopPropagation() {} });
  assert.equal(button.textContent, "✗");
  assert.match(button.title, /Clipboard is not available/);
});

function session(index) {
  return { id: `session-${index}`, name: `Session ${index}`, date: "2026-01-01", model: "test-model", input: 10, output: 5, cacheWriteInput: 4 };
}

function renderTable(sessions, options = {}) {
  const button = { dataset: { idx: "0" }, textContent: "📋", disabled: false };
  const body = { innerHTML: "", querySelectorAll() { return [button]; } };
  const integer = new Intl.NumberFormat("en");
  const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const escapeHtml = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("'", "&#39;");
  const pagination = table.render({ body, sessions, integer, money, escapeHtml, shorten: (value) => value, clipboard: null, ...options });
  return { body, button, pagination };
}
