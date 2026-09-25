const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { createSessionsService } = require("../sessions");

const fileCount = 8;
const eventsPerFile = 10000;
const runs = 5;

function usageLine(total) {
  return `${JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: total, output_tokens: 0, total_tokens: total } } } })}\n`;
}

function median(samples) {
  const sorted = [...samples].sort((first, second) => first - second);
  return Number(sorted[Math.floor(sorted.length / 2)].toFixed(2));
}

async function benchmark() {
  const temporaryDirectory = path.resolve(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporaryDirectory, "token-lens-benchmark-"));
  try {
    const codexDir = path.join(root, "codex");
    const cacheDir = path.join(root, "cache");
    const sessionsDir = path.join(codexDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const message = `${JSON.stringify({ type: "response_item", payload: { type: "message", content: "x".repeat(256) } })}\n`;
    let fixtureBytes = 0;
    for (let index = 0; index < fileCount; index++) {
      const metadata = `${JSON.stringify({ type: "session_meta", payload: { id: `session-${index}`, timestamp: "2026-01-01T00:00:00.000Z" } })}\n`;
      const content = metadata + message.repeat(eventsPerFile) + usageLine(100);
      fixtureBytes += Buffer.byteLength(content);
      await fs.writeFile(path.join(sessionsDir, `${index}.jsonl`), content);
    }

    const options = { codexDir, cacheDir, scanConcurrency: 3 };
    const coldService = createSessionsService({ ...options, cacheTtlMs: 0 });
    const cold = [];
    for (let run = 0; run < runs; run++) {
      const started = performance.now();
      const result = await coldService.scan();
      cold.push(performance.now() - started);
      assert.equal(result.sessionCount, fileCount);
      assert.equal(result.diagnostics.parsedFileCount, fileCount);
      assert.equal(result.diagnostics.summaryReused, false);
    }

    const cachedService = createSessionsService({ ...options, cacheTtlMs: 3600000 });
    const initial = await cachedService.scan();
    const warm = [];
    for (let run = 0; run < runs; run++) {
      const started = performance.now();
      const result = await cachedService.scan();
      warm.push(performance.now() - started);
      assert.equal(result.diagnostics.parsedFileCount, 0);
      assert.equal(result.diagnostics.cacheWritten, false);
      assert.equal(result.diagnostics.summaryReused, true);
      assert.strictEqual(result.sessions, initial.sessions);
    }

    const changed = [];
    for (let run = 0; run < runs; run++) {
      await fs.appendFile(path.join(sessionsDir, "0.jsonl"), usageLine(200 + run));
      const started = performance.now();
      const result = await cachedService.scan();
      changed.push(performance.now() - started);
      assert.equal(result.diagnostics.parsedFileCount, 1);
      assert.equal(result.diagnostics.summaryReused, false);
      assert.equal(result.sessions.find((session) => session.id === "session-0").total, 200 + run);
    }

    console.log(JSON.stringify({ node: process.version, files: fileCount, lines: fileCount * (eventsPerFile + 2), fixtureBytes, runs, coldMedianMs: median(cold), warmMedianMs: median(warm), changedMedianMs: median(changed) }, null, 2));
  } finally {
    if (path.dirname(root) !== temporaryDirectory || !path.basename(root).startsWith("token-lens-benchmark-")) throw new Error("Unexpected benchmark cleanup path");
    await fs.rm(root, { recursive: true, force: true });
  }
}

benchmark().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
