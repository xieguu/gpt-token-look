const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { createSessionsService } = require("../sessions");

test("unchanged scans reuse parsed sessions without rewriting the disk cache", async (context) => {
  const fixture = createFixture(context);
  writeSession(fixture, "first");
  writeSession(fixture, "second");
  const service = createSessionsService(fixture.options);
  const first = await service.scan();
  const cachePath = path.join(fixture.cacheDir, fs.readdirSync(fixture.cacheDir)[0]);
  fs.utimesSync(cachePath, new Date(1000), new Date(1000));
  const previousMtime = fs.statSync(cachePath).mtimeMs;
  const second = await service.scan();

  assert.equal(fs.statSync(cachePath).mtimeMs, previousMtime);
  assert.strictEqual(second.sessions, first.sessions);
  assert.equal(first.diagnostics.summaryReused, false);
  assert.equal(second.diagnostics.summaryReused, true);
  assert.equal(first.diagnostics.parsedFileCount, 2);
  assert.equal(first.diagnostics.cacheWritten, true);
  assert.equal(second.diagnostics.parsedFileCount, 0);
  assert.equal(second.diagnostics.cachedFileCount, 2);
  assert.equal(second.diagnostics.cacheWritten, false);

  const restarted = await createSessionsService(fixture.options).scan();
  assert.equal(restarted.diagnostics.parsedFileCount, 0);
  assert.equal(restarted.diagnostics.cachedFileCount, 2);
  assert.equal(restarted.diagnostics.cacheWritten, false);
  assert.equal(restarted.diagnostics.summaryReused, false);
  assert.deepEqual(restarted.sessions, first.sessions);
});

test("summary caching follows title creation, changes, and removal", async (context) => {
  const fixture = createFixture(context);
  writeSession(fixture, "retitled");
  const indexPath = path.join(fixture.codexDir, "session_index.jsonl");
  const service = createSessionsService(fixture.options);
  const original = await service.scan();
  let previous = original;
  for (const title of ["First title", "Updated title"]) {
    fs.writeFileSync(indexPath, `${JSON.stringify({ id: "retitled", thread_name: title })}\n`);
    const changed = await service.scan();
    assert.equal(changed.sessions[0].name, title);
    assert.equal(changed.diagnostics.parsedFileCount, 0);
    assert.equal(changed.diagnostics.summaryReused, false);
    assert.notStrictEqual(changed.sessions, previous.sessions);
    const unchanged = await service.scan();
    assert.strictEqual(unchanged.sessions, changed.sessions);
    assert.equal(unchanged.diagnostics.summaryReused, true);
    previous = changed;
  }
  fs.unlinkSync(indexPath);
  const removed = await service.scan();
  assert.deepEqual(removed.sessions, original.sessions);
  assert.equal(removed.diagnostics.summaryReused, false);
  assert.strictEqual((await service.scan()).sessions, removed.sessions);
});

test("summary caching refreshes rate limits and parse errors when files disappear", async (context) => {
  const fixture = createFixture(context);
  writeSession(fixture, "usage");
  const limitsPath = path.join(fixture.sessionsDir, "limits.jsonl");
  fs.writeFileSync(limitsPath, `${JSON.stringify({
    timestamp: "2026-09-20T10:00:00.000Z", type: "event_msg",
    payload: { type: "token_count", rate_limits: { primary: { used_percent: 25 } } }
  })}\n{"type":"token_count"\n`);
  context.mock.method(console, "warn", () => {});
  const service = createSessionsService(fixture.options);
  const original = await service.scan();
  assert.equal(original.latestRateLimits.primary.used_percent, 25);
  assert.equal(original.diagnostics.parseErrorCount, 1);
  const unchanged = await service.scan();
  assert.strictEqual(unchanged.sessions, original.sessions);
  assert.strictEqual(unchanged.latestRateLimits, original.latestRateLimits);
  assert.equal(unchanged.diagnostics.parseErrorCount, 1);
  fs.unlinkSync(limitsPath);
  const removed = await service.scan();
  assert.equal(removed.latestRateLimits, null);
  assert.equal(removed.latestRateLimitsUpdatedAt, null);
  assert.equal(removed.diagnostics.parseErrorCount, 0);
  assert.equal(removed.diagnostics.summaryReused, false);
});

test("empty summaries stay cached while directory availability remains current", async (context) => {
  const fixture = createFixture(context);
  const service = createSessionsService(fixture.options);
  const original = await service.scan();
  fs.rmdirSync(fixture.sessionsDir);
  const missing = await service.scan();
  assert.equal(missing.available, false);
  assert.strictEqual(missing.sessions, original.sessions);
  assert.equal(missing.diagnostics.summaryReused, true);
  fs.mkdirSync(fixture.sessionsDir);
  const restored = await service.scan();
  assert.equal(restored.available, true);
  assert.strictEqual(restored.sessions, original.sessions);
});

test("changed and deleted files invalidate only their own cache entries", async (context) => {
  const fixture = createFixture(context);
  writeSession(fixture, "changed");
  writeSession(fixture, "unchanged");
  const service = createSessionsService(fixture.options);
  await service.scan();
  fs.appendFileSync(path.join(fixture.sessionsDir, "changed.jsonl"), `${JSON.stringify(tokenEvent(75))}\n`);

  const changed = await service.scan();
  assert.equal(changed.sessions.find((session) => session.id === "changed").total, 75);
  assert.equal(changed.diagnostics.parsedFileCount, 1);
  assert.equal(changed.diagnostics.cachedFileCount, 1);
  assert.equal(changed.diagnostics.summaryReused, false);
  assert.strictEqual((await service.scan()).sessions, changed.sessions);

  fs.unlinkSync(path.join(fixture.sessionsDir, "changed.jsonl"));
  const removed = await service.scan();
  assert.deepEqual(removed.sessions.map((session) => session.id), ["unchanged"]);
  assert.equal(removed.diagnostics.parsedFileCount, 0);
  assert.equal(removed.diagnostics.cacheWritten, true);
  assert.equal(removed.diagnostics.summaryReused, false);
  const cachePath = path.join(fixture.cacheDir, fs.readdirSync(fixture.cacheDir)[0]);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(cachePath, "utf8")).files).length, 1);
});

test("concurrent scans share one in-flight operation", async (context) => {
  const fixture = createFixture(context);
  writeSession(fixture, "shared");
  const service = createSessionsService(fixture.options);
  const first = service.scan();
  const second = service.scan();
  const results = await Promise.all([first, second]);
  assert.strictEqual(first, second);
  assert.strictEqual(results[0], results[1]);
});

test("full-session reads work before a usage scan and use the latest model", async (context) => {
  const fixture = createFixture(context);
  writeSession(fixture, "cold-start");
  fs.appendFileSync(path.join(fixture.sessionsDir, "cold-start.jsonl"), `${JSON.stringify({ type: "turn_context", payload: { model: "changed-model" } })}\n`);
  const service = createSessionsService(fixture.options);
  const result = await service.readSessionFull("cold-start");
  assert.equal(result?.sessionId, "cold-start");
  assert.equal(result.model, "changed-model");
  assert.equal(result.events.length, 4);
  assert.equal(await service.readSessionFull("__proto__"), null);
  assert.equal(await service.readSessionFull("constructor"), null);
});

test("rate-limit-only sessions still provide the latest snapshot", async (context) => {
  const fixture = createFixture(context);
  writeSession(fixture, "usage");
  const timestamp = "2026-09-20T10:00:00.000Z";
  fs.writeFileSync(path.join(fixture.sessionsDir, "limits.jsonl"), `${JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: { type: "token_count", info: null, rate_limits: { primary: { used_percent: 25 } } }
  })}\n`);
  const result = await createSessionsService(fixture.options).scan();
  assert.equal(result.sessionCount, 1);
  assert.equal(result.latestRateLimits?.primary.used_percent, 25);
  assert.equal(result.latestRateLimitsUpdatedAt, timestamp);
});

test("title changes refresh independently of session parsing", async (context) => {
  const fixture = createFixture(context);
  writeSession(fixture, "renamed");
  const indexPath = path.join(fixture.codexDir, "session_index.jsonl");
  fs.writeFileSync(indexPath, `${JSON.stringify({ id: "renamed", thread_name: "Original" })}\n`);
  const service = createSessionsService(fixture.options);
  assert.equal((await service.scan()).sessions[0].name, "Original");
  fs.appendFileSync(indexPath, `${JSON.stringify({ id: "renamed", thread_name: "Updated title" })}\n`);
  const result = await service.scan();
  assert.equal(result.sessions[0].name, "Updated title");
  assert.equal(result.diagnostics.parsedFileCount, 0);
  assert.equal(result.diagnostics.cacheWritten, false);
});

test("zero cache TTL forces parsing on every scan", async (context) => {
  const fixture = createFixture(context);
  writeSession(fixture, "uncached");
  const service = createSessionsService({ ...fixture.options, cacheTtlMs: 0 });
  await service.scan();
  const result = await service.scan();
  assert.equal(result.diagnostics.cacheExpired, true);
  assert.equal(result.diagnostics.parsedFileCount, 1);
  assert.equal(result.diagnostics.cachedFileCount, 0);
  assert.equal(result.diagnostics.summaryReused, false);
});

test("streaming reads preserve CRLF, split UTF-8, and an unterminated final event", async (context) => {
  const fixture = createFixture(context);
  const sessionId = "streaming";
  const title = "中文标题😀";
  const events = [
    { type: "session_meta", payload: { id: sessionId } },
    { type: "response_item", payload: { type: "message", content: title.repeat(10000) } },
    { type: "turn_context", payload: { model: "中文模型" } },
    tokenEvent(125)
  ];
  fs.writeFileSync(path.join(fixture.sessionsDir, `${sessionId}.jsonl`), events.map((event) => JSON.stringify(event)).join("\r\n\r\n"));
  fs.writeFileSync(path.join(fixture.codexDir, "session_index.jsonl"), JSON.stringify({ id: sessionId, thread_name: title }));
  const service = createSessionsService(fixture.options);
  const usage = await service.scan();
  assert.equal(usage.sessions[0].name, title);
  assert.equal(usage.sessions[0].model, "中文模型");
  assert.equal(usage.sessions[0].total, 125);
  assert.equal(usage.diagnostics.parseErrorCount, 0);
  const exported = await service.readSessionFull(sessionId);
  assert.deepEqual(exported.events, events);
  assert.equal(exported.title, title);
});

test("failed session streams reject the scan and are never cached", async (context) => {
  const fixture = createFixture(context);
  writeSession(fixture, "failed");
  const service = createSessionsService(fixture.options);
  const failure = Object.assign(new Error("fixture session read failed"), { code: "EIO" });
  const mocked = context.mock.method(fs, "createReadStream", () => Readable.from((async function* () {
    yield `${JSON.stringify(tokenEvent(999))}\n`;
    throw failure;
  })()));
  await assert.rejects(service.scan(), failure);
  assert.equal(fs.existsSync(fixture.cacheDir), false);
  mocked.mock.restore();
  const result = await service.scan();
  assert.equal(result.sessions[0].total, 15);
  assert.equal(result.diagnostics.parsedFileCount, 1);
});

test("failed title streams do not replace the title cache", async (context) => {
  const fixture = createFixture(context);
  writeSession(fixture, "title");
  const indexPath = path.join(fixture.codexDir, "session_index.jsonl");
  fs.writeFileSync(indexPath, JSON.stringify({ id: "title", thread_name: "Original" }));
  const service = createSessionsService(fixture.options);
  await service.scan();
  fs.appendFileSync(indexPath, `\n${JSON.stringify({ id: "title", thread_name: "Updated title" })}\n`);
  const failure = Object.assign(new Error("fixture title read failed"), { code: "EIO" });
  const mocked = context.mock.method(fs, "createReadStream", () => Readable.from((async function* () { throw failure; })()));
  await assert.rejects(service.scan(), failure);
  mocked.mock.restore();
  const result = await service.scan();
  assert.equal(result.sessions[0].name, "Updated title");
  assert.equal(result.diagnostics.parsedFileCount, 0);
});

test("full-session export propagates stream errors instead of returning partial events", async (context) => {
  const fixture = createFixture(context);
  writeSession(fixture, "export");
  const service = createSessionsService(fixture.options);
  await service.scan();
  const failure = Object.assign(new Error("fixture export read failed"), { code: "EIO" });
  context.mock.method(fs, "createReadStream", () => Readable.from((async function* () {
    yield `${JSON.stringify(tokenEvent(999))}\n`;
    throw failure;
  })()));
  await assert.rejects(service.readSessionFull("export"), failure);
});

function createFixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "token-lens-sessions-test-"));
  const codexDir = path.join(root, "codex");
  const sessionsDir = path.join(codexDir, "sessions");
  const cacheDir = path.join(root, "cache");
  fs.mkdirSync(sessionsDir, { recursive: true });
  context.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { codexDir, sessionsDir, cacheDir, options: { codexDir, cacheDir, cacheTtlMs: 60000, scanConcurrency: 3 } };
}

function writeSession(fixture, sessionId) {
  const events = [
    { type: "session_meta", payload: { id: sessionId, timestamp: "2026-09-20T08:00:00.000Z" } },
    { type: "turn_context", payload: { model: "test-model" } },
    tokenEvent(15)
  ];
  fs.writeFileSync(path.join(fixture.sessionsDir, `${sessionId}.jsonl`), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

function tokenEvent(total) {
  return { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: total - 5, output_tokens: 5, total_tokens: total } } } };
}
