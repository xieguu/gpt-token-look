const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");

const serverPath = path.resolve(__dirname, "..", "server.js");

test("the last page disconnect shuts down the server and releases idle sockets and its port", { timeout: 10000 }, async (context) => {
  const fixture = await startServer(context);
  const first = await connectPage(context, fixture.url);
  const second = await connectPage(context, fixture.url);
  const idleSocket = net.connect(Number(new URL(fixture.url).port), "127.0.0.1");
  context.after(() => idleSocket.destroy());
  await once(idleSocket, "connect");
  await delay(350);
  assert.equal(fixture.child.exitCode, null);
  first.destroy();
  await delay(350);
  assert.equal(fixture.child.exitCode, null);
  assert.equal(second.destroyed, false);
  second.destroy();
  assert.equal((await fixture.waitForExit()).code, 0);
  await assertPortAvailable(fixture.url);
});

test("reconnecting during the grace period cancels automatic shutdown", { timeout: 10000 }, async (context) => {
  const fixture = await startServer(context, { TOKEN_LENS_IDLE_TIMEOUT_MS: "600" });
  const first = await connectPage(context, fixture.url);
  first.destroy();
  await delay(100);
  const restored = await connectPage(context, fixture.url);
  await delay(750);
  assert.equal(fixture.child.exitCode, null);
  assert.equal(restored.destroyed, false);
  restored.destroy();
  assert.equal((await fixture.waitForExit()).code, 0);
});

test("unfinished requests prevent shutdown after the page closes", { timeout: 10000 }, async (context) => {
  const fixture = await startServer(context);
  const page = await connectPage(context, fixture.url);
  const pending = http.request(`${fixture.url}/api/sync/download-gist`, { method: "POST", headers: { "content-type": "application/json" } });
  context.after(() => pending.destroy());
  const completed = new Promise((resolve, reject) => {
    pending.once("error", reject);
    pending.once("response", (response) => { response.resume(); response.once("end", () => resolve(response.statusCode)); });
  });
  pending.write("{");
  await delay(50);
  page.destroy();
  await delay(350);
  assert.equal(fixture.child.exitCode, null);
  pending.end("invalid");
  assert.equal(await completed, 400);
  assert.equal((await fixture.waitForExit()).code, 0);
});

test("a server that never receives a page connection exits after startup grace", { timeout: 10000 }, async (context) => {
  const fixture = await startServer(context, { TOKEN_LENS_STARTUP_TIMEOUT_MS: "200" });
  assert.equal((await fixture.waitForExit()).code, 0);
  await assertPortAvailable(fixture.url);
});

test("setting idle timeout to zero explicitly keeps the service running", { timeout: 10000 }, async (context) => {
  const fixture = await startServer(context, { TOKEN_LENS_IDLE_TIMEOUT_MS: "0", TOKEN_LENS_STARTUP_TIMEOUT_MS: "100" });
  await delay(250);
  assert.equal(fixture.child.exitCode, null);
  const page = await connectPage(context, fixture.url);
  page.destroy();
  await delay(250);
  assert.equal(fixture.child.exitCode, null);
});

test("page connections require the configured API token", { timeout: 10000 }, async (context) => {
  const fixture = await startServer(context, { TOKEN_LENS_API_TOKEN: "fixture-token" });
  const rejected = await fetch(`${fixture.url}/api/client`);
  assert.equal(rejected.status, 401);
  assert.match((await rejected.json()).error, /API token/);
  const page = await connectPage(context, fixture.url, "fixture-token");
  page.destroy();
  assert.equal((await fixture.waitForExit()).code, 0);
});

test("invalid shutdown settings fail instead of silently disabling or changing the timer", () => {
  for (const [setting, value] of [
    ["TOKEN_LENS_IDLE_TIMEOUT_MS", ""],
    ["TOKEN_LENS_IDLE_TIMEOUT_MS", "-1"],
    ["TOKEN_LENS_IDLE_TIMEOUT_MS", "invalid"],
    ["TOKEN_LENS_IDLE_TIMEOUT_MS", "2147483648"],
    ["TOKEN_LENS_STARTUP_TIMEOUT_MS", "0"]
  ]) {
    const result = spawnSync(process.execPath, [serverPath], {
      windowsHide: true,
      timeout: 5000,
      encoding: "utf8",
      env: { ...process.env, TOKEN_LENS_IDLE_TIMEOUT_MS: "200", TOKEN_LENS_STARTUP_TIMEOUT_MS: "5000", [setting]: value }
    });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(setting));
  }
});

async function startServer(context, settings = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "token-lens-lifecycle-test-"));
  const codexDir = path.join(root, ".codex");
  fs.mkdirSync(path.join(codexDir, "sessions"), { recursive: true });
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      CODEX_HOME: codexDir,
      TOKEN_LENS_CACHE_DIR: path.join(root, "cache"),
      TOKEN_LENS_PORT: "0",
      TOKEN_LENS_API_TOKEN: "",
      TOKEN_LENS_OFFICIAL_USAGE: "0",
      TOKEN_LENS_IDLE_TIMEOUT_MS: "200",
      TOKEN_LENS_STARTUP_TIMEOUT_MS: "5000",
      ...settings
    }
  });
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const url = await new Promise((resolve, reject) => {
    let output = "";
    let errors = "";
    const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${errors}`)), 5000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(errors || "Server exited before listening")); });
  });
  return {
    child,
    url,
    async waitForExit() {
      let timer;
      try {
        return await Promise.race([closed, new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Server did not shut down automatically")), 5000);
        })]);
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

function connectPage(context, url, token = "") {
  return new Promise((resolve, reject) => {
    const request = http.get(`${url}/api/client`, { headers: token ? { "x-token-lens-token": token } : {} }, (response) => {
      response.on("error", (error) => { response.connectionError = error; });
      response.resume();
      if (response.statusCode !== 200) return reject(new Error(`Unexpected page connection status: ${response.statusCode}`));
      assert.match(response.headers["content-type"], /text\/event-stream/);
      resolve(response);
    });
    request.once("error", reject);
    context.after(() => request.destroy());
  });
}

async function assertPortAvailable(url) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(new URL(url).port), "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
