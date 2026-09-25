const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { finished } = require("node:stream/promises");
const { promisify } = require("node:util");

const CACHE_VERSION = 2;
const statFile = promisify(fs.stat);

function localDateIso(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function createSessionsService({ codexDir, cacheDir, cacheTtlMs = 900000, scanConcurrency = 3 }) {
  const sessionsDir = path.join(codexDir, "sessions");
  const indexPath = path.join(codexDir, "session_index.jsonl");
  const cacheId = crypto.createHash("sha256").update(codexDir).digest("hex").slice(0, 12);
  const cachePath = path.join(cacheDir, `usage-${cacheId}.json`);
  let cache;
  const cacheReady = loadCache(cachePath).then((loaded) => { cache = loaded; });
  let cacheDirty = false;
  let scanPromise = null;
  let sessionIdToPath = null;
  let titleCache = { signature: null, titles: new Map() };
  let summaryCache = null;

  async function loadTitles() {
    try {
      const stat = await fs.promises.stat(indexPath);
      const signature = fileSignature(stat);
      if (titleCache.signature === signature) return titleCache.titles;
      const titles = new Map();
      await readLines(indexPath, (line) => {
        if (!line.trim()) return;
        try {
          const item = JSON.parse(line);
          if (item.id) titles.set(item.id, item.thread_name || "Untitled session");
        } catch {
          // The active index can briefly end with an incomplete line.
        }
      });
      titleCache = { signature, titles };
      return titles;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (titleCache.signature !== null) titleCache = { signature: null, titles: new Map() };
      return titleCache.titles;
    }
  }

  async function parseSession(filePath, stat) {
    const session = {
      filePath,
      signature: fileSignature(stat),
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

    await readLines(filePath, (line) => {
      if (!/"type"\s*:\s*"(?:session_meta|turn_context|token_count)"/.test(line)) return;
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
    });
    return session;
  }

  function scan() {
    if (!scanPromise) scanPromise = scanFiles().finally(() => { scanPromise = null; });
    return scanPromise;
  }

  async function scanFiles() {
    const started = Date.now();
    const [titles, { files, available }] = await Promise.all([loadTitles(), listJsonlFiles(sessionsDir), cacheReady]);
    const lastFullScan = Number(cache.fullScanAt || cache.updatedAt || 0);
    const cacheExpired = cacheTtlMs === 0 || !lastFullScan || Date.now() - lastFullScan > cacheTtlMs;
    let parsedFileCount = 0;

    const entries = await mapWithConcurrency(files, 32, async (filePath) => ({ filePath, stat: await statFile(filePath) }));
    const parsedSessions = await mapWithConcurrency(entries, scanConcurrency, async ({ filePath, stat }) => {
      const signature = fileSignature(stat);
      const cached = cache.files[filePath];
      if (!cacheExpired && cached?.signature === signature) return cached;
      parsedFileCount += 1;
      return parseSession(filePath, stat);
    });

    const cacheChanged = cacheExpired || parsedFileCount > 0 || files.length !== Object.keys(cache.files).length;
    if (cacheChanged) {
      cacheDirty = true;
      cache = {
        version: CACHE_VERSION,
        files: Object.fromEntries(parsedSessions.map((session) => [session.filePath, session])),
        fullScanAt: cacheExpired ? Date.now() : lastFullScan
      };
    }
    if (cacheChanged || !sessionIdToPath) sessionIdToPath = new Map(parsedSessions.map((session) => [session.id, session.filePath]));
    const cacheWritten = cacheDirty ? await saveCache(cachePath, cacheDir, cache) : false;
    if (cacheWritten) cacheDirty = false;

    const summaryReused = Boolean(summaryCache && !cacheChanged && summaryCache.titles === titles);
    if (!summaryReused) {
      const sessions = [];
      let latestLimitSession = null;
      let latestLimitTimestamp = -Infinity;
      let parseErrorCount = 0;
      for (const session of parsedSessions) {
        if (session.usage) sessions.push(normalizeSession(session, titles));
        parseErrorCount += session.parseErrors || 0;
        if (!session.rateLimits?.primary && !session.rateLimits?.secondary) continue;
        const timestamp = Date.parse(session.rateLimitsTimestamp || session.usageTimestamp || session.updatedAt);
        if (Number.isFinite(timestamp) && timestamp > latestLimitTimestamp) {
          latestLimitSession = session;
          latestLimitTimestamp = timestamp;
        }
      }
      sessions.sort((first, second) => String(second.updatedAt).localeCompare(String(first.updatedAt)));
      summaryCache = {
        titles,
        sessions,
        latestRateLimits: latestLimitSession?.rateLimits || null,
        latestRateLimitsUpdatedAt: latestLimitSession?.rateLimitsTimestamp || latestLimitSession?.usageTimestamp || latestLimitSession?.updatedAt || null,
        parseErrorCount
      };
    }

    return {
      source: process.env.CODEX_HOME ? "$CODEX_HOME/sessions" : "~/.codex/sessions",
      available,
      scannedAt: new Date().toISOString(),
      scanDurationMs: Date.now() - started,
      sessionCount: summaryCache.sessions.length,
      sessions: summaryCache.sessions,
      latestRateLimits: summaryCache.latestRateLimits,
      latestRateLimitsUpdatedAt: summaryCache.latestRateLimitsUpdatedAt,
      diagnostics: {
        cacheTtlMs,
        cacheExpired,
        scanConcurrency,
        parsedFileCount,
        cachedFileCount: files.length - parsedFileCount,
        cacheWritten,
        summaryReused,
        parseErrorCount: summaryCache.parseErrorCount
      }
    };
  }

  async function readSessionFull(sessionId) {
    if (scanPromise || !sessionIdToPath?.has(sessionId)) await scan();
    const sessionFile = sessionIdToPath.get(sessionId);
    if (!sessionFile) return null;

    const events = [];
    let model = "Codex";
    await readLines(sessionFile, (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        events.push(event);
        if (event.type === "turn_context") model = event.payload?.model || model;
      }
      catch (error) { console.warn(`Unable to parse JSONL event in ${sessionFile}: ${error.message}`); }
    });

    const titles = await loadTitles();
    const title = titles.get(sessionId) || "Untitled session";

    return { sessionId, title, model, events };
  }

  return { scan, readSessionFull, sessionsDir };
}

async function readLines(filePath, consume) {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  lines.on("error", (error) => stream.destroy(error));
  lines.on("line", (line) => {
    if (stream.destroyed) return;
    try { consume(line); }
    catch (error) { stream.destroy(error); }
  });
  try { await finished(stream); }
  finally {
    lines.close();
    stream.destroy();
  }
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

function fileSignature(stat) {
  return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
}

async function listJsonlFiles(root) {
  const result = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try { entries = await fs.promises.readdir(current, { withFileTypes: true }); }
    catch (error) {
      if (error.code === "ENOENT" && current === root) return { files: [], available: false };
      throw error;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(fullPath);
    }
  }
  return { files: result, available: true };
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

async function loadCache(cachePath) {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(cachePath, "utf8"));
    return parsed && parsed.version === CACHE_VERSION && parsed.files && typeof parsed.files === "object" && !Array.isArray(parsed.files)
      ? parsed
      : { version: CACHE_VERSION, files: {}, fullScanAt: 0 };
  } catch (error) {
    if (error.code !== "ENOENT") console.warn(`Unable to read incremental cache: ${error.message}`);
    return { version: CACHE_VERSION, files: {}, fullScanAt: 0 };
  }
}

async function saveCache(cachePath, cacheDir, cache) {
  const temporary = `${cachePath}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.mkdir(cacheDir, { recursive: true });
    await fs.promises.writeFile(temporary, JSON.stringify(cache), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fs.promises.rename(temporary, cachePath);
    return true;
  } catch (error) {
    console.warn(`Unable to write incremental cache; continuing without cache: ${error.message}`);
    return false;
  } finally {
    await fs.promises.rm(temporary, { force: true }).catch((error) => console.warn(`Unable to remove temporary cache: ${error.message}`));
  }
}

module.exports = { createSessionsService, localDateIso };
