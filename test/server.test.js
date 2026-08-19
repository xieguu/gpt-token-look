const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");

test("serves aggregated usage, pricing estimate, and primary/secondary limits", { timeout: 15000 }, async (context) => {
  const fixture = createFixture(context);
  const sessionId = "anonymous-session-001";
  writeSession(fixture, sessionId, [
    event("2026-07-28T01:00:00.000Z", "session_meta", { id: sessionId, timestamp: "2026-07-28T01:00:00.000Z", cwd: path.join(fixture.root, "example-project") }),
    event("2026-07-28T01:00:01.000Z", "turn_context", { model: "gpt-5.6-luna", cwd: path.join(fixture.root, "example-project") }),
    event("2026-07-28T01:00:02.000Z", "event_msg", {
      type: "token_count",
      info: { total_token_usage: {
        input_tokens: 1200,
        cached_input_tokens: 800,
        cache_write_input_tokens: 0,
        output_tokens: 300,
        reasoning_output_tokens: 50,
        total_tokens: 1500
      } },
      rate_limits: {
        primary: { used_percent: 12, window_minutes: 300, resets_at: 1785210000 },
        secondary: { used_percent: 34, window_minutes: 10080, resets_at: 1785800000 }
      }
    })
  ]);
  fs.writeFileSync(path.join(fixture.codexHome, "session_index.jsonl"), `${JSON.stringify({ id: sessionId, thread_name: "Anonymous test session", updated_at: "2026-07-28T01:00:02.000Z" })}\n`);

  const data = await fetchUsage(fixture);
  assert.equal(data.source, "$CODEX_HOME/sessions");
  assert.equal(data.available, true);
  assert.equal(data.sessionCount, 1);
  assert.equal(data.sessions[0].name, "Anonymous test session");
  assert.equal(data.sessions[0].model, "gpt-5.6-luna");
  assert.equal(data.sessions[0].input, 1200);
  assert.equal(data.sessions[0].cachedInput, 800);
  assert.equal(data.sessions[0].output, 300);
  assert.equal(data.sessions[0].reasoningOutput, 50);
  assert.equal(data.sessions[0].total, 1500);
  assert.equal(data.rateLimits.primary.used_percent, 12);
  assert.equal(data.rateLimits.secondary.used_percent, 34);
  assert.equal(data.sessions[0].costBreakdown.estimated, true);
  assert.equal(data.sessions[0].costBreakdown.modelMatched, "GPT-5.6 Luna");
  assert.equal(Number(data.sessions[0].costUsd.toFixed(6)), 0.000456);
  assert.equal(Number(data.costSummary.totalUsd.toFixed(6)), 0.000456);
  assert.equal(data.costSummary.unpricedSessionCount, 0);
  assert.ok(data.pricing.models.some((item) => item.label === "GPT-5.6 Luna"));
  assert.ok(fs.readdirSync(fixture.cacheDir).some((name) => name.startsWith("usage-")));
});

test("ignores corrupt and empty jsonl files without failing", { timeout: 15000 }, async (context) => {
  const fixture = createFixture(context);
  fs.writeFileSync(path.join(fixture.sessionDir, "empty.jsonl"), "");
  fs.writeFileSync(path.join(fixture.sessionDir, "corrupt.jsonl"), "{not-json\n");

  const data = await fetchUsage(fixture);
  assert.equal(data.available, true);
  assert.equal(data.sessionCount, 0);
  assert.deepEqual(data.sessions, []);
  assert.equal(data.costSummary.totalUsd, 0);
  assert.equal(data.rateLimits, null);
});

test("returns available=false when Codex sessions directory is missing", { timeout: 15000 }, async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "token-lens-test-"));
  const fixture = {
    root,
    codexHome: path.join(root, ".codex"),
    cacheDir: path.join(root, "cache")
  };
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const data = await fetchUsage(fixture);
  assert.equal(data.available, false);
  assert.equal(data.sessionCount, 0);
  assert.deepEqual(data.sessions, []);
});

async function fetchUsage(fixture) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    windowsHide: true,
    env: {
      ...process.env,
      CODEX_HOME: fixture.codexHome,
      TOKEN_LENS_CACHE_DIR: fixture.cacheDir,
      TOKEN_LENS_PORT: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    const url = await waitForUrl(child);
    const response = await fetch(`${url}/api/usage`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Codex Token Lens/);
    return await response.json();
  } finally {
    if (!child.killed) child.kill();
  }
}

function createFixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "token-lens-test-"));
  const codexHome = path.join(root, ".codex");
  const sessionDir = path.join(codexHome, "sessions", "2026", "07", "28");
  const cacheDir = path.join(root, "cache");
  fs.mkdirSync(sessionDir, { recursive: true });
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, codexHome, sessionDir, cacheDir };
}

function writeSession(fixture, sessionId, events) {
  fs.writeFileSync(path.join(fixture.sessionDir, `rollout-${sessionId}.jsonl`), `${events.map((item) => JSON.stringify(item)).join("\n")}\n`);
}

function event(timestamp, type, payload) {
  return { timestamp, type, payload };
}

function waitForUrl(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`Server startup timed out.\n${stderr}`)), 10000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited before startup with code ${code}.\n${stderr}`));
    });
  });
}
