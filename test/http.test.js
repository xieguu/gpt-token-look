const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const http = require("node:http");

const projectRoot = path.resolve(__dirname, "..");

test("Gist routes wait for their result instead of falling through to 405", { timeout: 15000 }, async (context) => {
  const { url } = await startServer(context);
  for (const [route, payload] of [
    ["upload-gist", { githubToken: "fixture-token" }],
    ["download-gist", { gistId: "abc123" }]
  ]) {
    const response = await fetch(`${url}/api/sync/${route}`, { method: "POST", body: JSON.stringify(payload) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  }
  assert.equal((await fetch(`${url}/api/usage`)).status, 200);
});

test("Gist routes reject malformed and oversized JSON without stopping the server", { timeout: 15000 }, async (context) => {
  const { url } = await startServer(context);
  for (const route of ["upload-gist", "download-gist"]) {
    for (const body of ["{invalid", "null", "[]", "{}", ""]) {
      const response = await fetch(`${url}/api/sync/${route}`, { method: "POST", body });
      assert.equal(response.status, 400, `${route}: ${body}`);
      assert.ok((await response.json()).error);
    }
    const oversized = await fetch(`${url}/api/sync/${route}`, { method: "POST", body: JSON.stringify({ padding: "x".repeat(70 * 1024) }) });
    assert.equal(oversized.status, 413);
  }
  assert.equal((await fetch(`${url}/api/usage`)).status, 200);
});

test("Gist failures are reported as upstream errors", { timeout: 15000 }, async (context) => {
  const { url } = await startServer(context);
  const response = await fetch(`${url}/api/sync/upload-gist`, { method: "POST", body: JSON.stringify({ githubToken: "reject-upstream" }) });
  assert.equal(response.status, 502);
  assert.match((await response.json()).detail, /fixture upstream failure/);
});

test("chunked JSON preserves split UTF-8 characters and enforces the size limit", { timeout: 15000 }, async (context) => {
  const { url } = await startServer(context);
  const body = Buffer.from(JSON.stringify({ githubToken: "fixture-token", deviceName: "测试设备" }));
  const response = await postChunks(`${url}/api/sync/upload-gist`, Array.from(body, (byte) => Buffer.from([byte])));
  assert.equal(response.status, 200);
  assert.equal(response.data.deviceName, "测试设备");
  const oversized = await postChunks(`${url}/api/sync/upload-gist`, Array.from({ length: 5 }, () => Buffer.alloc(16 * 1024, "x")));
  assert.equal(oversized.status, 413);
  assert.equal((await fetch(`${url}/api/usage`)).status, 200);
});

test("sync parameters are validated before making an upstream request", { timeout: 15000 }, async (context) => {
  const { url } = await startServer(context);
  for (const [route, payload] of [
    ["upload-gist", { githubToken: 123 }],
    ["upload-gist", { githubToken: " " }],
    ["upload-gist", { githubToken: "fixture-token", deviceName: [] }],
    ["download-gist", { gistId: "../other" }],
    ["download-gist", { gistId: "abc123", githubToken: {} }]
  ]) {
    const response = await fetch(`${url}/api/sync/${route}`, { method: "POST", body: JSON.stringify(payload) });
    assert.equal(response.status, 400, `${route}: ${JSON.stringify(payload)}`);
  }
});

test("invalid absolute request URLs return 400 without crashing the server", { timeout: 15000 }, async (context) => {
  const { url } = await startServer(context);
  const status = await new Promise((resolve, reject) => {
    const request = http.get(url, { path: "http://[" }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on("error", reject);
  });
  assert.equal(status, 400);
  assert.equal((await fetch(url)).status, 200);
});

test("static routes serve only public dashboard assets", { timeout: 15000 }, async (context) => {
  const { url } = await startServer(context);
  for (const asset of ["", "index.html", "app.js", "data.js", "chart.js", "table.js", "export.js", "notifications.js", "styles.css"]) {
    assert.equal((await fetch(`${url}/${asset}`)).status, 200, asset);
  }
  for (const privateFile of ["server.js", "sessions.js", "gist.js", "package.json", "pricing.json", ".env.example", ".git/config", "test/server.test.js"]) {
    assert.equal((await fetch(`${url}/${privateFile}`)).status, 404, privateFile);
  }
});

test("session export is available immediately after server startup", { timeout: 15000 }, async (context) => {
  const { url } = await startServer(context);
  const response = await fetch(`${url}/api/sessions/fixture-session/full`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).sessionId, "fixture-session");
  assert.equal((await fetch(`${url}/api/sessions/__proto__/full`)).status, 404);
  assert.equal((await fetch(`${url}/api/sessions/%ZZ/full`)).status, 400);
});

test("local exports and Gist uploads do not query official usage and keep pricing intact", { timeout: 15000 }, async (context) => {
  const { url, officialQueryCount } = await startServer(context);
  const exportedResponse = await fetch(`${url}/api/export/all`);
  assert.equal(exportedResponse.status, 200);
  const exported = await exportedResponse.json();
  assert.equal(exported.sessionCount, 1);
  assert.equal(exported.sessions[0].tokens.total, 15);
  assert.equal(exported.sessions[0].tokens.cacheWriteInput, 1);
  assert.equal(Number(exported.sessions[0].costUsd.toFixed(7)), 0.0000292);
  const uploadedResponse = await fetch(`${url}/api/sync/upload-gist`, {
    method: "POST", body: JSON.stringify({ githubToken: "fixture-token" })
  });
  assert.equal(uploadedResponse.status, 200);
  assert.equal((await uploadedResponse.json()).sessionCount, 1);
  assert.equal(officialQueryCount(), 0);
  const usageResponse = await fetch(`${url}/api/usage`);
  assert.equal(usageResponse.status, 200);
  const usage = await usageResponse.json();
  assert.equal(officialQueryCount(), 1);
  assert.equal(usage.sessions[0].costUsd, exported.sessions[0].costUsd);
  assert.equal(usage.costSummary.totalUsd, exported.sessions[0].costUsd);
});

test("pending official queries do not block local exports or Gist uploads", { timeout: 15000 }, async (context) => {
  const { url, officialQueryCount, waitForOfficialQuery, releaseOfficialQuery } = await startServer(context, "", { blockOfficial: true });
  const usageRequest = fetch(`${url}/api/usage`);
  try {
    await waitForOfficialQuery();
    const exported = await fetch(`${url}/api/export/all`, { signal: AbortSignal.timeout(2000) });
    assert.equal(exported.status, 200);
    assert.equal((await exported.json()).sessionCount, 1);
    const uploaded = await fetch(`${url}/api/sync/upload-gist`, {
      method: "POST", body: JSON.stringify({ githubToken: "fixture-token" }), signal: AbortSignal.timeout(2000)
    });
    assert.equal(uploaded.status, 200);
    assert.equal((await uploaded.json()).sessionCount, 1);
    assert.equal(officialQueryCount(), 1);
  } finally {
    releaseOfficialQuery();
    const usage = await usageRequest;
    assert.equal(usage.status, 200);
    await usage.json();
  }
});

test("all data and sync endpoints honor header authentication", { timeout: 15000 }, async (context) => {
  const { url } = await startServer(context, "local-token");
  for (const route of ["/api/usage", "/api/export/all", "/api/sessions/fixture-session/full", "/api/sync/upload-gist", "/api/sync/download-gist"]) {
    const method = route.includes("/sync/") ? "POST" : "GET";
    assert.equal((await fetch(`${url}${route}`, { method })).status, 401, route);
  }
  const response = await fetch(`${url}/api/sync/download-gist`, {
    method: "POST",
    headers: { "x-token-lens-token": "local-token" },
    body: JSON.stringify({ gistId: "abc123" })
  });
  assert.equal(response.status, 200);
});

async function startServer(context, apiToken = "", { blockOfficial = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "token-lens-http-test-"));
  const codexDir = path.join(root, "codex");
  const sessionsDir = path.join(codexDir, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const events = [
    { type: "session_meta", payload: { id: "fixture-session" } },
    { type: "turn_context", payload: { model: "fixture-model" } },
    { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: {
      input_tokens: 10, cached_input_tokens: 2, cache_write_input_tokens: 1, output_tokens: 5, total_tokens: 15
    } } } }
  ];
  fs.writeFileSync(path.join(sessionsDir, "fixture.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  const officialQueriesPath = path.join(root, "official-queries.txt");
  const officialReleasePath = path.join(root, "official-release.txt");
  const preload = path.join(root, "gist-fixture.cjs");
  fs.writeFileSync(preload, `
    const fs = require("node:fs");
    const limitsModulePath = require.resolve(${JSON.stringify(path.join(projectRoot, "limits.js"))});
    const { createLimitsService } = require(limitsModulePath);
    require.cache[limitsModulePath].exports.createLimitsService = (options) => {
      const service = createLimitsService(options);
      return {
        ...service,
        async queryOfficialUsage() {
          fs.appendFileSync(${JSON.stringify(officialQueriesPath)}, "query\\n");
          if (${JSON.stringify(blockOfficial)}) {
            while (!fs.existsSync(${JSON.stringify(officialReleasePath)})) await new Promise((resolve) => setTimeout(resolve, 5));
          }
          return service.queryOfficialUsage();
        }
      };
    };
    const modulePath = require.resolve(${JSON.stringify(path.join(projectRoot, "gist.js"))});
    require(modulePath);
    require.cache[modulePath].exports.createGistService = () => ({
      async uploadToGist(sessions, token, options) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (token === "reject-upstream") throw new Error("fixture upstream failure");
        return { gistId: "abc123", sessionCount: sessions.length, deviceName: options.deviceName };
      },
      async downloadFromGist() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { sessions: [] };
      }
    });
  `);
  const child = spawn(process.execPath, ["--require", preload, "server.js"], {
    cwd: projectRoot,
    windowsHide: true,
    env: {
      ...process.env, CODEX_HOME: codexDir, TOKEN_LENS_CACHE_DIR: path.join(root, "cache"), TOKEN_LENS_PORT: "0", TOKEN_LENS_OFFICIAL_USAGE: "0", TOKEN_LENS_API_TOKEN: apiToken,
      TOKEN_LENS_PRICES_JSON: JSON.stringify([{ pattern: "fixture-model", label: "Fixture model", input: 1, cachedInput: 0.1, cacheWriteInput: 2, output: 4 }])
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  context.after(async () => {
    if (!child.killed) child.kill();
    await closed;
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const url = await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${stderr}`)), 10000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(stderr)); });
  });
  const officialQueryCount = () => fs.existsSync(officialQueriesPath) ? fs.readFileSync(officialQueriesPath, "utf8").trim().split("\n").length : 0;
  return {
    url,
    officialQueryCount,
    releaseOfficialQuery() { fs.writeFileSync(officialReleasePath, "release"); },
    async waitForOfficialQuery() {
      const deadline = Date.now() + 5000;
      while (!officialQueryCount()) {
        assert.ok(Date.now() < deadline, "Official query did not start");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  };
}

function postChunks(url, chunks) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: "POST" }, (response) => {
      const body = [];
      response.on("data", (chunk) => body.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        try { resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(body).toString("utf8")) }); }
        catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}
