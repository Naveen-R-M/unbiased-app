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
const perRun = args.includes("--per-run");
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
  // Prefer the engine's own turn boundaries. The record span is only a
  // fallback for logs written before those existed, and it stretches whenever
  // the thread is touched again later — so it is labelled as approximate
  // rather than printed as though it were measured.
  const span = rs.length > 1 ? new Date(rs.at(-1).at).getTime() - new Date(rs[0].at).getTime() : 0;
  const measured = r.wall !== null && r.wall.runs > 0;
  const wallMs = measured ? r.wall.ms : span;
  const model = Math.max(0, wallMs - r.toolMs.total);
  console.log(`\n${label}  [${r.shape}]`);
  const retried = r.retries > 0 ? `   retries ${r.retries}` : "";
  console.log(`  turns ${r.turns}   tool calls ${r.toolCalls}   driver calls ${r.driverCalls}${retried}`);
  console.log(
    `  tokens billed ${r.tokens.billed.total.toLocaleString()} ` +
      `(in ${r.tokens.billed.input.toLocaleString()}, cached ${r.tokens.billed.cached.toLocaleString()}, out ${r.tokens.billed.output.toLocaleString()})` +
      `   context ended at ${r.tokens.context.toLocaleString()}`,
  );
  if (wallMs > 0) {
    const how = measured
      ? `wall ${ms(wallMs)} over ${r.wall.runs} run${r.wall.runs === 1 ? "" : "s"}`
      : `span ${ms(wallMs)} (approximate: no turn boundaries in these records)`;
    console.log(`  ${how}   in tools ${ms(r.toolMs.total)} (${pct(r.toolMs.total, wallMs)})   model+idle ${ms(model)} (${pct(model, wallMs)})`);
    if (measured && r.wall.unfinished > 0) console.log(`  ${r.wall.unfinished} run(s) started and never finished — interrupted, or the app restarted mid-turn`);
  }
  console.log(`  tool ms  p50 ${r.toolMs.p50}  p95 ${r.toolMs.p95}  max ${r.toolMs.max}`);
  console.log(`  driver ms p50 ${r.driverMs.p50}  p95 ${r.driverMs.p95}  max ${r.driverMs.max}`);
  const big = Object.entries(r.largest).map(([u, n]) => `${n} ${u}`).join(", ");
  if (big) console.log(`  largest payload  ${big}`);
  const f = (m) => Object.entries(m).map(([k, n]) => `${k} ${n}`).join(", ") || "none";
  console.log(`  failures  tool: ${f(r.failures.tool)}   driver: ${f(r.failures.driver)}`);
  const routes = Object.entries(r.pointerRoutes ?? {});
  if (routes.length) {
    const took = routes.filter(([k]) => k.startsWith("cursor")).reduce((n, [, v]) => n + v, 0);
    const raised = routes.filter(([k]) => k.endsWith("+raised")).reduce((n, [, v]) => n + v, 0);
    const notes = [];
    if (took) notes.push(`${took} took the user's pointer`);
    if (raised) notes.push(`${raised} brought the app forward`);
    console.log(`  pointer routes  ${routes.map(([k, v]) => `${k}:${v}`).join("  ")}` +
      (notes.length ? `   <- ${notes.join(", ")}` : "   (nothing touched the user's pointer or Space)"));
  }
  console.log(`  accepted but nothing changed: ${r.noChange}`);
  if (r.silentWrites > 0) {
    const by = Object.entries(r.silentByRole).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(", ");
    const stale = r.v < 2 ? "  [v1 — counted a half-signal; not comparable with later runs]" : "";
    console.log(`  writes accepted that did nothing observable: ${r.silentWrites}  (${by})${stale}`);
  }
}

console.log(`${records.length} records from ${file}${skipped ? ` (${skipped} unreadable)` : ""}`);
show("ALL RUNS", records);

// A thread can hold several runs — a failure and the retry that finished the
// work land on the same thread, and averaging them describes neither. Runs are
// the unit anyone actually asks about.
if (perRun) {
  const byThread = new Map();
  for (const r of records) {
    const k = r.thread ?? "(none)";
    if (!byThread.has(k)) byThread.set(k, []);
    byThread.get(k).push(r);
  }
  let n = 0;
  for (const [k, rs] of byThread) {
    const at = (r) => new Date(r.at).getTime();
    let open = null;
    for (const b of rs.filter((r) => r.kind === "run")) {
      if (b.phase === "started") open = b;
      else if (open) {
        const seg = rs.filter((r) => at(r) >= at(open) && at(r) <= at(b));
        show(`run ${++n} — thread ${k.slice(0, 8)} [${b.status ?? "?"}]`, seg);
        open = null;
      }
    }
  }
  if (n === 0) console.log("\nNo run boundaries in these records — they predate boundary logging.");
}

if (perThread) {
  const byThread = new Map();
  for (const r of records) {
    const k = r.thread ?? "(none)";
    if (!byThread.has(k)) byThread.set(k, []);
    byThread.get(k).push(r);
  }
  for (const [k, rs] of byThread) show(`thread ${k.slice(0, 8)}`, rs);
}
