const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const { createSessionsService } = require("./sessions");
const { createLimitsService, selectRateLimits } = require("./limits");
const { createPricingService } = require("./pricing");

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

const sessionsService = createSessionsService({ codexDir: CODEX_DIR, cacheDir: CACHE_DIR, cacheTtlMs: CACHE_TTL_MS, scanConcurrency: SCAN_CONCURRENCY });
const pricingService = createPricingService({ appDir: APP_DIR, pricingFile: process.env.TOKEN_LENS_PRICING_FILE, pricesJson: process.env.TOKEN_LENS_PRICES_JSON || "", timeoutMs: OFFICIAL_TIMEOUT_MS });
const limitsService = createLimitsService({ codexDir: CODEX_DIR, mode: process.env.TOKEN_LENS_OFFICIAL_USAGE || "auto", timeoutMs: OFFICIAL_TIMEOUT_MS, command: process.env.TOKEN_LENS_CODEX_COMMAND, extraArgs: resolveCodexExtraArgs() });
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" };
let scanPromise = null;

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
  const estimated = sessions.filter((item) => item.costBreakdown?.estimated);
  return { estimatedSessionCount: estimated.length, unpricedSessionCount: sessions.length - estimated.length, totalUsd: estimated.reduce((total, item) => total + Number(item.costUsd || 0), 0) };
}

async function scanUsage() {
  const scanned = await sessionsService.scan();
  const sessions = scanned.sessions.map((item) => {
    const costBreakdown = pricingService.estimateCost(item.model, item);
    return { ...item, costUsd: costBreakdown.totalUsd, costBreakdown };
  });
  const official = await limitsService.queryOfficialUsage();
  const selected = selectRateLimits(official, scanned.latestRateLimits, scanned.latestRateLimitsUpdatedAt);
  return {
    source: scanned.source, available: scanned.available, scannedAt: scanned.scannedAt, scanDurationMs: scanned.scanDurationMs, sessionCount: sessions.length,
    pricing: pricingService.getPublicPricing(), costSummary: summarizeCosts(sessions), sessions,
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
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...securityHeaders() });
  response.end(JSON.stringify(value));
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

function serveStatic(request, response) {
  const requestPath = new URL(request.url, `http://${HOST}`).pathname;
  let relative;
  try { relative = requestPath === "/" ? "index.html" : decodeURIComponent(requestPath.slice(1)); }
  catch { response.writeHead(400, securityHeaders()); return response.end("Bad request"); }
  const appRoot = path.resolve(APP_DIR); const resolved = path.resolve(APP_DIR, relative);
  if (!resolved.startsWith(`${appRoot}${path.sep}`) && resolved !== path.join(APP_DIR, "index.html")) { response.writeHead(403, securityHeaders()); return response.end("Forbidden"); }
  fs.readFile(resolved, (error, body) => {
    if (error) { response.writeHead(error.code === "ENOENT" ? 404 : 500, securityHeaders()); return response.end(error.code === "ENOENT" ? "Not found" : "Read error"); }
    response.writeHead(200, { "Content-Type": MIME[path.extname(resolved)] || "application/octet-stream", "Cache-Control": "no-cache", ...securityHeaders() }); response.end(body);
  });
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${HOST}`); const requestPath = requestUrl.pathname;
  if (request.method === "POST" && requestPath === "/api/pricing/update") {
    if (!isAuthorized(request, requestUrl)) return sendJson(response, 401, { error: "Invalid or missing Token Lens API token" });
    try { return sendJson(response, 200, { ok: true, pricing: await pricingService.update() }); }
    catch (error) { try { fs.rmSync(path.join(APP_DIR, "pricing.json.tmp"), { force: true }); } catch { /* Keep old prices. */ } console.warn(`Unable to update pricing: ${error.message}`); return sendJson(response, 502, { ok: false, error: `Unable to update pricing: ${error.message}`, pricing: pricingService.getPublicPricing() }); }
  }
  if (request.method !== "GET") { response.writeHead(405, securityHeaders()); return response.end("Method not allowed"); }
  if (requestPath === "/api/usage") {
    if (!isAuthorized(request, requestUrl)) return sendJson(response, 401, { error: "Invalid or missing Token Lens API token" });
    try { return sendJson(response, 200, await getUsage()); }
    catch (error) { return sendJson(response, 500, { error: "Unable to read Codex usage statistics", detail: error.code === "ENOENT" ? `Missing sessions directory: ${sessionsService.sessionsDir}` : error.message }); }
  }
  serveStatic(request, response);
});

server.on("error", (error) => { if (error.code === "EADDRINUSE") console.error(`Port ${PORT} is already in use. Token Lens may already be running, or set TOKEN_LENS_PORT to another port.`); else console.error(`Token Lens failed to start: ${error.message}`); process.exitCode = 1; });
server.listen(PORT, HOST, () => { const address = server.address(); const activePort = typeof address === "object" ? address.port : PORT; console.log(`\nCodex Token Lens started: http://${HOST}:${activePort}`); console.log(`Data source: ${sessionsService.sessionsDir}`); console.log("Read-only token totals, models, limits, and session titles. Press Ctrl+C to stop.\n"); });
