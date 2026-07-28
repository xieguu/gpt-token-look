const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");

test("serves aggregated usage from an anonymous Codex fixture", { timeout: 15000 }, async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "token-lens-test-"));
  const codexHome = path.join(root, ".codex");
  const sessionDir = path.join(codexHome, "sessions", "2026", "07", "28");
  const cacheDir = path.join(root, "cache");
  fs.mkdirSync(sessionDir, { recursive: true });

  const sessionId = "anonymous-session-001";
  const events = [
    {
      timestamp: "2026-07-28T01:00:00.000Z",
      type: "session_meta",
      payload: {
        id: sessionId,
        timestamp: "2026-07-28T01:00:00.000Z",
        cwd: path.join(root, "example-project")
      }
    },
    {
      timestamp: "2026-07-28T01:00:01.000Z",
      type: "turn_context",
      payload: { model: "test-codex-model", cwd: path.join(root, "example-project") }
    },
    {
      timestamp: "2026-07-28T01:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 1200,
            cached_input_tokens: 800,
            cache_write_input_tokens: 0,
            output_tokens: 300,
            reasoning_output_tokens: 50,
            total_tokens: 1500
          }
        },
        rate_limits: {
          primary: {
            used_percent: 12,
            window_minutes: 300,
            resets_at: 1785210000
          }
        }
      }
    }
  ];

  fs.writeFileSync(
    path.join(sessionDir, `rollout-${sessionId}.jsonl`),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`
  );
  fs.writeFileSync(
    path.join(codexHome, "session_index.jsonl"),
    `${JSON.stringify({ id: sessionId, thread_name: "Anonymous test session", updated_at: "2026-07-28T01:00:02.000Z" })}\n`
  );

  const child = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    windowsHide: true,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      TOKEN_LENS_CACHE_DIR: cacheDir,
      TOKEN_LENS_PORT: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  context.after(() => {
    if (!child.killed) child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const url = await waitForUrl(child);
  const response = await fetch(`${url}/api/usage`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);

  const data = await response.json();
  assert.equal(data.source, "$CODEX_HOME/sessions");
  assert.equal(data.available, true);
  assert.equal(data.sessionCount, 1);
  assert.equal(data.sessions[0].name, "Anonymous test session");
  assert.equal(data.sessions[0].model, "test-codex-model");
  assert.equal(data.sessions[0].input, 1200);
  assert.equal(data.sessions[0].cachedInput, 800);
  assert.equal(data.sessions[0].output, 300);
  assert.equal(data.sessions[0].reasoningOutput, 50);
  assert.equal(data.sessions[0].total, 1500);
  assert.equal(data.rateLimits.primary.used_percent, 12);
  assert.ok(fs.readdirSync(cacheDir).some((name) => name.startsWith("usage-")));

  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Codex Token Lens/);
});

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
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited before startup with code ${code}.\n${stderr}`));
    });
  });
}
