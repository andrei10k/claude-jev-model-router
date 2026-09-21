/**
 * Savings report from the decision log.
 *
 * For every request that was rewritten to a cheaper model, computes what the
 * same tokens would have cost at the originally-requested model's price, and
 * sums the difference. Rewrites to a MORE expensive model count as negative
 * savings. Prices are per-million-token USD and configurable via a JSON file;
 * defaults are Anthropic's published list.
 *
 * Cache-aware: cached input is billed at 10% of base input, cache writes at
 * 125%, exactly like the API.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

// family -> USD per million tokens [input, cached_input, cache_write, output]
const PRICING: Record<string, { input: number; cached: number; write: number; output: number }> = {
  "claude-opus-5": { input: 15, cached: 1.5, write: 18.75, output: 75 },
  "claude-sonnet-5": { input: 3, cached: 0.3, write: 3.75, output: 15 },
  "claude-haiku-4-5": { input: 0.8, cached: 0.08, write: 1, output: 4 },
};

function priceOf(model: string | null | undefined) {
  const lowered = (model ?? "").toLowerCase();
  for (const [family, p] of Object.entries(PRICING)) {
    const short = family.replace("claude-", "");
    if (lowered === family || lowered.includes(`claude-${short}`)) return p;
  }
  return null;
}

function costUSD(pricing: { input: number; cached: number; write: number; output: number }, usage: Record<string, unknown>): number {
  const m = 1e6;
  return (
    ((usage["input_tokens"] as number ?? 0) / m) * pricing.input +
    ((usage["cache_read_input_tokens"] as number ?? 0) / m) * pricing.cached +
    ((usage["cache_creation_input_tokens"] as number ?? 0) / m) * pricing.write +
    ((usage["output_tokens"] as number ?? 0) / m) * pricing.output
  );
}

interface LogRecord {
  ts?: string;
  kind?: string;
  model_in?: string;
  model_out?: string;
  rewritten?: boolean;
  usage?: Record<string, unknown>;
}

export function savingsReport(argv: readonly string[]): void {
  let logPath = `${homedir()}/.claude-model-router/decisions.jsonl`;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--log") logPath = argv[++i] ?? logPath;
    if (argv[i] === "--pricing") {
      const file = argv[++i];
      if (file) Object.assign(PRICING, JSON.parse(readFileSync(file, "utf8")));
    }
  }

  let raw: string;
  try {
    raw = readFileSync(logPath, "utf8");
  } catch {
    console.error(`cannot read log: ${logPath}`);
    process.exitCode = 1;
    return;
  }

  const records: LogRecord[] = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as LogRecord;
      } catch {
        return null;
      }
    })
    .filter((r): r is LogRecord => r !== null);

  const WINDOWS = [
    { label: "1 day", cutoff: Date.now() - 1 * 864e5 },
    { label: "7 days", cutoff: Date.now() - 7 * 864e5 },
    { label: "30 days", cutoff: Date.now() - 30 * 864e5 },
  ];

  const fmt = (n: number): string =>
    Math.abs(n) < 0.005 ? "$0.00" : `${n < 0 ? "-$" : "$"}${Math.abs(n).toFixed(2)}`;
  const fmtInt = (n: number): string =>
    n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n);
  const shortName = (m: string | undefined): string =>
    (m ?? "?").replace("claude-", "").replace(/-\d{8}$/, "");

  const unknownModels = new Set<string>();

  for (const w of WINDOWS) {
    let saved = 0;
    let rewrites = 0;
    let calls = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let unpriced = 0;
    const byRoute: Record<string, number> = {};

    for (const r of records) {
      if (r.kind !== "messages" || !r.usage) continue;
      const ts = Date.parse(r.ts ?? "");
      if (ts < w.cutoff) continue;
      calls += 1;
      if (!r.rewritten) continue;

      const from = priceOf(r.model_in);
      const to = priceOf(r.model_out);
      if (!from || !to) {
        unknownModels.add(r.model_in ?? "?");
        unpriced += 1;
        continue;
      }

      const actual = costUSD(to, r.usage);
      const counterfactual = costUSD(from, r.usage);
      const delta = counterfactual - actual;
      saved += delta;
      rewrites += 1;
      tokensIn +=
        ((r.usage["input_tokens"] as number) ?? 0) +
        ((r.usage["cache_read_input_tokens"] as number) ?? 0) +
        ((r.usage["cache_creation_input_tokens"] as number) ?? 0);
      tokensOut = (r.usage["output_tokens"] as number) ?? 0;

      const key = `${shortName(r.model_in)} -> ${shortName(r.model_out)}`;
      byRoute[key] = (byRoute[key] ?? 0) + delta;
    }

    console.log(`\n=== Last ${w.label} ===`);
    console.log(`  requests logged:   ${calls}`);
    console.log(
      `  rewrites priced:   ${rewrites}${unpriced ? ` (+${unpriced} with unknown pricing)` : ""}`,
    );
    if (rewrites === 0 && unpriced === 0) {
      console.log("  savings: $0.00 (no rewrites)");
      continue;
    }
    console.log(`  tokens rerouted:   ${fmtInt(tokensIn)} in / ${fmtInt(tokensOut)} out`);
    for (const [route, amount] of Object.entries(byRoute).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${route.padEnd(40)} ${amount >= 0 ? "" : "-"}${fmt(Math.abs(amount)).trim()}`);
    }
    console.log("  ---------------------------");
    console.log(`  ${saved >= 0 ? "SAVED" : "LOST"}: ${fmt(Math.abs(saved))}`);
  }

  if (unknownModels.size > 0) {
    console.log(`\nNOTE: no prices for: ${[...unknownModels].join(", ")}. Add them with --pricing.`);
  }
}
