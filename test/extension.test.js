const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { unzipSync } = require("fflate");
const { createClient, normalizeSettings } = require("../extension/client");
const { buildExtension } = require("../scripts/build-extension");

test("extension settings accept defaults and validate ports and header-safe tokens", () => {
  assert.deepEqual(normalizeSettings({}), { port: 4173, apiToken: "" });
  assert.deepEqual(normalizeSettings({ port: "65535", apiToken: " fixture-token " }), { port: 65535, apiToken: "fixture-token" });
  for (const port of [0, -1, 65536, 1.5, "", "invalid", null, false, [], {}, Infinity]) {
    assert.throws(() => normalizeSettings({ port }), /端口/);
  }
  for (const apiToken of [null, false, {}, "a b", "token\r\nheader", "中文"]) {
    assert.throws(() => normalizeSettings({ apiToken }), /API Token/);
  }
});

test("extension API calls stay on loopback and send stored tokens only in headers", async () => {
  const fixture = createClientFixture({ port: 4312, apiToken: "private-local-token" });
  const response = await fixture.client.request("/api/usage", { headers: { "x-token-lens-token": "stale-token", "x-fixture": "preserved" } });
  assert.equal(response.ok, true);
  const { url, options } = fixture.calls[0];
  assert.equal(url, "http://127.0.0.1:4312/api/usage");
  assert.equal(options.headers.get("x-token-lens-token"), "private-local-token");
  assert.equal(options.headers.get("x-fixture"), "preserved");
  assert.equal(options.cache, "no-store");
  assert.equal(options.credentials, "omit");
  assert.equal(options.redirect, "error");
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(url.includes("token"), false);
});

test("extension rejects remote and non-API paths before issuing requests", async () => {
  const fixture = createClientFixture();
  for (const requestPath of ["https://example.com/api/usage", "//example.com/api/usage", "/", "/api/../server.js", "/api/%2e%2e/server.js", new URL("http://127.0.0.1:4173/api/usage")]) {
    await assert.rejects(fixture.client.request(requestPath), /只允许/);
  }
  assert.equal(fixture.calls.length, 0);
});

test("extension transports POST bodies and caller cancellation without weakening request controls", async () => {
  const fixture = createClientFixture();
  const controller = new AbortController();
  await fixture.client.request("/api/sync/upload-gist", {
    method: "POST", body: '{"githubToken":"fixture"}', headers: { "Content-Type": "application/json", "x-token-lens-token": "discard" },
    signal: controller.signal, credentials: "include", redirect: "follow", cache: "force-cache"
  });
  const options = fixture.calls[0].options;
  assert.equal(options.method, "POST");
  assert.equal(options.body, '{"githubToken":"fixture"}');
  assert.equal(options.headers.get("content-type"), "application/json");
  assert.equal(options.headers.has("x-token-lens-token"), false);
  assert.strictEqual(options.signal, controller.signal);
  assert.equal(options.credentials, "omit");
  assert.equal(options.redirect, "error");
  assert.equal(options.cache, "no-store");
});

test("extension settings changes apply to subsequent requests without reloading pages", async () => {
  const fixture = createClientFixture();
  await fixture.client.request("/api/usage");
  await fixture.client.saveSettings({ port: "4321", apiToken: "new-token" });
  await fixture.client.request("/api/usage");
  assert.equal(fixture.calls[1].url, "http://127.0.0.1:4321/api/usage");
  assert.equal(fixture.calls[1].options.headers.get("x-token-lens-token"), "new-token");
  await assert.rejects(fixture.client.saveSettings({ port: 0 }), /端口/);
  assert.deepEqual(await fixture.client.getSettings(), { port: 4321, apiToken: "new-token" });
});

test("extension propagates storage and network failures instead of silently changing transports", async () => {
  const failure = new Error("fixture unavailable");
  const fixture = createClientFixture({}, async () => { throw failure; });
  await assert.rejects(fixture.client.request("/api/usage"), failure);
  const broken = createClient({ storage: { async get() { throw failure; } }, fetchImpl() { assert.fail("No request should be sent"); } });
  await assert.rejects(broken.request("/api/usage"), failure);
  const invalid = createClientFixture({ port: -1 });
  await assert.rejects(invalid.client.request("/api/usage"), /端口/);
  assert.equal(invalid.calls.length, 0);
});

test("extension requests time out instead of keeping the popup busy indefinitely", async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const fixture = createClientFixture({}, (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }), 10);
    await assert.rejects(fixture.client.request("/api/usage"), { name: "TimeoutError" });
  } finally { clearTimeout(keepAlive); }
});

test("browser extension builds a complete, minimal-permission package from shared dashboard assets", async (context) => {
  const root = await createBuildDirectory(context);
  const result = await buildExtension(root);
  const zip = unzipSync(await fs.readFile(result.archive));
  const manifest = JSON.parse(Buffer.from(zip["manifest.json"]).toString("utf8"));
  assert.equal(result.files, 20);
  assert.equal(Object.keys(zip).length, result.files);
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, require("../package.json").version);
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*"]);
  assert.equal(manifest.background, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.ok(zip[manifest.action.default_popup]);
  assert.ok(zip[manifest.options_ui.page]);
  assert.match(manifest.content_security_policy.extension_pages, /connect-src http:\/\/127\.0\.0\.1:\*/);
  const projectRoot = path.resolve(__dirname, "..");
  for (const name of ["app.js", "data.js", "chart.js", "table.js", "export.js", "notifications.js", "styles.css"]) {
    assert.deepEqual(Buffer.from(zip[name]), await fs.readFile(path.join(projectRoot, name)));
  }
  for (const name of ["server.js", "sessions.js", "limits.js", "gist.js", "pricing.json", "package.json", ".env", "test/extension.test.js"]) assert.equal(zip[name], undefined, name);
  const dashboard = Buffer.from(zip["dashboard.html"]).toString("utf8");
  assert.ok(dashboard.indexOf('src="./client.js"') < dashboard.indexOf('src="./app.js"'));
  for (const name of ["dashboard.html", "popup.html", "options.html"]) {
    const html = Buffer.from(zip[name]).toString("utf8");
    for (const match of html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)) assert.ok(zip[match[1]], `${name}: ${match[1]}`);
    assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)[^>]*>/i);
  }
  for (const [size, name] of Object.entries(manifest.icons)) {
    const png = Buffer.from(zip[name]);
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), Number(size));
    assert.equal(png.readUInt32BE(20), Number(size));
  }
  for (const [name, content] of Object.entries(zip)) assert.deepEqual(await fs.readFile(path.join(result.directory, name)), Buffer.from(content));
});

test("extension ZIP output is repeatable and excludes unrelated files already in the output folder", async (context) => {
  const root = await createBuildDirectory(context);
  const first = await buildExtension(root);
  const original = await fs.readFile(first.archive);
  await fs.writeFile(path.join(first.directory, "private-fixture.txt"), "not for packaging");
  const second = await buildExtension(root);
  const repeated = await fs.readFile(second.archive);
  assert.deepEqual(repeated, original);
  assert.equal(unzipSync(repeated)["private-fixture.txt"], undefined);
});

function createClientFixture(settings = {}, fetchImpl = async () => ({ ok: true }), timeoutMs) {
  const stored = { ...settings };
  const calls = [];
  const storage = {
    async get(defaults) { return { ...defaults, ...stored }; },
    async set(values) { Object.assign(stored, values); }
  };
  const client = createClient({ storage, timeoutMs, fetchImpl(url, options) { calls.push({ url, options }); return fetchImpl(url, options); } });
  return { client, calls };
}

async function createBuildDirectory(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "token-lens-extension-test-"));
  context.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("token-lens-extension-test-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}
