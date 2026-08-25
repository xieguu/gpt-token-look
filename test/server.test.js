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
        cache_write_input_tokens: 100,
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
  assert.equal(data.sessions[0].cacheWriteInput, 100);
  assert.equal(data.sessions[0].output, 300);
  assert.equal(data.sessions[0].reasoningOutput, 50);
  assert.equal(data.sessions[0].total, 1500);
  assert.equal(data.rateLimits.primary.used_percent, 12);
  assert.equal(data.rateLimits.primary.remaining_percent, 88);
  assert.equal(data.rateLimits.secondary.used_percent, 34);
  assert.equal(data.rateLimits.secondary.remaining_percent, 66);
  assert.equal(data.sessions[0].costBreakdown.estimated, true);
  assert.equal(data.sessions[0].costBreakdown.modelMatched, "GPT-5.6 Luna");
  assert.equal(Number(data.sessions[0].costUsd.toFixed(6)), 0.002305);
  assert.equal(Number(data.sessions[0].costBreakdown.cacheWriteInputUsd.toFixed(6)), 0.000125);
  assert.equal(Number(data.costSummary.totalUsd.toFixed(6)), 0.002305);
  assert.equal(data.costSummary.unpricedSessionCount, 0);
  assert.equal(data.pricing.source, "https://platform.openai.com/pricing");
  assert.ok(data.pricing.models.some((item) => item.label === "GPT-5.6 Luna" && item.cacheWriteInput === 1.25));
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

test("marks unknown models as unpriced", { timeout: 15000 }, async (context) => {
  const fixture = createFixture(context);
  writeUsageSession(fixture, "anonymous-session-unknown", "custom-local-model", {
    input_tokens: 1000,
    output_tokens: 1000,
    total_tokens: 2000
  });

  const data = await fetchUsage(fixture);
  assert.equal(data.sessionCount, 1);
  assert.equal(data.sessions[0].costBreakdown.estimated, false);
  assert.equal(data.sessions[0].costUsd, 0);
  assert.equal(data.costSummary.estimatedSessionCount, 0);
  assert.equal(data.costSummary.unpricedSessionCount, 1);
});

test("honors custom pricing JSON", { timeout: 15000 }, async (context) => {
  const fixture = createFixture(context);
  writeUsageSession(fixture, "anonymous-session-custom", "custom-model", {
    input_tokens: 1000,
    cached_input_tokens: 200,
    cache_write_input_tokens: 100,
    output_tokens: 50,
    total_tokens: 1050
  });

  const data = await fetchUsage(fixture, {
    TOKEN_LENS_PRICES_JSON: JSON.stringify({
      models: [{ pattern: "custom-model", label: "Custom Model", input: 10, cachedInput: 1, cacheWriteInput: 20, output: 30 }]
    })
  });

  assert.equal(data.sessions[0].costBreakdown.estimated, true);
  assert.equal(data.sessions[0].costBreakdown.modelMatched, "Custom Model");
  assert.equal(Number(data.sessions[0].costUsd.toFixed(6)), 0.0107);
  assert.equal(data.pricing.models[0].label, "Custom Model");
});

test("accepts JSONL event type fields with whitespace", { timeout: 15000 }, async (context) => {
  const fixture = createFixture(context);
  const sessionId = "anonymous-session-spaced";
  const events = [
    event("2026-07-28T01:00:00.000Z", "session_meta", { id: sessionId, timestamp: "2026-07-28T01:00:00.000Z", cwd: path.join(fixture.root, "example-project") }),
    event("2026-07-28T01:00:01.000Z", "turn_context", { model: "gpt-5.6-luna" }),
    event("2026-07-28T01:00:02.000Z", "event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } })
  ];
  const spaced = events.map((item) => JSON.stringify(item).replaceAll('"type":"', '"type": "')).join("\n");
  fs.writeFileSync(path.join(fixture.sessionDir, `${sessionId}.jsonl`), `${spaced}\n`);

  const data = await fetchUsage(fixture);
  assert.equal(data.sessionCount, 1);
  assert.equal(data.sessions[0].model, "gpt-5.6-luna");
  assert.equal(data.sessions[0].total, 15);
});

test("falls back when the configured pricing file is missing", { timeout: 15000 }, async (context) => {
  const fixture = createFixture(context);
  const data = await fetchUsage(fixture, {
    TOKEN_LENS_PRICING_FILE: path.join(fixture.root, "missing-pricing.json")
  });
  assert.ok(data.pricing.models.length > 0);
});

test("exposes configurable cache TTL and scan concurrency diagnostics", { timeout: 15000 }, async (context) => {
  const fixture = createFixture(context);
  const data = await fetchUsage(fixture, {
    TOKEN_LENS_CACHE_TTL: "2m",
    TOKEN_LENS_SCAN_CONCURRENCY: "7"
  });
  assert.equal(data.diagnostics.cacheTtlMs, 120000);
  assert.equal(data.diagnostics.scanConcurrency, 7);
  assert.equal(data.diagnostics.cacheExpired, true);
});

test("optionally protects the usage API with a token", { timeout: 15000 }, async (context) => {
  const fixture = createFixture(context);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    windowsHide: true,
    env: {
      ...process.env,
      CODEX_HOME: fixture.codexHome,
      TOKEN_LENS_CACHE_DIR: fixture.cacheDir,
      TOKEN_LENS_PORT: "0",
      TOKEN_LENS_OFFICIAL_USAGE: "0",
      TOKEN_LENS_API_TOKEN: "test-token"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    const url = await waitForUrl(child);
    assert.equal((await fetch(`${url}/api/usage`)).status, 401);
    assert.equal((await fetch(`${url}/api/usage`, { headers: { "x-token-lens-token": "test-token" } })).status, 200);
  } finally {
    if (!child.killed) child.kill();
  }
});

test("returns 400 for malformed static paths without stopping the server", { timeout: 15000 }, async (context) => {
  const fixture = createFixture(context);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    windowsHide: true,
    env: { ...process.env, CODEX_HOME: fixture.codexHome, TOKEN_LENS_CACHE_DIR: fixture.cacheDir, TOKEN_LENS_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    const url = await waitForUrl(child);
    const malformed = await fetch(`${url}/%E0%A4%A`);
    assert.equal(malformed.status, 400);
    const home = await fetch(url);
    assert.equal(home.status, 200);
  } finally {
    if (!child.killed) child.kill();
  }
});

test("reports local snapshot as the rate-limit source when official lookup is disabled", { timeout: 15000 }, async (context) => {
  const fixture = createFixture(context);
  writeSession(fixture, "anonymous-session-limit-source", [
    event("2026-07-28T01:00:00.000Z", "session_meta", { id: "anonymous-session-limit-source" }),
    event("2026-07-28T01:00:01.000Z", "event_msg", {
      type: "token_count",
      info: { total_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
      rate_limits: { limit_id: "codex", primary: { used_percent: 42, window_minutes: 300, resets_at: 1785210000 }, secondary: null }
    })
  ]);
  const data = await fetchUsage(fixture);
  assert.equal(data.rateLimitsSource, "local-session-snapshot");
  assert.equal(data.rateLimits.primary.used_percent, 42);
  assert.equal(data.rateLimits.primary.remaining_percent, 58);
  assert.equal(data.officialQuery.attempted, false);
});

test("uses the official app-server snapshot when available", { timeout: 15000 }, async (context) => {
  const fixture = createFixture(context);
  const fakeCodex = path.join(fixture.root, "fake-codex.js");
  fs.writeFileSync(fakeCodex, `
    const readline = require("node:readline");
    const lines = readline.createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\\n");
      if (message.id === 2) process.stdout.write(JSON.stringify({ id: 2, result: { rateLimits: { limitId: "codex", primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 1785210000 }, secondary: null } } }) + "\\n");
      if (message.id === 3) process.stdout.write(JSON.stringify({ id: 3, result: { summary: { lifetimeTokens: 12345, peakDailyTokens: 6789 }, dailyUsageBuckets: [] } }) + "\\n");
    });
  `);
  const data = await fetchUsage(fixture, {
    TOKEN_LENS_OFFICIAL_USAGE: "auto",
    TOKEN_LENS_CODEX_COMMAND: process.execPath,
    TOKEN_LENS_CODEX_ARGS_JSON: JSON.stringify([fakeCodex]),
    TOKEN_LENS_OFFICIAL_TIMEOUT_MS: "3000"
  });
  assert.equal(data.rateLimitsSource, "codex-app-server");
  assert.equal(data.rateLimits.primary.used_percent, 7);
  assert.equal(data.rateLimits.primary.remaining_percent, 93);
  assert.equal(data.accountUsage.summary.lifetimeTokens, 12345);
  assert.equal(data.officialQuery.available, true);
});

async function fetchUsage(fixture, extraEnv = {}) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    windowsHide: true,
    env: {
      ...process.env,
      CODEX_HOME: fixture.codexHome,
      TOKEN_LENS_CACHE_DIR: fixture.cacheDir,
      TOKEN_LENS_PORT: "0",
      TOKEN_LENS_OFFICIAL_USAGE: "0",
      ...extraEnv
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
    const html = await page.text();
    assert.match(html, /Codex Token Lens/);
    assert.match(html, /Export CSV/);
    assert.match(html, /data-period="today"/);
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

function writeUsageSession(fixture, sessionId, model, usage) {
  writeSession(fixture, sessionId, [
    event("2026-07-28T01:00:00.000Z", "session_meta", { id: sessionId, timestamp: "2026-07-28T01:00:00.000Z", cwd: path.join(fixture.root, "example-project") }),
    event("2026-07-28T01:00:01.000Z", "turn_context", { model, cwd: path.join(fixture.root, "example-project") }),
    event("2026-07-28T01:00:02.000Z", "event_msg", { type: "token_count", info: { total_token_usage: usage } })
  ]);
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
