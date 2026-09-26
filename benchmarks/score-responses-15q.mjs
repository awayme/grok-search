#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_SOURCES, DEFAULT_SOURCE_CHARS } from "../scripts/lib/config.js";
import { compactSources, selectSources } from "../scripts/lib/sources.js";
import { benchmarkDate, compilePatterns, questions } from "./lib/benchmark-15q-v2.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = { input: path.join(ROOT, "benchmarks", "results", `responses-15q-${benchmarkDate}.json`), output: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") out.input = path.resolve(argv[++index]);
    else if (arg === "--output") out.output = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!out.output) out.output = out.input.replace(/\.json$/i, ".scored.json");
  return out;
}

function percentile(sortedValues, ratio) {
  if (!sortedValues.length) return null;
  const rank = Math.max(1, Math.ceil(sortedValues.length * ratio));
  return sortedValues[Math.min(sortedValues.length - 1, rank - 1)];
}

function numericStats(values, ratios) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const stats = { total: sorted.reduce((sum, value) => sum + value, 0), max: sorted[sorted.length - 1] };
  for (const [label, ratio] of Object.entries(ratios)) stats[label] = percentile(sorted, ratio);
  return stats;
}

// Approximates the bytes search.js would put on stdout for this result:
// answer plus the capped/compacted source list, using the CLI defaults.
// Diagnostics are excluded, so real stdout runs slightly larger.
function approxStdoutBytes(result) {
  if (!result.ok) return null;
  const selected = selectSources(result.sources || [], { maxSources: DEFAULT_MAX_SOURCES });
  return Buffer.byteLength(
    JSON.stringify({
      answer: result.answer,
      sources: {
        items: compactSources(selected.items, { sourceChars: DEFAULT_SOURCE_CHARS }),
        returned: selected.returned,
        total: selected.total,
        omitted: selected.omitted,
      },
    }),
    "utf8"
  );
}

function matchesOfficial(url, domains) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const normalized = String(url).toLowerCase();
    return domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`) || normalized.includes(domain));
  } catch {
    return false;
  }
}

const args = parseArgs(process.argv.slice(2));
const input = JSON.parse(await readFile(args.input, "utf8"));
const questionById = new Map(questions.map((question) => [question.id, question]));
const scored = input.results.map((result) => {
  const question = questionById.get(result.id);
  if (!question) throw new Error(`Unknown benchmark question: ${result.id}`);
  const answer = String(result.answer || "");
  const criteria = compilePatterns(question.criteria);
  const stale = compilePatterns(question.stale_markers).some((pattern) => pattern.test(answer));
  const hits = criteria.map((pattern) => pattern.test(answer));
  const sourceUrls = (result.sources || []).map((source) => source.url).filter(Boolean);
  const webSearchCalls = result.diagnostics?.responses_web_search_calls;
  const costUsd = result.diagnostics?.cost_usd;
  return {
    ...result,
    score: {
      exact_field_accuracy: hits.length ? hits.filter(Boolean).length / hits.length : 0,
      fully_correct: Boolean(result.ok && hits.length && hits.every(Boolean) && !stale),
      stale_answer: stale,
      official_hit_at_5: sourceUrls.slice(0, 5).some((url) => matchesOfficial(url, question.official_domains)),
      criteria_hits: hits,
    },
    metrics: {
      ...(Number.isFinite(webSearchCalls) ? { web_search_calls: webSearchCalls } : {}),
      ...(Number.isFinite(costUsd) ? { cost_usd: costUsd } : {}),
      ...(result.ok ? { approx_stdout_bytes: approxStdoutBytes(result) } : {}),
    },
  };
});

const successful = scored.filter((item) => item.ok);
const durations = successful.map((item) => item.duration_ms).filter(Number.isFinite);
const payload = {
  ...input,
  scored_at: new Date().toISOString(),
  results: scored,
  summary: {
    completed: scored.length,
    successful: successful.length,
    fully_correct: scored.filter((item) => item.score.fully_correct).length,
    mean_exact_field_accuracy: scored.length
      ? scored.reduce((sum, item) => sum + item.score.exact_field_accuracy, 0) / scored.length
      : 0,
    official_hit_at_5: scored.length ? scored.filter((item) => item.score.official_hit_at_5).length / scored.length : 0,
    avg_duration_ms: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null,
    web_search_calls: numericStats(scored.map((item) => item.metrics.web_search_calls), { p50: 0.5 }),
    cost_usd: numericStats(scored.map((item) => item.metrics.cost_usd), { p50: 0.5, p95: 0.95 }),
    approx_stdout_bytes: numericStats(scored.map((item) => item.metrics.approx_stdout_bytes), { p50: 0.5 }),
  },
};

await mkdir(path.dirname(args.output), { recursive: true });
await writeFile(args.output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output: args.output, summary: payload.summary }));
