import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const dir = await mkdtemp(join(tmpdir(), "cmr-config-"));
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(text: string): Promise<string> {
  const path = join(dir, `config-${Math.random().toString(36).slice(2)}.toml`);
  await writeFile(path, text, "utf8");
  return path;
}

describe("loadConfig policy parsing", () => {
  it("parses subagent_router", async () => {
    const path = await write(`
      [policy]
      subagent_router = "jev"
    `);
    const config = loadConfig({ configPath: path });
    expect(config.policy.subagentRouter).toBe("jev");
    expect(config.policy.router).toBe("none");
  });

  it("rejects an unknown subagent_router value", async () => {
    const path = await write(`
      [policy]
      subagent_router = "gpt"
    `);
    expect(() => loadConfig({ configPath: path })).toThrow(/subagent_router/);
  });

  it("rejects an unknown policy key", async () => {
    const path = await write(`
      [policy]
      subagent_router = "none"
      subagent_router_typo = "none"
    `);
    expect(() => loadConfig({ configPath: path })).toThrow(/unknown \[policy\] keys/);
  });

  it("keeps the static-tier default when subagent_router is absent", async () => {
    const path = await write(`
      [policy]
      enabled = false
    `);
    const config = loadConfig({ configPath: path });
    expect(config.policy.subagentRouter).toBe("none");
    expect(config.policy.subagentTier).toBe("cheap");
  });
});
