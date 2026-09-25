const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const { createSessionsService } = require("./sessions");
const { createLimitsService, selectRateLimits } = require("./limits");
const { createPricingService } = require("./pricing");
const { createGistService } = require("./gist");

const HOST = "127.0.0.1";
const PORT = process.env.TOKEN_LENS_PORT === undefined ? 4173 : Number(process.env.TOKEN_LENS_PORT);
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  console.error("TOKEN_LENS_PORT must be an integer between 0 and 65535.");
  process.exit(1);
}

const APP_DIR = __dirname;
const CODEX_DIR = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const CACHE_DIR = process.env.TOKEN_LENS_CACHE_DIR || path.join(os.tmpdir(), "codex-token-lens");
const CACHE_TTL_MS = parseDurationMs(process.env.TOKEN_LENS_CACHE_TTL || "15m", 15 * 60 * 1000);
const SCAN_CONCURRENCY = parsePositiveInt(process.env.TOKEN_LENS_SCAN_CONCURRENCY, 3, 32);
const API_TOKEN = process.env.TOKEN_LENS_API_TOKEN || "";
const OFFICIAL_TIMEOUT_MS = Number(process.env.TOKEN_LENS_OFFICIAL_TIMEOUT_MS || 5000);
const IDLE_TIMEOUT_MS = readTimeoutSetting("TOKEN_LENS_IDLE_TIMEOUT_MS", 15000, 0);
const STARTUP_TIMEOUT_MS = readTimeoutSetting("TOKEN_LENS_STARTUP_TIMEOUT_MS", 60000, 1);

const sessionsService = createSessionsService({ codexDir: CODEX_DIR, cacheDir: CACHE_DIR, cacheTtlMs: CACHE_TTL_MS, scanConcurrency: SCAN_CONCURRENCY });
const pricingService = createPricingService({ appDir: APP_DIR, pricingFile: process.env.TOKEN_LENS_PRICING_FILE, pricesJson: process.env.TOKEN_LENS_PRICES_JSON || "", timeoutMs: OFFICIAL_TIMEOUT_MS });
const limitsService = createLimitsService({ codexDir: CODEX_DIR, mode: process.env.TOKEN_LENS_OFFICIAL_USAGE || "auto", timeoutMs: OFFICIAL_TIMEOUT_MS, command: process.env.TOKEN_LENS_CODEX_COMMAND, extraArgs: resolveCodexExtraArgs() });
const gistService = createGistService();
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" };
const PUBLIC_FILES = new Set(["index.html", "styles.css", "app.js", "data.js", "chart.js", "table.js", "export.js", "notifications.js", "token-lens-preview.png"]);
const MAX_JSON_BODY_BYTES = 64 * 1024;
let localScanPromise = null;
let scanPromise = null;
const activeResponses = new Set();
const connections = new Set();
let shutdownTimer = null;
let browserConnected = false;

function readTimeoutSetting(name, defaultValue, minimum) {
  const raw = process.env[name];
  const value = raw === undefined ? defaultValue : Number(raw);
  if ((raw !== undefined && !/^\d+$/.test(raw)) || !Number.isInteger(value) || value < minimum || value > 2147483647) {
    console.error(`${name} must be an integer between ${minimum} and 2147483647 milliseconds.`);
    process.exit(1);
  }
  return value;
}

function scheduleShutdown(timeoutMs) {
  clearTimeout(shutdownTimer);
  if (IDLE_TIMEOUT_MS === 0 || activeResponses.size) return;
  shutdownTimer = setTimeout(() => {
    console.log("No open dashboard or active requests. Stopping Token Lens automatically.");
    server.close();
    for (const connection of connections) connection.destroy();
  }, timeoutMs);
}

function trackResponse(response) {
  clearTimeout(shutdownTimer);
  activeResponses.add(response);
  const complete = () => {
    if (!activeResponses.delete(response)) return;
    scheduleShutdown(browserConnected ? IDLE_TIMEOUT_MS : STARTUP_TIMEOUT_MS);
  };
  response.once("finish", complete);
  response.once("close", complete);
}

function parsePositiveInt(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function parseDurationMs(value, fallback) {
  if (value == null || value === "") return fallback;
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i);
  if (!match) return fallback;
  const units = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return Math.max(0, Number(match[1]) * (units[(match[2] || "ms").toLowerCase()] || 1));
}

function resolveCodexExtraArgs() {
  try {
    const parsed = JSON.parse(process.env.TOKEN_LENS_CODEX_ARGS_JSON || "[]");
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch { return []; }
}

function summarizeCosts(sessions) {
  return sessions.reduce((summary, item) => {
    if (item.costBreakdown?.estimated) {
      summary.estimatedSessionCount += 1;
      summary.totalUsd += Number(item.costUsd || 0);
    } else summary.unpricedSessionCount += 1;
    return summary;
  }, { estimatedSessionCount: 0, unpricedSessionCount: 0, totalUsd: 0 });
}

async function scanLocalUsage() {
  const scanned = await sessionsService.scan();
  const sessions = scanned.sessions.map((item) => {
    const costBreakdown = pricingService.estimateCost(item.model, item);
    return { ...item, costUsd: costBreakdown.totalUsd, costBreakdown };
  });
  return { ...scanned, sessions, pricing: pricingService.getPublicPricing(), costSummary: summarizeCosts(sessions) };
}

function getLocalUsage() {
  if (!localScanPromise) localScanPromise = scanLocalUsage().finally(() => { localScanPromise = null; });
  return localScanPromise;
}

async function scanUsage() {
  const [scanned, official] = await Promise.all([getLocalUsage(), limitsService.queryOfficialUsage()]);
  const selected = selectRateLimits(official, scanned.latestRateLimits, scanned.latestRateLimitsUpdatedAt);
  return {
    source: scanned.source, available: scanned.available, scannedAt: scanned.scannedAt, scanDurationMs: scanned.scanDurationMs, sessionCount: scanned.sessions.length,
    pricing: scanned.pricing, costSummary: scanned.costSummary, sessions: scanned.sessions,
    rateLimits: selected.rateLimits, rateLimitsSource: selected.rateLimitsSource, rateLimitsUpdatedAt: selected.rateLimitsUpdatedAt,
    accountUsage: official?.usage || null, rateLimitResetCredits: official?.rateLimitResetCredits || null,
    officialQuery: official ? { attempted: true, available: Boolean(official.rateLimits), error: official.error } : { attempted: false, available: false, error: null },
    diagnostics: scanned.diagnostics,
    alerts: { dailyCostUsd: Number(process.env.TOKEN_LENS_DAILY_COST_ALERT_USD || 0) || null, remainingPercent: Number(process.env.TOKEN_LENS_RATE_LIMIT_ALERT_PERCENT || 10) || 10 }
  };
}

function getUsage() {
  if (!scanPromise) scanPromise = scanUsage().finally(() => { scanPromise = null; });
  return scanPromise;
}

function sendJson(response, status, value) {
  if (response.destroyed) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...securityHeaders() });
  response.end(JSON.stringify(value));
}

function requestError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      request.off("data", onData);
      request.resume();
      reject(error);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BODY_BYTES) return fail(requestError(413, "JSON body exceeds 64 KiB"));
      chunks.push(chunk);
    };
    request.on("error", (error) => fail(requestError(400, error.message)));
    request.once("aborted", () => fail(requestError(400, "Request body was aborted")));
    request.on("data", onData);
    request.once("end", () => {
      if (settled) return;
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks, size).toString("utf8")); }
      catch { return fail(requestError(400, "Invalid JSON body")); }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return fail(requestError(400, "Request body must be a JSON object"));
      settled = true;
      chunks.length = 0;
      resolve(payload);
    });
    if (Number(request.headers["content-length"]) > MAX_JSON_BODY_BYTES) fail(requestError(413, "JSON body exceeds 64 KiB"));
  });
}

function isAuthorized(request, requestUrl) {
  if (!API_TOKEN) return true;
  const supplied = request.headers["x-token-lens-token"] || requestUrl.searchParams.get("token") || "";
  const expected = Buffer.from(API_TOKEN); const actual = Buffer.from(String(supplied));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function securityHeaders() {
  return { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" };
}

function serveStatic(requestPath, response) {
  let relative;
  try { relative = requestPath === "/" ? "index.html" : decodeURIComponent(requestPath.slice(1)); }
  catch { response.writeHead(400, securityHeaders()); return response.end("Bad request"); }
  const appRoot = path.resolve(APP_DIR); const resolved = path.resolve(APP_DIR, relative);
  if (!resolved.startsWith(`${appRoot}${path.sep}`) && resolved !== path.join(APP_DIR, "index.html")) { response.writeHead(403, securityHeaders()); return response.end("Forbidden"); }
  if (!PUBLIC_FILES.has(relative)) { response.writeHead(404, securityHeaders()); return response.end("Not found"); }
  fs.readFile(resolved, (error, body) => {
    if (error) { response.writeHead(error.code === "ENOENT" ? 404 : 500, securityHeaders()); return response.end(error.code === "ENOENT" ? "Not found" : "Read error"); }
    response.writeHead(200, { "Content-Type": MIME[path.extname(resolved)] || "application/octet-stream", "Cache-Control": "no-cache", ...securityHeaders() }); response.end(body);
  });
}

const server = http.createServer(async (request, response) => {
  trackResponse(response);
  let requestUrl;
  try { requestUrl = new URL(request.url, `http://${HOST}`); }
  catch { return sendJson(response, 400, { error: "Invalid request URL" }); }
  const requestPath = requestUrl.pathname;
  if (request.method === "POST" && requestPath === "/api/pricing/update") {
    if (!isAuthorized(request, requestUrl)) return sendJson(response, 401, { error: "Invalid or missing Token Lens API token" });
    try { return sendJson(response, 200, { ok: true, pricing: await pricingService.update() }); }
    catch (error) { try { fs.rmSync(path.join(APP_DIR, "pricing.json.tmp"), { force: true }); } catch { /* Keep old prices. */ } console.warn(`Unable to update pricing: ${error.message}`); return sendJson(response, 502, { ok: false, error: `Unable to update pricing: ${error.message}`, pricing: pricingService.getPublicPricing() }); }
  }
  if (request.method === "POST" && requestPath === "/api/sync/upload-gist") {
    if (!isAuthorized(request, requestUrl)) return sendJson(response, 401, { error: "Invalid or missing Token Lens API token" });
    try {
      const payload = await readJsonBody(request);
      if (typeof payload.githubToken !== "string" || !payload.githubToken.trim()) throw requestError(400, "githubToken must be a non-empty string");
      if (payload.deviceName !== undefined && typeof payload.deviceName !== "string") throw requestError(400, "deviceName must be a string");
      const usage = await getLocalUsage();
      const result = await gistService.uploadToGist(usage.sessions, payload.githubToken, { deviceName: payload.deviceName || "Unknown" });
      return sendJson(response, 200, { ok: true, ...result });
    } catch (error) { return sendJson(response, error.statusCode || 502, { error: error.statusCode ? error.message : "Failed to upload to Gist", detail: error.message }); }
  }
  if (request.method === "POST" && requestPath === "/api/sync/download-gist") {
    if (!isAuthorized(request, requestUrl)) return sendJson(response, 401, { error: "Invalid or missing Token Lens API token" });
    try {
      const payload = await readJsonBody(request);
      if (typeof payload.gistId !== "string" || !/^[a-f0-9]{1,64}$/i.test(payload.gistId)) throw requestError(400, "gistId must be a hexadecimal Gist ID");
      if (payload.githubToken !== undefined && typeof payload.githubToken !== "string") throw requestError(400, "githubToken must be a string");
      const result = await gistService.downloadFromGist(payload.gistId, payload.githubToken || "");
      return sendJson(response, 200, { ok: true, data: result, importedCount: result.sessions?.length || 0 });
    } catch (error) { return sendJson(response, error.statusCode || 502, { error: error.statusCode ? error.message : "Failed to download from Gist", detail: error.message }); }
  }
  if (request.method !== "GET") { response.writeHead(405, securityHeaders()); return response.end("Method not allowed"); }
  if (requestPath === "/api/client") {
    if (!isAuthorized(request, requestUrl)) return sendJson(response, 401, { error: "Invalid or missing Token Lens API token" });
    browserConnected = true;
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", ...securityHeaders() });
    response.write(": connected\n\n");
    const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 15000);
    response.once("close", () => clearInterval(heartbeat));
    return;
  }
  if (requestPath === "/api/export/all") {
    if (!isAuthorized(request, requestUrl)) return sendJson(response, 401, { error: "Invalid or missing Token Lens API token" });
    try {
      const usage = await getLocalUsage();
      const exportData = {
        version: "1.0",
        exportedAt: new Date().toISOString(),
        source: "gpt-token-look",
        sessionCount: usage.sessions.length,
        sessions: usage.sessions.map((s) => ({
          id: s.id,
          name: s.name,
          date: s.date,
          model: s.model,
          tokens: { input: s.input, cachedInput: s.cachedInput, cacheWriteInput: s.cacheWriteInput, output: s.output, reasoningOutput: s.reasoningOutput, total: s.total },
          costUsd: s.costUsd
        }))
      };
      return sendJson(response, 200, exportData);
    } catch (error) { return sendJson(response, 500, { error: "Unable to export sessions", detail: error.message }); }
  }
  if (requestPath === "/api/usage") {
    if (!isAuthorized(request, requestUrl)) return sendJson(response, 401, { error: "Invalid or missing Token Lens API token" });
    try { return sendJson(response, 200, await getUsage()); }
    catch (error) { return sendJson(response, 500, { error: "Unable to read Codex usage statistics", detail: error.code === "ENOENT" ? `Missing sessions directory: ${sessionsService.sessionsDir}` : error.message }); }
  }
  const sessionMatch = requestPath.match(/^\/api\/sessions\/([^\/]+)\/full$/);
  if (sessionMatch) {
    if (!isAuthorized(request, requestUrl)) return sendJson(response, 401, { error: "Invalid or missing Token Lens API token" });
    let sessionId;
    try { sessionId = decodeURIComponent(sessionMatch[1]); }
    catch { return sendJson(response, 400, { error: "Invalid session ID encoding" }); }
    try {
      const sessionData = await sessionsService.readSessionFull(sessionId);
      if (!sessionData) return sendJson(response, 404, { error: "Session not found" });
      return sendJson(response, 200, sessionData);
    } catch (error) { return sendJson(response, 500, { error: "Unable to read session", detail: error.message }); }
  }
  serveStatic(requestPath, response);
});

server.on("error", (error) => { if (error.code === "EADDRINUSE") console.error(`Port ${PORT} is already in use. Token Lens may already be running, or set TOKEN_LENS_PORT to another port.`); else console.error(`Token Lens failed to start: ${error.message}`); process.exitCode = 1; });
server.on("connection", (connection) => {
  connections.add(connection);
  connection.once("close", () => connections.delete(connection));
});
server.on("close", () => clearTimeout(shutdownTimer));
server.listen(PORT, HOST, () => {
  const address = server.address();
  const activePort = typeof address === "object" ? address.port : PORT;
  console.log(`\nCodex Token Lens started: http://${HOST}:${activePort}`);
  console.log(`Data source: ${sessionsService.sessionsDir}`);
  console.log("Read-only token totals, models, limits, and session titles. Press Ctrl+C to stop.");
  console.log(IDLE_TIMEOUT_MS === 0 ? "Automatic shutdown disabled.\n" : `Auto-stop: ${IDLE_TIMEOUT_MS}ms after the last page closes; ${STARTUP_TIMEOUT_MS}ms startup grace.\n`);
  scheduleShutdown(STARTUP_TIMEOUT_MS);
});
