#!/usr/bin/env node
/** Reads the Phase 0 metrics log and prints what a run cost.
 *
 *  Usage:  node scripts/run-metrics.mjs [path-to.ndjson] [--per-thread]
 *  Default path: ~/Library/Application Support/unbiased-app/run-metrics.ndjson
 *  (the dev app's userData; a packaged build uses its productName instead)
 *
 *  The log is written only while UNBIASED_AX_METRICS=1. Records are shapes —
 *  verbs, counts, durations — and carry no text from the user's screen. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { rollup } from "../src/main/run-metrics.ts";

const args = process.argv.slice(2);
const perThread = args.includes("--per-thread");
const file = args.find((a) => !a.startsWith("--")) ?? join(homedir(), "Library", "Application Support", "unbiased-app", "run-metrics.ndjson");

let text;
try {
  text = readFileSync(file, "utf8");
} catch (err) {
  console.error(`cannot read ${file}: ${err.message}`);
  console.error("Run the app with UNBIASED_AX_METRICS=1 first.");
  process.exit(1);
}

const records = [];
let skipped = 0;
for (const line of text.split("\n")) {
  if (!line.trim()) continue;
  try {
    records.push(JSON.parse(line));
  } catch {
    skipped++; // a half-written last line after a crash; the rest is still good
  }
}

const ms = (n) => `${(n / 1000).toFixed(1)}s`;
const pct = (a, b) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");

function show(label, rs) {
  const r = rollup(rs);
  const span =
    rs.length > 1 ? new Date(rs.at(-1).at).getTime() - new Date(rs[0].at).getTime() : 0;
  const model = Math.max(0, span - r.toolMs.total);
  console.log(`\n${label}  [${r.shape}]`);
  console.log(`  turns ${r.turns}   tool calls ${r.toolCalls}   driver calls ${r.driverCalls}`);
  console.log(
    `  tokens billed ${r.tokens.billed.total.toLocaleString()} ` +
      `(in ${r.tokens.billed.input.toLocaleString()}, cached ${r.tokens.billed.cached.toLocaleString()}, out ${r.tokens.billed.output.toLocaleString()})` +
      `   context ended at ${r.tokens.context.toLocaleString()}`,
  );
  if (span > 0) {
    console.log(`  wall ${ms(span)}   in tools ${ms(r.toolMs.total)} (${pct(r.toolMs.total, span)})   model+idle ${ms(model)} (${pct(model, span)})`);
  }
  console.log(`  tool ms  p50 ${r.toolMs.p50}  p95 ${r.toolMs.p95}  max ${r.toolMs.max}`);
  console.log(`  driver ms p50 ${r.driverMs.p50}  p95 ${r.driverMs.p95}  max ${r.driverMs.max}`);
  const big = Object.entries(r.largest).map(([u, n]) => `${n} ${u}`).join(", ");
  if (big) console.log(`  largest payload  ${big}`);
  const f = (m) => Object.entries(m).map(([k, n]) => `${k} ${n}`).join(", ") || "none";
  console.log(`  failures  tool: ${f(r.failures.tool)}   driver: ${f(r.failures.driver)}`);
  console.log(`  accepted but nothing changed: ${r.noChange}`);
}

console.log(`${records.length} records from ${file}${skipped ? ` (${skipped} unreadable)` : ""}`);
show("ALL RUNS", records);

if (perThread) {
  const byThread = new Map();
  for (const r of records) {
    const k = r.thread ?? "(none)";
    if (!byThread.has(k)) byThread.set(k, []);
    byThread.get(k).push(r);
  }
  for (const [k, rs] of byThread) show(`thread ${k.slice(0, 8)}`, rs);
}
