#!/usr/bin/env node
/**
 * Provider comparison: what do Tavily and Firecrawl add on top of Grok (search) and Direct (fetch)?
 *
 * The agent never sees this because `--provider auto` only shows the winner. Here every case runs
 * each provider separately so the losing answers are visible too.
 *
 *   node benchmarks/provider-compare.mjs --part search|fetch|map|all --out DIR
 *
 * Writes one JSON per case into DIR plus summary-<part>.json, and prints a compact table.
 * Costs real money/credits: ~10 Grok searches, ~10 Tavily/Firecrawl searches each, ~12 URLs x 3 fetch
 * providers, 2 maps. Firecrawl bills an X post at ~30 credits.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { normalizeSourceUrl } from "../scripts/lib/sources.js";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// --- cases -----------------------------------------------------------------------------------

// `target` is the host/path pattern of the page a careful human would cite. "Hit" per channel =
// at least one URL matching it.
const SEARCH_CASES = [
  { id: "s01-node-lts", query: "Node.js 24 LTS release date", args: [], target: /nodejs\.org|github\.com\/nodejs\/Release/i },
  { id: "s02-xai-pricing", query: "xAI grok-4-fast pricing per million tokens", args: [], target: /docs\.x\.ai|x\.ai\/(api|news)/i },
  { id: "s03-firecrawl-docs", query: "Firecrawl v2 search API includeDomains parameter", args: [], target: /docs\.firecrawl\.dev/i },
  { id: "s04-tavily-docs", query: "Tavily search API include_domains_mode", args: [], target: /docs\.tavily\.com/i },
  { id: "s05-openai-responses", query: "OpenAI Responses API max_tool_calls", args: [], target: /platform\.openai\.com|developers\.openai\.com/i },
  {
    id: "s06-github-scoped",
    query: "pi coding agent skills search",
    args: ["--responses-allowed-domains", "github.com", "--instructions", "只要仓库链接和一句话说明，中文"],
    target: /github\.com/i,
  },
  { id: "s07-rust-release", query: "latest Rust stable release announcement", args: [], target: /blog\.rust-lang\.org|releases\.rs/i },
  { id: "s08-vite-zh", query: "Vite 最新版本 迁移指南 破坏性变更", args: [], target: /vite\.dev|vitejs\.dev/i },
  { id: "s09-k8s-deprecations", query: "Kubernetes latest release deprecated APIs removed", args: [], target: /kubernetes\.io/i },
  {
    id: "s10-x-reactions",
    query: "grok 4.6 coding agent developer reactions",
    args: ["--source", "x", "--x-from-date", "2026-08-15"],
    target: /x\.com\/[^/]+\/status\//i,
  },
];

// `expect` is a phrase the real page contains; a provider that returns text without it returned
// a shell (login wall, player chrome, cookie banner), not the page.
const FETCH_CASES = [
  { id: "f01-github-readme", url: "https://github.com/nodejs/Release", expect: /release schedule/i, kind: "github" },
  { id: "f02-mintlify-spa", url: "https://docs.firecrawl.dev/api-reference/endpoint/search", expect: /includeDomains/i, kind: "spa-docs" },
  { id: "f03-tavily-docs", url: "https://docs.tavily.com/documentation/api-reference/endpoint/search", expect: /include_domains_mode/i, kind: "spa-docs" },
  { id: "f04-x-post", url: "https://x.com/kunchenguid/status/2087942296721559607", expect: /unbiased review/i, kind: "x-post" },
  { id: "f05-hn-front", url: "https://news.ycombinator.com/", expect: /points by/i, kind: "static" },
  { id: "f06-reddit", url: "https://www.reddit.com/r/rust/", expect: /r\/rust/i, kind: "anti-bot" },
  { id: "f07-arxiv-pdf", url: "https://arxiv.org/pdf/1706.03762", expect: /attention is all you need/i, kind: "pdf" },
  { id: "f08-rust-blog", url: "https://blog.rust-lang.org/", expect: /Announcing Rust 1\./i, kind: "static" },
  { id: "f09-ruanyifeng", url: "https://www.ruanyifeng.com/blog/", expect: /科技爱好者周刊/, kind: "static-zh" },
  { id: "f10-wikipedia", url: "https://en.wikipedia.org/wiki/Node.js", expect: /JavaScript runtime/i, kind: "static" },
  { id: "f11-xai-docs", url: "https://docs.x.ai/docs/models", expect: /grok-4/i, kind: "spa-docs" },
  { id: "f12-youtube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", expect: /Rick Astley/i, kind: "video" },
];
const FETCH_PROVIDERS = ["tavily", "firecrawl", "direct", "auto"];

const MAP_CASES = [
  { id: "m01-firecrawl-docs-tavily", url: "https://docs.firecrawl.dev", args: ["--provider", "tavily", "--limit", "30"] },
  { id: "m02-firecrawl-docs-tavily-instr", url: "https://docs.firecrawl.dev", args: ["--provider", "tavily", "--limit", "30", "--instructions", "only API reference endpoint pages"] },
  { id: "m03-firecrawl-docs-direct", url: "https://docs.firecrawl.dev", args: ["--provider", "direct", "--limit", "30"] },
  { id: "m04-nodejs-tavily", url: "https://nodejs.org", args: ["--provider", "tavily", "--limit", "30"] },
  { id: "m05-nodejs-direct", url: "https://nodejs.org", args: ["--provider", "direct", "--limit", "30"] },
];

// --- helpers ---------------------------------------------------------------------------------

async function runScript(script, args) {
  const started = performance.now();
  let stdout = "";
  let stderr = "";
  let code = 0;
  try {
    ({ stdout, stderr } = await execFileAsync("node", [path.join(ROOT, "scripts", script), ...args], {
      cwd: ROOT,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 300_000,
    }));
  } catch (error) {
    stdout = error.stdout || "";
    stderr = error.stderr || "";
    code = typeof error.code === "number" ? error.code : 1;
  }
  const wallMs = Math.round(performance.now() - started);
  let output = null;
  try {
    output = JSON.parse(stdout);
  } catch {
    output = { error: { message: `non-JSON stdout: ${stdout.slice(0, 200)}`, code: "PARSE" } };
  }
  return { output, stderr: stderr.trim(), code, wallMs };
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function shortLineRatio(text) {
  const lines = String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  return Number((lines.filter((line) => line.length < 20).length / lines.length).toFixed(2));
}

function pad(value, width) {
  const s = String(value ?? "");
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

// --- search ----------------------------------------------------------------------------------

async function searchCase(c, outDir) {
  const run = await runScript("search.js", [...c.args, c.query]);
  const out = run.output || {};
  const row = { id: c.id, query: c.query, args: c.args, wall_ms: run.wallMs, code: run.code, error: out.error?.message ?? null };
  const recordPath = out.sources?.raw_path;
  if (!recordPath) {
    await writeFile(path.join(outDir, `${c.id}.json`), JSON.stringify({ case: c, row, stdout: out }, null, 2));
    return row;
  }
  const record = await readJson(recordPath);
  const grok = record.sources?.grok || [];
  const extra = record.sources?.extra || [];
  const grokKeys = new Set(grok.map((s) => normalizeSourceUrl(s.url)));
  const citations = grok.filter((s) => s.source_type === "citation");

  const byProvider = {};
  for (const provider of ["tavily", "firecrawl"]) {
    const list = extra.filter((s) => s.provider === provider);
    const attempt = (out.diagnostics?.provider_attempts || []).find((a) => a.provider === provider) || {};
    byProvider[provider] = {
      count: list.length,
      unique_vs_grok: list.filter((s) => !grokKeys.has(normalizeSourceUrl(s.url))).length,
      with_title: list.filter((s) => s.title && !/^\[?\d+\]?$/.test(s.title)).length,
      with_text: list.filter((s) => s.snippet || s.description || s.content).length,
      with_date: list.filter((s) => s.published_date).length,
      off_domain: attempt.off_domain ?? 0,
      hit: list.some((s) => c.target.test(s.url)),
      hit_urls: list.filter((s) => s.url && c.target.test(s.url)).map((s) => s.url).slice(0, 3),
      attempt: { ok: attempt.ok, skipped: attempt.skipped ?? false, error: attempt.error ?? null, duration_ms: attempt.duration_ms ?? null },
      hosts: [...new Set(list.map((s) => hostOf(s.url)))],
    };
  }

  const items = out.sources?.items || [];
  Object.assign(row, {
    cost_usd: out.diagnostics?.cost_usd ?? null,
    duration_ms: out.diagnostics?.duration_ms ?? null,
    tool_calls: out.diagnostics?.responses_tool_calls ?? null,
    budget: out.diagnostics?.search_budget ?? null,
    extra_domain_filter: out.diagnostics?.options?.extra_domain_filter ?? null,
    grok: {
      citations: citations.length,
      searched: grok.length - citations.length,
      with_title: grok.filter((s) => s.title).length,
      with_text: grok.filter((s) => s.snippet).length,
      hit_citation: citations.some((s) => c.target.test(s.url)),
      hit_any: grok.some((s) => c.target.test(s.url)),
      citation_urls: citations.map((s) => s.url).slice(0, 5),
    },
    extra: byProvider,
    items: {
      shown: items.length,
      total: out.sources?.total ?? null,
      omitted: out.sources?.omitted ?? null,
      merged_from_extra: items.filter((s) => Array.isArray(s.merged_from) && s.merged_from.some((p) => p === "tavily" || p === "firecrawl")).length,
      extra_shown: items.filter((s) => s.provider === "tavily" || s.provider === "firecrawl").length,
      title_from_merge: items.filter((s) => s.provider === "grok-responses" && s.title && s.merged_from?.length).length,
    },
    answer_head: (out.answer?.text || "").slice(0, 240),
    warnings: out.diagnostics?.warnings || [],
    record_path: recordPath,
  });
  await writeFile(path.join(outDir, `${c.id}.json`), JSON.stringify({ case: { ...c, target: String(c.target) }, row, stdout: out }, null, 2));
  return row;
}

function printSearch(rows) {
  console.log("\n== search: hit = a URL matching the case's target pattern ==");
  console.log(
    [pad("case", 22), pad("cost", 7), pad("grok cit/srch", 14), pad("grok hit", 9), pad("tavily n/uniq/hit", 18), pad("firecrawl n/uniq/hit", 21), pad("merged", 7), "extra shown"].join(" ")
  );
  for (const r of rows) {
    if (r.error) {
      console.log(`${pad(r.id, 22)} ERROR ${r.error}`);
      continue;
    }
    const t = r.extra.tavily;
    const f = r.extra.firecrawl;
    console.log(
      [
        pad(r.id, 22),
        pad(r.cost_usd?.toFixed?.(3) ?? "-", 7),
        pad(`${r.grok.citations}/${r.grok.searched}`, 14),
        pad(r.grok.hit_citation ? "cit" : r.grok.hit_any ? "srch" : "no", 9),
        pad(`${t.count}/${t.unique_vs_grok}/${t.hit ? "y" : "n"}${t.attempt.skipped ? " skip" : t.attempt.ok === false ? " ERR" : ""}`, 18),
        pad(`${f.count}/${f.unique_vs_grok}/${f.hit ? "y" : "n"}${f.attempt.skipped ? " skip" : f.attempt.ok === false ? " ERR" : ""}`, 21),
        pad(r.items.merged_from_extra, 7),
        `${r.items.extra_shown}/${r.items.shown}`,
      ].join(" ")
    );
  }
}

// --- fetch -----------------------------------------------------------------------------------

async function fetchOne(c, provider) {
  const run = await runScript("fetch.js", ["--provider", provider, c.url]);
  const out = run.output || {};
  let content = out.content?.text || "";
  const runPath = out.diagnostics?.run_path;
  if (runPath) {
    try {
      const record = await readJson(runPath);
      if (typeof record.content === "string") content = record.content;
    } catch {
      // keep preview
    }
  }
  const attempts = out.diagnostics?.provider_attempts || [];
  const winner = out.diagnostics?.provider ?? null;
  const credits = attempts.reduce((sum, a) => sum + (Number.isFinite(a.credits_used) ? a.credits_used : 0), 0);
  const metadata = out.metadata || {};
  return {
    provider,
    ok: !out.error,
    winner,
    error: out.error?.message ?? null,
    wall_ms: run.wallMs,
    chars: content.length,
    expect: c.expect.test(content),
    short_line_ratio: shortLineRatio(content),
    metadata_fields: ["title", "description", "author", "published_at", "language"].filter((k) => metadata[k]),
    credits_used: credits || null,
    attempts: attempts.map((a) => ({ provider: a.provider, ok: a.ok, skipped: a.skipped ?? false, error: a.error ? String(a.error).slice(0, 120) : null, credits_used: a.credits_used ?? null })),
    warnings: out.diagnostics?.warnings || [],
    head: content.slice(0, 200),
  };
}

async function fetchCase(c, outDir) {
  const results = await Promise.all(FETCH_PROVIDERS.map((provider) => fetchOne(c, provider)));
  const row = { id: c.id, url: c.url, kind: c.kind, providers: Object.fromEntries(results.map((r) => [r.provider, r])) };
  await writeFile(path.join(outDir, `${c.id}.json`), JSON.stringify({ case: { ...c, expect: String(c.expect) }, row }, null, 2));
  return row;
}

function fetchCell(r) {
  if (!r.ok) return `ERR ${r.wall_ms}ms`;
  return `${r.expect ? "ok" : "SHELL"} ${r.chars}c ${r.wall_ms}ms${r.credits_used ? ` ${r.credits_used}cr` : ""}${r.metadata_fields.length ? ` m${r.metadata_fields.length}` : ""}`;
}

function printFetch(rows) {
  console.log("\n== fetch: ok = page phrase found, SHELL = text without it, m<n> = metadata fields, cr = Firecrawl credits ==");
  console.log([pad("case", 20), pad("kind", 10), pad("tavily", 26), pad("firecrawl", 26), pad("direct", 26), "auto (winner)"].join(" "));
  for (const r of rows) {
    const p = r.providers;
    console.log(
      [pad(r.id, 20), pad(r.kind, 10), pad(fetchCell(p.tavily), 26), pad(fetchCell(p.firecrawl), 26), pad(fetchCell(p.direct), 26), `${fetchCell(p.auto)} <- ${p.auto.winner ?? "-"}`].join(" ")
    );
  }
}

// --- map -------------------------------------------------------------------------------------

async function mapCase(c, outDir) {
  const run = await runScript("map.js", [...c.args, c.url]);
  const out = run.output || {};
  const urls = out.urls || [];
  const row = {
    id: c.id,
    url: c.url,
    args: c.args,
    ok: !out.error,
    error: out.error?.message ?? null,
    wall_ms: run.wallMs,
    provider: out.diagnostics?.provider ?? null,
    count: urls.length,
    api_ref_share: urls.length ? Number((urls.filter((u) => /api-reference/i.test(u)).length / urls.length).toFixed(2)) : null,
    hosts: [...new Set(urls.map(hostOf))],
    sample: urls.slice(0, 5),
    warnings: out.diagnostics?.warnings || [],
  };
  await writeFile(path.join(outDir, `${c.id}.json`), JSON.stringify({ case: c, row, stdout: out }, null, 2));
  return row;
}

function printMap(rows) {
  console.log("\n== map ==");
  for (const r of rows) {
    console.log(`${pad(r.id, 34)} ${r.ok ? "ok " : "ERR"} ${pad(r.count, 4)} urls ${pad(r.wall_ms + "ms", 8)} api-ref share ${r.api_ref_share ?? "-"} ${r.error ?? ""}`);
  }
}

// --- main ------------------------------------------------------------------------------------

const argv = process.argv.slice(2);
const part = argv.includes("--part") ? argv[argv.indexOf("--part") + 1] : "all";
const outDir = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : path.join(ROOT, "benchmarks", "results", "provider-compare");
await mkdir(outDir, { recursive: true });

if (part === "search" || part === "all") {
  const rows = [];
  for (const c of SEARCH_CASES) {
    process.stderr.write(`search ${c.id}...\n`);
    rows.push(await searchCase(c, outDir));
  }
  await writeFile(path.join(outDir, "summary-search.json"), JSON.stringify(rows, null, 2));
  printSearch(rows);
}
if (part === "fetch" || part === "all") {
  const rows = [];
  for (const c of FETCH_CASES) {
    process.stderr.write(`fetch ${c.id}...\n`);
    rows.push(await fetchCase(c, outDir));
  }
  await writeFile(path.join(outDir, "summary-fetch.json"), JSON.stringify(rows, null, 2));
  printFetch(rows);
}
if (part === "map" || part === "all") {
  const rows = [];
  for (const c of MAP_CASES) {
    process.stderr.write(`map ${c.id}...\n`);
    rows.push(await mapCase(c, outDir));
  }
  await writeFile(path.join(outDir, "summary-map.json"), JSON.stringify(rows, null, 2));
  printMap(rows);
}
