const os = require("node:os");
const { spawn } = require("node:child_process");

function createLimitsService({ codexDir, mode = "auto", timeoutMs = 5000, command, extraArgs = [] }) {
  let queryPromise = null;
  let queryCache = { at: 0, value: null };

  function queryOfficialUsage() {
    if (mode === "0" || String(mode).toLowerCase() === "off") return Promise.resolve(null);
    const now = Date.now();
    if (now - queryCache.at < 20000) return Promise.resolve(queryCache.value);
    if (queryPromise) return queryPromise;

    queryPromise = new Promise((resolve) => {
      const executable = command || (process.platform === "win32" ? "codex.cmd" : "codex");
      const args = [...extraArgs, "app-server", "--stdio"];
      const childEnv = {
        ...process.env,
        CODEX_HOME: codexDir,
        HOME: os.homedir(),
        USERPROFILE: os.homedir()
      };
      const child = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable)
        ? spawn("cmd.exe", ["/d", "/s", "/c", `${executable} ${args.join(" ")}`], { env: childEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
        : spawn(executable, args, { env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
      let buffer = "";
      let stderr = "";
      let settled = false;
      const pending = new Set();
      const responses = new Map();
      const completed = new Set();
      const unavailable = (error) => ({
        source: "codex-app-server",
        authoritative: false,
        rateLimits: null,
        usage: null,
        rateLimitResetCredits: null,
        updatedAt: null,
        error
      });
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        queryCache = { at: Date.now(), value };
        queryPromise = null;
        resolve(value);
      };
      const timer = setTimeout(() => finish(unavailable("Official Codex app-server query timed out")), timeoutMs);
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
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
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
            finish({
              source: "codex-app-server",
              authoritative: Boolean(rateLimits),
              rateLimits,
              usage: responses.get(3) || null,
              rateLimitResetCredits: responses.get(2)?.rateLimitResetCredits || null,
              updatedAt: rateLimits ? new Date().toISOString() : null,
              error: rateLimits ? null : "Official rate-limit snapshot unavailable"
            });
          }
        }
      });
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "codex-token-lens", version: "1.0.0" }, capabilities: { experimentalApi: true } } });
    }).catch(() => {
      queryPromise = null;
      const value = {
        source: "codex-app-server",
        authoritative: false,
        rateLimits: null,
        usage: null,
        rateLimitResetCredits: null,
        updatedAt: null,
        error: "Official Codex app-server query failed"
      };
      queryCache = { at: Date.now(), value };
      return value;
    });
    return queryPromise;
  }

  return { queryOfficialUsage };
}

function selectRateLimits(official, localSnapshot, localUpdatedAt) {
  if (official?.rateLimits) {
    return {
      rateLimits: addRemainingPercent(official.rateLimits),
      rateLimitsSource: "codex-app-server",
      rateLimitsUpdatedAt: official.updatedAt || new Date().toISOString()
    };
  }
  if (localSnapshot) {
    return {
      rateLimits: addRemainingPercent(localSnapshot),
      rateLimitsSource: "local-session-snapshot",
      rateLimitsUpdatedAt: localUpdatedAt || null
    };
  }
  return { rateLimits: null, rateLimitsSource: "unavailable", rateLimitsUpdatedAt: null };
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

function addRemainingPercent(snapshot) {
  if (!snapshot) return null;
  const normalize = (window) => {
    if (!window) return null;
    const used = Math.min(100, Math.max(0, Number(window.used_percent) || 0));
    return { ...window, used_percent: used, remaining_percent: 100 - used };
  };
  return { ...snapshot, primary: normalize(snapshot.primary), secondary: normalize(snapshot.secondary) };
}

module.exports = { addRemainingPercent, createLimitsService, normalizeOfficialRateLimits, selectRateLimits };
