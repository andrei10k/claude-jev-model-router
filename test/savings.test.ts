import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { savingsReport } from "../src/savings.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Run the report against a synthetic log and return everything it printed. */
function report(records: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "cmr-savings-"));
  dirs.push(dir);
  const path = join(dir, "decisions.jsonl");
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n"));

  const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    savingsReport(["--log", path]);
    return spy.mock.calls.map((call) => call.join(" ")).join("\n");
  } finally {
    spy.mockRestore();
  }
}

const NOW = new Date().toISOString();

describe("savingsReport", () => {
  it("prices a rewrite against the model the caller asked for", () => {
    const out = report([
      {
        ts: NOW,
        kind: "messages",
        model_in: "claude-sonnet-5-5",
        model_out: "claude-haiku-4-5",
        rewritten: true,
        usage: { input_tokens: 1_000_000 },
      },
    ]);

    // 1M input tokens: $3.00 on Sonnet, $0.80 on Haiku.
    expect(out).toContain("SAVED: $2.20");
    expect(out).toContain("sonnet-5-5 -> haiku-4-5");
  });

  it("does not price a rewrite the upstream rejected", () => {
    const out = report([
      {
        ts: NOW,
        kind: "messages",
        model_in: "claude-sonnet-5-5",
        model_out: "claude-haiku-4-5",
        rewritten: true,
        usage: {},
      },
    ]);

    // An empty usage object used to be counted as a $0.00 rewrite, which is
    // how a dead route reads as "no savings yet".
    expect(out).toContain("rewrites unpriced: 1");
    expect(out).toContain("no priced rewrites");
    expect(out).not.toContain("SAVED: $");
  });

  it("counts a refused rewrite separately from savings", () => {
    const out = report([
      {
        ts: NOW,
        kind: "messages",
        model_in: "claude-sonnet-5-5",
        model_out: "claude-sonnet-5-5",
        rewritten: false,
        blocked: "claude-haiku-4-5 rejects a system-role message",
        usage: { input_tokens: 500_000 },
      },
    ]);

    expect(out).toContain("rewrites refused:  1");
    expect(out).toContain("no priced rewrites");
  });
});
