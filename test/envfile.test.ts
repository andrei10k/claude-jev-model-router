import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { loadDotEnv } from "../src/envfile.js";

const dir = await mkdtemp(join(tmpdir(), "cmr-env-"));
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Run loadDotEnv against a file and restore the environment afterwards. */
async function withEnv(text: string, run: () => void): Promise<void> {
  const path = join(dir, `.env-${Math.random().toString(36).slice(2)}`);
  await writeFile(path, text, "utf8");
  const saved = { ...process.env };
  try {
    expect(loadDotEnv([path])).toBe(path);
    run();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
}

describe("loadDotEnv", () => {
  it("sets KEY=VALUE pairs and strips quotes", async () => {
    await withEnv('A=1\nB="two words"\nC=\'three\'\n', () => {
      expect(process.env["A"]).toBe("1");
      expect(process.env["B"]).toBe("two words");
      expect(process.env["C"]).toBe("three");
    });
  });

  it("ignores comments, blank lines and malformed lines", async () => {
    await withEnv("# comment\n\nno equals sign here\nD=4\n", () => {
      expect(process.env["D"]).toBe("4");
    });
  });

  it("never overrides a variable already in the environment", async () => {
    process.env["CMR_EXISTING"] = "from-env";
    try {
      await withEnv("CMR_EXISTING=from-file\n", () => {
        expect(process.env["CMR_EXISTING"]).toBe("from-env");
      });
    } finally {
      delete process.env["CMR_EXISTING"];
    }
  });

  it("returns null when no file exists", () => {
    expect(loadDotEnv([join(dir, "does-not-exist")])).toBeNull();
  });
});
