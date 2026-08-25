const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const readline = require("node:readline");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const HOST = "127.0.0.1";
const PORT = process.env.TOKEN_LENS_PORT === undefined ? 4173 : Number(process.env.TOKEN_LENS_PORT);
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  console.error("TOKEN_LENS_PORT must be an integer between 0 and 65535.");
  process.exit(1);
}

const APP_DIR = __dirname;
const CODEX_DIR = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const SESSIONS_DIR = path.join(CODEX_DIR, "sessions");
const INDEX_PATH = path.join(CODEX_DIR, "session_index.jsonl");
const CACHE_DIR = process.env.TOKEN_LENS_CACHE_DIR || path.join(os.tmpdir(), "codex-token-lens");
const CACHE_ID = crypto.createHash("sha256").update(CODEX_DIR).digest("hex").slice(0, 12);
const CACHE_PATH = path.join(CACHE_DIR, `usage-${CACHE_ID}.json`);
const CACHE_TTL_MS = parseDurationMs(process.env.TOKEN_LENS_CACHE_TTL || "15m", 15 * 60 * 1000);
const SCAN_CONCURRENCY = parsePositiveInt(process.env.TOKEN_LENS_SCAN_CONCURRENCY, 3, 32);
const PRICING_SOURCE = "https://platform.openai.com/pricing";
const BUNDLED_PRICING_FILE = path.join(APP_DIR, "pricing.json");
const PRICING_FILE = process.env.TOKEN_LENS_PRICING_FILE || BUNDLED_PRICING_FILE;
const PRICING_JSON = process.env.TOKEN_LENS_PRICES_JSON || "";
const API_TOKEN = process.env.TOKEN_LENS_API_TOKEN || "";
const OFFICIAL_USAGE_MODE = process.env.TOKEN_LENS_OFFICIAL_USAGE || "auto";
const OFFICIAL_TIMEOUT_MS = Number(process.env.TOKEN_LENS_OFFICIAL_TIMEOUT_MS || 5000);
let PRICES_PER_MILLION = loadPricing();
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

let scanPromise = null;
let officialUsagePromise = null;
let officialUsageCache = { at: 0, value: null };
let cache = loadCache();

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

function loadCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    return parsed && parsed.version === 1 ? parsed : { version: 1, files: {}, fullScanAt: 0 };
  } catch {
    return { version: 1, files: {}, fullScanAt: 0 };
  }
}

function saveCache() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const temporary = `${CACHE_PATH}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(cache), "utf8");
    fs.renameSync(temporary, CACHE_PATH);
  } catch (error) {
    console.warn(`Unable to write incremental cache; continuing without cache: ${error.message}`);
  }
}

function loadPricing() {
  const candidates = PRICING_JSON
    ? [{ label: "TOKEN_LENS_PRICES_JSON", source: PRICING_JSON }]
    : [
        { label: PRICING_FILE, file: PRICING_FILE },
        ...(PRICING_FILE !== BUNDLED_PRICING_FILE ? [{ label: BUNDLED_PRICING_FILE, file: BUNDLED_PRICING_FILE }] : [])
      ];
  for (const candidate of candidates) {
    try {
      const source = candidate.source ?? fs.readFileSync(candidate.file, "utf8");
      const parsed = JSON.parse(source);
      const models = Array.isArray(parsed) ? parsed : parsed.models;
      if (!Array.isArray(models)) throw new Error("pricing data must be an array or { models: [] }");
      const compiled = compilePricing(models);
      if (!compiled.length) throw new Error("pricing data did not contain any valid model rows");
      return compiled;
    } catch (error) {
      console.warn(`Invalid pricing configuration (${candidate.label}): ${error.message}`);
    }
  }
  return [];
}

function compilePricing(models) {
  return models
    .map((item) => {
      const pattern = item.pattern || item.match || item.label;
      return {
        match: new RegExp(pattern, "i"),
        pattern,
        label: item.label,
        input: Number(item.input),
        cachedInput: Number(item.cachedInput ?? item.cached_input ?? item.input),
        cacheWriteInput: Number(item.cacheWriteInput ?? item.cache_write_input ?? item.cachedInput ?? item.cached_input ?? item.input),
        output: Number(item.output)
      };
    })
    .filter((item) => item.label && Number.isFinite(item.input) && Number.isFinite(item.cachedInput) && Number.isFinite(item.cacheWriteInput) && Number.isFinite(item.output));
}

function normalizePriceNumber(value) {
  if (typeof value === "number") return value;
  const match = String(value ?? "").replace(/[$,]/g, "").match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : NaN;
}

function extractPricingFromHtml(html) {
  const found = new Map();
  const add = (item) => {
    const label = String(item.label || item.model || item.name || "").trim();
    if (!label || !/(gpt|o[0-9]|o-mini|codex|embedding|claude|gemini)/i.test(label)) return;
    const input = normalizePriceNumber(item.input ?? item.input_price ?? item.inputPrice ?? item.prompt);
    const cachedInput = normalizePriceNumber(item.cachedInput ?? item.cached_input ?? item.cache_read ?? item.cached);
    const cacheWriteInput = normalizePriceNumber(item.cacheWriteInput ?? item.cache_write_input ?? item.cache_creation ?? item.cacheWrite);
    const output = normalizePriceNumber(item.output ?? item.output_price ?? item.outputPrice ?? item.completion);
    if (![input, output].every(Number.isFinite)) return;
    const pattern = label.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    found.set(label, {
      pattern,
      label,
      input,
      cachedInput: Number.isFinite(cachedInput) ? cachedInput : input,
      cacheWriteInput: Number.isFinite(cacheWriteInput) ? cacheWriteInput : (Number.isFinite(cachedInput) ? cachedInput : input),
      output
    });
  };
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach(visit);
    add(value);
    Object.values(value).forEach(visit);
  };
  for (const match of html.matchAll(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(match[1])); } catch { /* Not all embedded scripts are JSON. */ }
  }
  const rows = html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const row of rows) {
    const cells = [...row[1].matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)]
      .map((cell) => cell[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (cells.length < 3) continue;
    const numbers = cells.slice(1).map(normalizePriceNumber).filter(Number.isFinite);
    if (numbers.length >= 2) add({ label: cells[0], input: numbers[0], cachedInput: numbers[1], cacheWriteInput: numbers[1], output: numbers[numbers.length - 1] });
  }
  return [...found.values()];
}

async function fetchPricingPage() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, OFFICIAL_TIMEOUT_MS));
  try {
    const response = await fetch(PRICING_SOURCE, {
      headers: { "user-agent": "Codex-Token-Lens/1.0", accept: "text/html,application/xhtml+xml" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Pricing page returned HTTP ${response.status}`);
    const html = await response.text();
    const models = extractPricingFromHtml(html);
    if (!models.length) throw new Error("No model prices found; the pricing page may require JavaScript or changed format");
    const payload = { source: PRICING_SOURCE, updatedAt: new Date().toISOString(), unit: "USD per 1M tokens", models };
    const temporary = `${BUNDLED_PRICING_FILE}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(payload, null, 2) + "\n", "utf8");
    fs.renameSync(temporary, BUNDLED_PRICING_FILE);
    PRICES_PER_MILLION = compilePricing(models);
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function listJsonlFiles(root) {
  const result = [];
  if (!fs.existsSync(root)) return result;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(fullPath);
    }
  }
  return result;
}

function loadTitles() {
  const titles = new Map();
  if (!fs.existsSync(INDEX_PATH)) return titles;
  for (const line of fs.readFileSync(INDEX_PATH, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item.id) titles.set(item.id, item.thread_name || "Untitled session");
    } catch {
      // Active index files can briefly end with an incomplete line.
    }
  }
  return titles;
}

async function parseSession(filePath, stat) {
  const session = {
    filePath,
    signature: `${stat.size}:${stat.mtimeMs}`,
    id: path.basename(filePath, ".jsonl"),
    startedAt: stat.birthtime.toISOString(),
    updatedAt: stat.mtime.toISOString(),
    model: "Codex",
    cwd: "",
    usage: null,
    rateLimits: null,
    usageTimestamp: null,
    parseErrors: 0
  };

  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of lines) {
    const relevant = /"type"\s*:\s*"(?:session_meta|turn_context|token_count)"/.test(line);
    if (!relevant) continue;

    try {
      const event = JSON.parse(line);
      if (event.type === "session_meta") {
        session.id = event.payload?.id || event.payload?.session_id || session.id;
        session.startedAt = event.payload?.timestamp || event.timestamp || session.startedAt;
        session.cwd = event.payload?.cwd || "";
      } else if (event.type === "turn_context") {
        session.model = event.payload?.model || session.model;
        session.cwd = event.payload?.cwd || session.cwd;
      } else if (event.type === "event_msg" && event.payload?.type === "token_count") {
        if (event.payload.info?.total_token_usage) {
          session.usage = event.payload.info.total_token_usage;
          session.usageTimestamp = event.timestamp || session.updatedAt;
        }
        if (event.payload.rate_limits) session.rateLimits = event.payload.rate_limits;
      }
    } catch (error) {
      session.parseErrors += 1;
      if (session.parseErrors <= 3) console.warn(`Unable to parse JSONL event in ${filePath}: ${error.message}`);
    }
  }

  return session;
}

async function mapWithConcurrency(items, limit, mapper) {
  const output = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      output[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

async function scanUsage() {
  const started = Date.now();
  const titles = loadTitles();
  const files = listJsonlFiles(SESSIONS_DIR);
  const activePaths = new Set(files);

  const lastFullScan = Number(cache.fullScanAt || cache.updatedAt || 0);
  const cacheExpired = CACHE_TTL_MS === 0 || !lastFullScan || Date.now() - lastFullScan > CACHE_TTL_MS;
  if (cacheExpired) cache.files = {};
  const sessions = await mapWithConcurrency(files, SCAN_CONCURRENCY, async (filePath) => {
    const stat = fs.statSync(filePath);
    const signature = `${stat.size}:${stat.mtimeMs}`;
    const cached = cache.files[filePath];
    if (cached?.signature === signature) return cached;
    const parsed = await parseSession(filePath, stat);
    cache.files[filePath] = parsed;
    return parsed;
  });

  for (const filePath of Object.keys(cache.files)) {
    if (!activePaths.has(filePath)) delete cache.files[filePath];
  }
  if (cacheExpired) cache.fullScanAt = Date.now();
  saveCache();

  const normalized = sessions
    .filter((item) => item?.usage)
    .map((item) => {
      const usage = item.usage;
      const model = item.model || "Codex";
      const tokenStats = {
        input: Number(usage.input_tokens) || 0,
        cachedInput: Number(usage.cached_input_tokens) || 0,
        cacheWriteInput: Number(usage.cache_write_input_tokens) || 0,
        output: Number(usage.output_tokens) || 0,
        reasoningOutput: Number(usage.reasoning_output_tokens) || 0,
        total: Number(usage.total_tokens) || 0
      };
      const costBreakdown = estimateCost(model, tokenStats);
      return {
        id: item.id,
        name: titles.get(item.id) || path.basename(item.cwd || "") || "Codex session",
        date: String(item.startedAt || item.updatedAt).slice(0, 10),
        startedAt: item.startedAt,
        updatedAt: item.updatedAt,
        model,
        ...tokenStats,
        costUsd: costBreakdown.totalUsd,
        costBreakdown,
        rateLimits: item.rateLimits,
        usageTimestamp: item.usageTimestamp,
        parseErrors: item.parseErrors || 0
      };
    })
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

  const latestLimit = normalized
    .filter((item) => item.rateLimits?.primary || item.rateLimits?.secondary)
    .sort((a, b) => String(b.usageTimestamp).localeCompare(String(a.usageTimestamp)))[0]?.rateLimits || null;

  const official = await queryOfficialUsage();
  return {
    source: process.env.CODEX_HOME ? "$CODEX_HOME/sessions" : "~/.codex/sessions",
    available: fs.existsSync(SESSIONS_DIR),
    scannedAt: new Date().toISOString(),
    scanDurationMs: Date.now() - started,
    sessionCount: normalized.length,
    pricing: {
      unit: "USD per 1M tokens",
      source: PRICING_SOURCE,
      models: PRICES_PER_MILLION.map(({ label, pattern, input, cachedInput, cacheWriteInput, output }) => ({ label, pattern, input, cachedInput, cacheWriteInput, output }))
    },
    costSummary: summarizeCosts(normalized),
    sessions: normalized,
    rateLimits: addRemainingPercent(official?.rateLimits || latestLimit),
    rateLimitsSource: official?.rateLimits ? official.source : (latestLimit ? "local-session-snapshot" : "unavailable"),
    accountUsage: official?.usage || null,
    rateLimitResetCredits: official?.rateLimitResetCredits || null,
    officialQuery: official
      ? { attempted: true, available: Boolean(official.rateLimits), error: official.error }
      : { attempted: false, available: false, error: null },
    diagnostics: {
      cacheTtlMs: CACHE_TTL_MS,
      cacheExpired,
      scanConcurrency: SCAN_CONCURRENCY,
      parseErrorCount: normalized.reduce((total, item) => total + item.parseErrors, 0)
    },
    alerts: {
      dailyCostUsd: Number(process.env.TOKEN_LENS_DAILY_COST_ALERT_USD || 0) || null,
      remainingPercent: Number(process.env.TOKEN_LENS_RATE_LIMIT_ALERT_PERCENT || 10) || 10
    }
  };
}

function estimateCost(model, usage) {
  const pricing = PRICES_PER_MILLION.find((item) => item.match.test(model || ""));
  if (!pricing) {
    return {
      modelMatched: null,
      estimated: false,
      inputUsd: 0,
      cachedInputUsd: 0,
      cacheWriteInputUsd: 0,
      outputUsd: 0,
      totalUsd: 0
    };
  }
  const cachedInput = Number(usage.cachedInput) || 0;
  const cacheWriteInput = Number(usage.cacheWriteInput) || 0;
  const billableInput = Math.max(0, (Number(usage.input) || 0) - cachedInput - cacheWriteInput);
  const output = Number(usage.output) || 0;
  const inputUsd = (billableInput / 1_000_000) * pricing.input;
  const cachedInputUsd = (cachedInput / 1_000_000) * pricing.cachedInput;
  const cacheWriteInputUsd = (cacheWriteInput / 1_000_000) * pricing.cacheWriteInput;
  const outputUsd = (output / 1_000_000) * pricing.output;
  return {
    modelMatched: pricing.label,
    estimated: true,
    inputUsd,
    cachedInputUsd,
    cacheWriteInputUsd,
    outputUsd,
    totalUsd: inputUsd + cachedInputUsd + cacheWriteInputUsd + outputUsd
  };
}

function summarizeCosts(sessions) {
  const estimated = sessions.filter((item) => item.costBreakdown?.estimated);
  return {
    estimatedSessionCount: estimated.length,
    unpricedSessionCount: sessions.length - estimated.length,
    totalUsd: estimated.reduce((total, item) => total + Number(item.costUsd || 0), 0)
  };
}

function getUsage() {
  if (!scanPromise) {
    scanPromise = scanUsage().finally(() => {
      scanPromise = null;
    });
  }
  return scanPromise;
}

function normalizeOfficialWindow(window) {
  if (!window) return null;
  const usedPercent = Math.min(100, Math.max(0, Number(window.usedPercent) || 0));
  return {
    used_percent: usedPercent,
    remaining_percent: 100 - usedPercent,
    window_minutes: Number(window.windowDurationMins) || 0,
    resets_at: window.resetsAt == null ? null : Number(window.resetsAt)
  };
}

function addRemainingPercent(snapshot) {
  if (!snapshot) return null;
  const normalize = (window) => {
    if (!window) return null;
    const used = Math.min(100, Math.max(0, Number(window.used_percent) || 0));
    return { ...window, used_percent: used, remaining_percent: 100 - used };
  };
  return { ...snapshot, primary: normalize(snapshot.primary), secondary: normalize(snapshot.secondary) };
}

function normalizeOfficialRateLimits(result) {
  const snapshot = result?.rateLimitsByLimitId?.codex || Object.values(result?.rateLimitsByLimitId || {})[0] || result?.rateLimits;
  if (!snapshot) return null;
  return {
    limit_id: snapshot.limitId ?? "codex",
    limit_name: snapshot.limitName ?? null,
    primary: normalizeOfficialWindow(snapshot.primary),
    secondary: normalizeOfficialWindow(snapshot.secondary),
    credits: snapshot.credits ?? null,
    individual_limit: snapshot.individualLimit ?? null,
    plan_type: snapshot.planType ?? null,
    rate_limit_reached_type: snapshot.rateLimitReachedType ?? null,
    spend_control_reached: snapshot.spendControlReached ?? null
  };
}

function resolveCodexCommand() {
  if (process.env.TOKEN_LENS_CODEX_COMMAND) return process.env.TOKEN_LENS_CODEX_COMMAND;
  return process.platform === "win32" ? "codex.cmd" : "codex";
}

function resolveCodexExtraArgs() {
  try {
    const parsed = JSON.parse(process.env.TOKEN_LENS_CODEX_ARGS_JSON || "[]");
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function queryOfficialUsage() {
  if (OFFICIAL_USAGE_MODE === "0" || OFFICIAL_USAGE_MODE.toLowerCase() === "off") return Promise.resolve(null);
  const now = Date.now();
  if (now - officialUsageCache.at < 20000) return Promise.resolve(officialUsageCache.value);
  if (officialUsagePromise) return officialUsagePromise;

  officialUsagePromise = new Promise((resolve) => {
    const command = resolveCodexCommand();
    const args = [...resolveCodexExtraArgs(), "app-server", "--stdio"];
    const childEnv = {
      ...process.env,
      CODEX_HOME: CODEX_DIR,
      HOME: os.homedir(),
      USERPROFILE: os.homedir()
    };
    const child = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command)
      ? spawn("cmd.exe", ["/d", "/s", "/c", `${command} ${args.join(" ")}`], { env: childEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
      : spawn(command, args, { env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    let stderr = "";
    let settled = false;
    const pending = new Set();
    const responses = new Map();
    const completed = new Set();
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      officialUsageCache = { at: Date.now(), value };
      officialUsagePromise = null;
      resolve(value);
    };
    const unavailable = (error) => ({ source: "codex-app-server", authoritative: false, rateLimits: null, usage: null, rateLimitResetCredits: null, error });
    const timer = setTimeout(() => finish(unavailable("Official Codex app-server query timed out")), OFFICIAL_TIMEOUT_MS);
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const request = (id, method, params = null) => send({ id, method, params });
    child.on("error", (error) => finish(unavailable(error.message)));
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2000);
    });
    child.on("exit", (code) => {
      const detail = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" / ");
      finish(unavailable(detail ? `Official Codex app-server exited (${code ?? "signal"}): ${detail}` : "Official Codex app-server exited before responding"));
    });
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) {
            finish(unavailable(message.error.message || "Official Codex app-server initialization failed"));
            continue;
          }
          send({ method: "initialized" });
          pending.add(2);
          pending.add(3);
          request(2, "account/rateLimits/read");
          request(3, "account/usage/read");
          continue;
        }
        if (!message.id || !pending.has(message.id)) continue;
        responses.set(message.id, message.result || null);
        completed.add(message.id);
        if (completed.has(2) && completed.has(3)) {
          const rateLimits = normalizeOfficialRateLimits(responses.get(2));
          const usage = responses.get(3);
          finish({
            source: "codex-app-server",
            authoritative: Boolean(rateLimits),
            rateLimits,
            usage: usage || null,
            rateLimitResetCredits: responses.get(2)?.rateLimitResetCredits || null,
            error: rateLimits ? null : "Official rate-limit snapshot unavailable"
          });
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "codex-token-lens", version: "1.0.0" }, capabilities: { experimentalApi: true } } });
  }).catch(() => {
    officialUsagePromise = null;
    const value = { source: "codex-app-server", authoritative: false, rateLimits: null, usage: null, error: "Official Codex app-server query failed" };
    officialUsageCache = { at: Date.now(), value };
    return value;
  });
  return officialUsagePromise;
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...securityHeaders()
  });
  response.end(JSON.stringify(value));
}

function isAuthorized(request, requestUrl) {
  if (!API_TOKEN) return true;
  const supplied = request.headers["x-token-lens-token"] || requestUrl.searchParams.get("token") || "";
  const expected = Buffer.from(API_TOKEN);
  const actual = Buffer.from(String(supplied));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function serveStatic(request, response) {
  const requestPath = new URL(request.url, `http://${HOST}`).pathname;
  let relative;
  try {
    relative = requestPath === "/" ? "index.html" : decodeURIComponent(requestPath.slice(1));
  } catch {
    response.writeHead(400, securityHeaders());
    return response.end("Bad request");
  }
  const resolved = path.resolve(APP_DIR, relative);
  if (!resolved.startsWith(`${path.resolve(APP_DIR)}${path.sep}`) && resolved !== path.join(APP_DIR, "index.html")) {
    response.writeHead(403);
    return response.end("Forbidden");
  }
  fs.readFile(resolved, (error, body) => {
    if (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500);
      return response.end(error.code === "ENOENT" ? "Not found" : "Read error");
    }
    response.writeHead(200, {
      "Content-Type": MIME[path.extname(resolved)] || "application/octet-stream",
      "Cache-Control": "no-cache",
      ...securityHeaders()
    });
    response.end(body);
  });
}

function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  };
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${HOST}`);
  const requestPath = requestUrl.pathname;
  if (request.method === "POST" && requestPath === "/api/pricing/update") {
    if (!isAuthorized(request, requestUrl)) return sendJson(response, 401, { error: "Invalid or missing Token Lens API token" });
    try {
      return sendJson(response, 200, { ok: true, pricing: await fetchPricingPage() });
    } catch (error) {
      try { fs.rmSync(`${BUNDLED_PRICING_FILE}.tmp`, { force: true }); } catch { /* Keep the last valid pricing file. */ }
      console.warn(`Unable to update pricing: ${error.message}`);
      return sendJson(response, 502, { ok: false, error: `Unable to update pricing: ${error.message}` });
    }
  }
  if (request.method !== "GET") {
    response.writeHead(405);
    return response.end("Method not allowed");
  }
  if (requestPath === "/api/usage") {
    if (!isAuthorized(request, requestUrl)) return sendJson(response, 401, { error: "Invalid or missing Token Lens API token" });
    try {
      return sendJson(response, 200, await getUsage());
    } catch (error) {
      return sendJson(response, 500, {
        error: "Unable to read Codex usage statistics",
        detail: error.code === "ENOENT" ? `Missing sessions directory: ${SESSIONS_DIR}` : error.message
      });
    }
  }
  serveStatic(request, response);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Token Lens may already be running, or set TOKEN_LENS_PORT to another port.`);
  } else {
    console.error(`Token Lens failed to start: ${error.message}`);
  }
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  const activePort = typeof address === "object" ? address.port : PORT;
  console.log(`\nCodex Token Lens started: http://${HOST}:${activePort}`);
  console.log(`Data source: ${SESSIONS_DIR}`);
  console.log("Read-only token totals, models, limits, and session titles. Press Ctrl+C to stop.\n");
});
