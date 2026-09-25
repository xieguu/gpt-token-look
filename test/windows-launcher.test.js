const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

const projectRoot = path.resolve(__dirname, "..");
const windowsOnly = { skip: process.platform !== "win32", timeout: 45000 };
const readyServer = `
  const http = require("node:http");
  const server = http.createServer((request, response) => response.end("ok"));
  server.listen(Number(process.env.TOKEN_LENS_PORT), "127.0.0.1", () => {
    console.log("Codex Token Lens started: http://127.0.0.1:" + server.address().port);
  });
`;

test("Windows launcher stops only its own project, releases its port and directory, and supports repeated stops", windowsOnly, async (context) => {
  const fixture = createFixture(context, readyServer);
  const otherFixture = createFixture(context, readyServer);
  const started = await runScript(fixture, "start.ps1");
  const otherStarted = await runScript(otherFixture, "start.ps1");
  const url = started.stdout.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  const otherUrl = otherStarted.stdout.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  assert.equal(await (await fetch(url)).text(), "ok");

  await runScript(fixture, "stop.ps1");
  assert.equal(isRunning(readPid(fixture)), false);
  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(2000) }));
  assert.equal(await (await fetch(otherUrl)).text(), "ok");
  assert.equal(isRunning(readPid(otherFixture)), true);
  await assertPortAvailable(url);
  await runScript(fixture, "stop.ps1");
  await runScript(otherFixture, "stop.ps1");
  assert.equal(isRunning(readPid(otherFixture)), false);

  assert.equal(path.dirname(fixture.appDir), fixture.root);
  fs.rmSync(fixture.appDir, { recursive: true, force: true });
  assert.equal(fs.existsSync(fixture.appDir), false);
});

for (const [name, source] of [
  ["startup timeout", "setInterval(() => {}, 1000);"],
  ["early server exit", "process.exit(2);"]
]) {
  test(`Windows launcher leaves no background process after ${name}`, windowsOnly, async (context) => {
    const fixture = createFixture(context, source);
    await assert.rejects(runScript(fixture, "start.ps1"), (error) => {
      assert.equal(error.code, 1);
      return true;
    });
    assert.equal(isRunning(readPid(fixture)), false);
  });
}

function createFixture(context, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "token-lens-launcher-test-"));
  const appDir = path.join(root, "project with spaces");
  const tempDir = path.join(root, "temp");
  const pidPath = path.join(root, "server.pid");
  fs.mkdirSync(appDir);
  fs.mkdirSync(tempDir);
  for (const filename of ["start.ps1", "stop.ps1"]) {
    fs.copyFileSync(path.join(projectRoot, filename), path.join(appDir, filename));
  }
  fs.writeFileSync(path.join(appDir, "server.js"), `
    require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
    ${source}
  `);
  const fixture = { root, appDir, tempDir, pidPath };
  context.after(async () => {
    if (fs.existsSync(pidPath)) {
      const serverPid = readPid(fixture);
      if (isRunning(serverPid)) {
        process.kill(serverPid);
        const deadline = Date.now() + 5000;
        while (isRunning(serverPid)) {
          assert.ok(Date.now() < deadline, "Fixture server did not exit");
          await delay(25);
        }
      }
    }
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return fixture;
}

function runScript(fixture, filename) {
  const stdoutPath = path.join(fixture.root, `${filename}.stdout.log`);
  const stderrPath = path.join(fixture.root, `${filename}.stderr.log`);
  return new Promise((resolve, reject) => {
    const stdoutFd = fs.openSync(stdoutPath, "w");
    const stderrFd = fs.openSync(stderrPath, "w");
    let child;
    try {
      child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(fixture.appDir, filename)], {
        cwd: os.tmpdir(),
        windowsHide: true,
        stdio: ["ignore", stdoutFd, stderrFd],
        env: { ...process.env, TEMP: fixture.tempDir, TMP: fixture.tempDir, TOKEN_LENS_PORT: "0", TOKEN_LENS_NO_BROWSER: "1" }
      });
    } finally {
      fs.closeSync(stdoutFd);
      fs.closeSync(stderrFd);
    }
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${filename} timed out`));
    }, 30000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      const output = { stdout: fs.readFileSync(stdoutPath, "utf8"), stderr: fs.readFileSync(stderrPath, "utf8") };
      if (code !== 0) {
        reject(Object.assign(new Error(`${filename} failed: ${output.stderr}`), { code, ...output }));
        return;
      }
      resolve(output);
    });
  });
}

function readPid(fixture) {
  const serverPid = Number(fs.readFileSync(fixture.pidPath, "utf8"));
  assert.ok(Number.isInteger(serverPid) && serverPid > 0);
  return serverPid;
}

function isRunning(serverPid) {
  try {
    process.kill(serverPid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function assertPortAvailable(url) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(new URL(url).port), "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
