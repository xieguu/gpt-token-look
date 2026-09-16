const https = require("node:https");
const path = require("node:path");

const GITHUB_API_HOST = "api.github.com";
const GIST_API_PATH = "/gists";

function createGistService() {
  function makeGitHubRequest(method, pathname, token, body = null) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: GITHUB_API_HOST,
        port: 443,
        path: pathname,
        method: method,
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/vnd.github.v3+json",
          "User-Agent": "gpt-token-look",
          "Content-Type": "application/json"
        }
      };

      if (body) {
        const bodyStr = JSON.stringify(body);
        options.headers["Content-Length"] = Buffer.byteLength(bodyStr);
      }

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 400) {
              reject(new Error(`GitHub API error ${res.statusCode}: ${parsed.message || data}`));
            } else {
              resolve(parsed);
            }
          } catch (e) {
            reject(new Error(`Failed to parse GitHub response: ${data.slice(0, 200)}`));
          }
        });
      });

      req.on("error", reject);

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  async function uploadToGist(sessions, token, options = {}) {
    const filename = options.filename || "codex-sessions.json";
    const description = options.description || "Codex sessions backup from Token Lens";
    const isPublic = options.isPublic !== false;

    const exportData = {
      version: "1.0",
      exportedAt: new Date().toISOString(),
      source: "gpt-token-look",
      deviceName: options.deviceName || "Unknown",
      sessions: sessions.map((s) => ({
        id: s.id,
        name: s.name,
        date: s.date,
        model: s.model,
        tokens: {
          input: s.input,
          cachedInput: s.cachedInput,
          cacheWriteInput: s.cacheWriteInput,
          output: s.output,
          reasoningOutput: s.reasoningOutput,
          total: s.total
        },
        costUsd: s.costUsd,
        metadata: { startedAt: s.startedAt, updatedAt: s.updatedAt }
      })),
      stats: {
        totalSessions: sessions.length,
        totalTokens: sessions.reduce((sum, s) => sum + (s.total || 0), 0),
        totalCost: sessions.reduce((sum, s) => sum + (s.costUsd || 0), 0)
      }
    };

    const gistBody = {
      description: description,
      public: isPublic,
      files: {
        [filename]: {
          content: JSON.stringify(exportData, null, 2)
        }
      }
    };

    const result = await makeGitHubRequest("POST", GIST_API_PATH, token, gistBody);
    return {
      gistId: result.id,
      gistUrl: result.html_url,
      fileUrl: result.files[filename].raw_url
    };
  }

  async function downloadFromGist(gistId, token) {
    const gistPath = `${GIST_API_PATH}/${gistId}`;
    const result = await makeGitHubRequest("GET", gistPath, token);

    if (!result.files || Object.keys(result.files).length === 0) {
      throw new Error("Gist has no files");
    }

    const firstFile = Object.values(result.files)[0];
    let content;

    if (firstFile.truncated) {
      const response = await new Promise((resolve, reject) => {
        https.get(firstFile.raw_url, (res) => {
          let data = "";
          res.on("data", (chunk) => { data += chunk; });
          res.on("end", () => resolve(data));
          res.on("error", reject);
        }).on("error", reject);
      });
      content = response;
    } else {
      content = firstFile.content;
    }

    const importedData = JSON.parse(content);
    return importedData;
  }

  return { uploadToGist, downloadFromGist };
}

module.exports = { createGistService };
