const fs = require("node:fs");
const path = require("node:path");

const PRICING_SOURCE = "https://platform.openai.com/pricing";

function createPricingService({ appDir, pricingFile, pricesJson, timeoutMs = 5000 }) {
  const bundledPricingFile = path.join(appDir, "pricing.json");
  const configuredFile = pricingFile || bundledPricingFile;
  let state = loadPricingState();

  function loadPricingState() {
    const candidates = pricesJson
      ? [{ label: "TOKEN_LENS_PRICES_JSON", source: pricesJson, metadata: {} }]
      : [
          { label: configuredFile, file: configuredFile },
          ...(configuredFile !== bundledPricingFile ? [{ label: bundledPricingFile, file: bundledPricingFile }] : [])
        ];
    let lastError = null;
    for (const candidate of candidates) {
      try {
        const source = candidate.source ?? fs.readFileSync(candidate.file, "utf8");
        const parsed = JSON.parse(source);
        const models = Array.isArray(parsed) ? parsed : parsed.models;
        if (!Array.isArray(models)) throw new Error("pricing data must be an array or { models: [] }");
        const compiled = compilePricing(models);
        if (!compiled.length) throw new Error("pricing data did not contain any valid model rows");
        const stat = candidate.file ? safeStat(candidate.file) : null;
        const updatedAt = parsed.updatedAt || (stat ? stat.mtime.toISOString() : null);
        return {
          compiled,
          metadata: {
            unit: parsed.unit || "USD per 1M tokens",
            source: parsed.source || PRICING_SOURCE,
            updatedAt,
            updateError: null,
            usingOldPrices: false,
            stale: isPricingStale(updatedAt),
            ageDays: pricingAgeDays(updatedAt)
          }
        };
      } catch (error) {
        lastError = error;
        console.warn(`Invalid pricing configuration (${candidate.label}): ${error.message}`);
      }
    }
    return {
      compiled: [],
      metadata: {
        unit: "USD per 1M tokens",
        source: PRICING_SOURCE,
        updatedAt: null,
        updateError: lastError?.message || "No valid pricing data",
        usingOldPrices: false,
        stale: true,
        ageDays: null
      }
    };
  }

  function getPublicPricing() {
    return {
      ...state.metadata,
      models: state.compiled.map(({ label, pattern, input, cachedInput, cacheWriteInput, output }) => ({
        label, pattern, input, cachedInput, cacheWriteInput, output
      }))
    };
  }

  function estimateCost(model, usage) {
    const pricing = state.compiled.find((item) => item.match.test(model || ""));
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

  async function update() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
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
      const temporary = `${bundledPricingFile}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(payload, null, 2) + "\n", "utf8");
      fs.renameSync(temporary, bundledPricingFile);
      state = {
        compiled: compilePricing(models),
        metadata: {
          unit: payload.unit,
          source: payload.source,
          updatedAt: payload.updatedAt,
          updateError: null,
          usingOldPrices: false,
          stale: false,
          ageDays: 0
        }
      };
      return getPublicPricing();
    } catch (error) {
      state = {
        ...state,
        metadata: {
          ...state.metadata,
          updateError: error.message,
          usingOldPrices: state.compiled.length > 0,
          stale: state.metadata.stale,
          ageDays: pricingAgeDays(state.metadata.updatedAt)
        }
      };
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return { estimateCost, getPublicPricing, update };
}

function compilePricing(models) {
  return models
    .map((item) => {
      const pattern = item.pattern || item.match || item.label;
      if (!pattern) return null;
      let match;
      try {
        match = new RegExp(pattern, "i");
      } catch {
        return null;
      }
      return {
        match,
        pattern,
        label: item.label,
        input: Number(item.input),
        cachedInput: Number(item.cachedInput ?? item.cached_input ?? item.input),
        cacheWriteInput: Number(item.cacheWriteInput ?? item.cache_write_input ?? item.cachedInput ?? item.cached_input ?? item.input),
        output: Number(item.output)
      };
    })
    .filter((item) => item && item.label && Number.isFinite(item.input) && Number.isFinite(item.cachedInput) && Number.isFinite(item.cacheWriteInput) && Number.isFinite(item.output));
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
    try { visit(JSON.parse(match[1])); } catch { /* Ignore unrelated embedded JSON. */ }
  }
  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)]
      .map((cell) => cell[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (cells.length < 3) continue;
    const numbers = cells.slice(1).map(normalizePriceNumber).filter(Number.isFinite);
    if (numbers.length >= 2) add({ label: cells[0], input: numbers[0], cachedInput: numbers[1], cacheWriteInput: numbers[1], output: numbers[numbers.length - 1] });
  }
  return [...found.values()];
}

function safeStat(filePath) {
  try { return fs.statSync(filePath); } catch { return null; }
}

function pricingAgeDays(updatedAt) {
  if (!updatedAt) return null;
  const timestamp = new Date(updatedAt).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((Date.now() - timestamp) / 86400000));
}

function isPricingStale(updatedAt) {
  if (!updatedAt) return true;
  const timestamp = new Date(updatedAt).getTime();
  return !Number.isFinite(timestamp) || Date.now() - timestamp > 30 * 86400000;
}

module.exports = { createPricingService, extractPricingFromHtml, compilePricing, pricingAgeDays };
