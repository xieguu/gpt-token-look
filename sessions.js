const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const CACHE_VERSION = 2;

function localDateIso(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function createSessionsService({ codexDir, cacheDir, cacheTtlMs, scanConcurrency }) {
  const sessionsDir = path.join(codexDir, "sessions");
  const indexPath = path.join(codexDir, "session_index.jsonl");
  const cacheId = crypto.createHash("sha256").update(codexDir).digest("hex").slice(0, 12);
  const cachePath = path.join(cacheDir, `usage-${cacheId}.json`);
  let cache = loadCache(cachePath);

  function loadTitles() {
    const titles = new Map();
    if (!fs.existsSync(indexPath)) return titles;
    for (const line of fs.readFileSync(indexPath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (item.id) titles.set(item.id, item.thread_name || "Untitled session");
      } catch {
        // The active index can briefly end with an incomplete line.
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
      rateLimitsTimestamp: null,
      parseErrors: 0
    };

    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!/"type"\s*:\s*"(?:session_meta|turn_context|token_count)"/.test(line)) continue;
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
          if (event.payload.rate_limits) {
            session.rateLimits = event.payload.rate_limits;
            session.rateLimitsTimestamp = event.timestamp || session.updatedAt;
          }
        }
      } catch (error) {
        session.parseErrors += 1;
        if (session.parseErrors <= 3) console.warn(`Unable to parse JSONL event in ${filePath}: ${error.message}`);
      }
    }
    return session;
  }

  async function scan() {
    const started = Date.now();
    const titles = loadTitles();
    const files = listJsonlFiles(sessionsDir);
    const activePaths = new Set(files);
    const lastFullScan = Number(cache.fullScanAt || cache.updatedAt || 0);
    const cacheExpired = cacheTtlMs === 0 || !lastFullScan || Date.now() - lastFullScan > cacheTtlMs;
    if (cacheExpired) cache.files = {};

    const parsedSessions = await mapWithConcurrency(files, scanConcurrency, async (filePath) => {
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
    saveCache(cachePath, cacheDir, cache);

    const sessions = parsedSessions
      .filter((item) => item?.usage)
      .map((item) => normalizeSession(item, titles))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const latestLimitSession = sessions
      .filter((item) => item.rateLimits?.primary || item.rateLimits?.secondary)
      .sort((a, b) => String(b.rateLimitsTimestamp || b.usageTimestamp || "").localeCompare(String(a.rateLimitsTimestamp || a.usageTimestamp || "")))[0];

    return {
      source: process.env.CODEX_HOME ? "$CODEX_HOME/sessions" : "~/.codex/sessions",
      available: fs.existsSync(sessionsDir),
      scannedAt: new Date().toISOString(),
      scanDurationMs: Date.now() - started,
      sessionCount: sessions.length,
      sessions,
      latestRateLimits: latestLimitSession?.rateLimits || null,
      latestRateLimitsUpdatedAt: latestLimitSession?.rateLimitsTimestamp || latestLimitSession?.usageTimestamp || null,
      diagnostics: {
        cacheTtlMs,
        cacheExpired,
        scanConcurrency,
        parseErrorCount: sessions.reduce((total, item) => total + item.parseErrors, 0)
      }
    };
  }

  return { scan, sessionsDir };
}

function normalizeSession(item, titles) {
  const usage = item.usage;
  const tokenStats = {
    input: Number(usage.input_tokens) || 0,
    cachedInput: Number(usage.cached_input_tokens) || 0,
    cacheWriteInput: Number(usage.cache_write_input_tokens) || 0,
    output: Number(usage.output_tokens) || 0,
    reasoningOutput: Number(usage.reasoning_output_tokens) || 0,
    total: Number(usage.total_tokens) || 0
  };
  return {
    id: item.id,
    name: titles.get(item.id) || path.basename(item.cwd || "") || "Codex session",
    date: localDateIso(item.startedAt || item.updatedAt),
    startedAt: item.startedAt,
    updatedAt: item.updatedAt,
    model: item.model || "Codex",
    ...tokenStats,
    rateLimits: item.rateLimits,
    usageTimestamp: item.usageTimestamp,
    rateLimitsTimestamp: item.rateLimitsTimestamp,
    parseErrors: item.parseErrors || 0
  };
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

function loadCache(cachePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    return parsed && parsed.version === CACHE_VERSION
      ? parsed
      : { version: CACHE_VERSION, files: {}, fullScanAt: 0 };
  } catch {
    return { version: CACHE_VERSION, files: {}, fullScanAt: 0 };
  }
}

function saveCache(cachePath, cacheDir, cache) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const temporary = `${cachePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(cache), "utf8");
    fs.renameSync(temporary, cachePath);
  } catch (error) {
    console.warn(`Unable to write incremental cache; continuing without cache: ${error.message}`);
  }
}

module.exports = { createSessionsService, localDateIso };
