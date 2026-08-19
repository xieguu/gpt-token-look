const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const readline = require("node:readline");
const crypto = require("node:crypto");

const HOST = "127.0.0.1";
const PORT = process.env.TOKEN_LENS_PORT === undefined ? 4173 : Number(process.env.TOKEN_LENS_PORT);
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  console.error("TOKEN_LENS_PORT 必须是 0 到 65535 之间的整数。");
  process.exit(1);
}

const APP_DIR = __dirname;
const CODEX_DIR = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const SESSIONS_DIR = path.join(CODEX_DIR, "sessions");
const INDEX_PATH = path.join(CODEX_DIR, "session_index.jsonl");
const CACHE_DIR = process.env.TOKEN_LENS_CACHE_DIR || path.join(os.tmpdir(), "codex-token-lens");
const CACHE_ID = crypto.createHash("sha256").update(CODEX_DIR).digest("hex").slice(0, 12);
const CACHE_PATH = path.join(CACHE_DIR, `usage-${CACHE_ID}.json`);
const PRICING_SOURCE = "https://developers.openai.com/api/docs/models/compare";
const DEFAULT_PRICES_PER_MILLION = [
  { match: /gpt[-\s_]?5\.6[-\s_]?sol/i, label: "GPT-5.6 Sol", input: 5.00, cachedInput: 0.50, output: 30.00 },
  { match: /gpt[-\s_]?5\.6[-\s_]?terra/i, label: "GPT-5.6 Terra", input: 2.00, cachedInput: 0.20, output: 12.00 },
  { match: /gpt[-\s_]?5\.6[-\s_]?luna/i, label: "GPT-5.6 Luna", input: 0.20, cachedInput: 0.02, output: 1.20 }
];
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

let scanPromise = null;
let cache = loadCache();

function loadCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    return parsed && parsed.version === 1 ? parsed : { version: 1, files: {} };
  } catch {
    return { version: 1, files: {} };
  }
}

function saveCache() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const temporary = `${CACHE_PATH}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(cache), "utf8");
    fs.renameSync(temporary, CACHE_PATH);
  } catch (error) {
    console.warn(`无法写入增量缓存，将继续运行：${error.message}`);
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
      if (item.id) titles.set(item.id, item.thread_name || "未命名会话");
    } catch {
      // Ignore a partially-written index line.
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
    usageTimestamp: null
  };

  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of lines) {
    const relevant =
      line.includes('"type":"session_meta"') ||
      line.includes('"type":"turn_context"') ||
      line.includes('"type":"token_count"');
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
    } catch {
      // Active JSONL files can briefly end with an incomplete line.
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

  const sessions = await mapWithConcurrency(files, 3, async (filePath) => {
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
        name: titles.get(item.id) || path.basename(item.cwd || "") || "Codex 会话",
        date: String(item.startedAt || item.updatedAt).slice(0, 10),
        startedAt: item.startedAt,
        updatedAt: item.updatedAt,
        model,
        ...tokenStats,
        costUsd: costBreakdown.totalUsd,
        costBreakdown,
        rateLimits: item.rateLimits,
        usageTimestamp: item.usageTimestamp
      };
    })
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

  const latestLimit = normalized
    .filter((item) => item.rateLimits?.primary || item.rateLimits?.secondary)
    .sort((a, b) => String(b.usageTimestamp).localeCompare(String(a.usageTimestamp)))[0]?.rateLimits || null;

  return {
    source: process.env.CODEX_HOME ? "$CODEX_HOME/sessions" : "~/.codex/sessions",
    available: fs.existsSync(SESSIONS_DIR),
    scannedAt: new Date().toISOString(),
    scanDurationMs: Date.now() - started,
    sessionCount: normalized.length,
    pricing: {
      unit: "USD per 1M tokens",
      source: PRICING_SOURCE,
      models: DEFAULT_PRICES_PER_MILLION.map(({ label, input, cachedInput, output }) => ({ label, input, cachedInput, output }))
    },
    costSummary: summarizeCosts(normalized),
    sessions: normalized,
    rateLimits: latestLimit
  };
}

function estimateCost(model, usage) {
  const pricing = DEFAULT_PRICES_PER_MILLION.find((item) => item.match.test(model || ""));
  if (!pricing) {
    return {
      modelMatched: null,
      estimated: false,
      inputUsd: 0,
      cachedInputUsd: 0,
      outputUsd: 0,
      totalUsd: 0
    };
  }
  const cachedInput = Number(usage.cachedInput) || 0;
  const billableInput = Math.max(0, (Number(usage.input) || 0) - cachedInput);
  const output = Number(usage.output) || 0;
  const inputUsd = (billableInput / 1_000_000) * pricing.input;
  const cachedInputUsd = (cachedInput / 1_000_000) * pricing.cachedInput;
  const outputUsd = (output / 1_000_000) * pricing.output;
  return {
    modelMatched: pricing.label,
    estimated: true,
    inputUsd,
    cachedInputUsd,
    outputUsd,
    totalUsd: inputUsd + cachedInputUsd + outputUsd
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

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...securityHeaders()
  });
  response.end(JSON.stringify(value));
}

function serveStatic(request, response) {
  const requestPath = new URL(request.url, `http://${HOST}`).pathname;
  const relative = requestPath === "/" ? "index.html" : decodeURIComponent(requestPath.slice(1));
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
  if (request.method !== "GET") {
    response.writeHead(405);
    return response.end("Method not allowed");
  }
  const requestPath = new URL(request.url, `http://${HOST}`).pathname;
  if (requestPath === "/api/usage") {
    try {
      return sendJson(response, 200, await getUsage());
    } catch (error) {
      return sendJson(response, 500, {
        error: "无法读取 Codex 会话统计",
        detail: error.code === "ENOENT" ? `未找到 ${SESSIONS_DIR}` : error.message
      });
    }
  }
  serveStatic(request, response);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`端口 ${PORT} 已被占用。Token Lens 可能已经运行，或请设置 TOKEN_LENS_PORT 更换端口。`);
  } else {
    console.error(`Token Lens 启动失败：${error.message}`);
  }
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  const activePort = typeof address === "object" ? address.port : PORT;
  console.log(`\nCodex Token Lens 已启动：http://${HOST}:${activePort}`);
  console.log(`数据来源：${SESSIONS_DIR}`);
  console.log("只读取 Token 汇总、模型和会话标题；按 Ctrl+C 停止。\n");
});
