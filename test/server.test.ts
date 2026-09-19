import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { request } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { NullRouter } from "../src/classify.js";
import { defaultConfig, type Config } from "../src/config.js";
import { DecisionLog } from "../src/decisions.js";
import { Policy } from "../src/policy.js";
import { createServer } from "../src/server.js";

/**
 * End-to-end test of the relay: a stand-in upstream records exactly what
 * reached it, the real proxy sits in front of it.
 */

interface Received {
  model: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const SSE_CHUNKS = [
  "event: message_start\n",
  `data: ${JSON.stringify({
    type: "message_start",
    message: { id: "msg_1", model: "claude-haiku-4-5", usage: { input_tokens: 42 } },
  })}\n\n`,
  "event: content_block_delta\n",
  `data: ${JSON.stringify({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "hello" },
  })}\n\n`,
  "event: message_delta\n",
  `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 7 } })}\n\n`,
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function readLog(path: string, minLines = 1): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
      if (lines.length >= minLines) {
        return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      }
    } catch {
      // File may not exist yet.
    }
    if (Date.now() > deadline) throw new Error(`log never reached ${minLines} line(s)`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

let workDir: string;
let logPath: string;
let upstream: Server;
let upstreamPort: number;
let proxy: Server;
let proxyPort: number;
let received: Received[] = [];

function buildConfig(overrides: Partial<Config["policy"]> = {}): Config {
  const config = defaultConfig();
  config.upstream = `http://127.0.0.1:${upstreamPort}`;
  config.log = logPath;
  config.policy = {
    ...config.policy,
    enabled: true,
    subagentTier: "cheap",
    mainTier: "mid",
    ...overrides,
  };
  return config;
}

async function startProxy(config: Config): Promise<number> {
  const server = createServer({
    config,
    policy: new Policy(config, new NullRouter()),
    router: new NullRouter(),
    log: new DecisionLog(config.log),
  });
  return listen(server);
}

async function post(
  port: number,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const response = await request(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20,context-management-2025-06-27",
      authorization: "Bearer test-token",
      "x-claude-code-session-id": "session-1",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { status: response.statusCode, text: await response.body.text() };
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "cmr-"));
  logPath = join(workDir, "decisions.jsonl");

  upstream = createHttpServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // Leave it empty; the assertion will report the mismatch.
      }
      received.push({
        model: typeof parsed["model"] === "string" ? parsed["model"] : "",
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v)]),
        ),
        body: parsed,
      });

      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of SSE_CHUNKS) res.write(chunk);
      res.end();
    });
  });
  upstreamPort = await listen(upstream);

  proxy = createServer({
    config: buildConfig(),
    policy: new Policy(buildConfig(), new NullRouter()),
    router: new NullRouter(),
    log: new DecisionLog(logPath),
  });
  proxyPort = await listen(proxy);
});

afterAll(async () => {
  await close(upstream);
  await close(proxy);
  rmSync(workDir, { recursive: true, force: true });
});

describe("relay end to end", () => {
  it("rewrites a subagent request to the cheap tier and streams the reply back", async () => {
    received = [];
    const result = await post(
      proxyPort,
      "/v1/messages",
      {
        model: "claude-opus-5",
        stream: true,
        system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: "list the files" }],
      },
      { "x-claude-code-agent-id": "agent-1" },
    );

    expect(result.status).toBe(200);
    // Byte-for-byte: no buffering, no re-encoding of the event stream.
    expect(result.text).toBe(SSE_CHUNKS.join(""));

    const seen = received[0];
    expect(seen?.model).toBe("claude-haiku-4-5");

    // Everything except `model` must survive untouched. Mangled cache_control
    // bills the whole conversation uncached, with no error.
    expect(seen?.body["system"]).toEqual([
      { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
    ]);
    expect(seen?.body["stream"]).toBe(true);
  });

  it("forwards credentials and anthropic headers verbatim", async () => {
    received = [];
    await post(
      proxyPort,
      "/v1/messages",
      { model: "claude-opus-5", messages: [] },
      {
        "x-claude-code-agent-id": "agent-2",
        // Hop-by-hop on the client side; must not survive the crossing.
        connection: "close",
      },
    );

    const headers = received[0]?.headers ?? {};
    expect(headers["authorization"]).toBe("Bearer test-token");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    // Must not be allowlisted or split: new releases add beta values.
    expect(headers["anthropic-beta"]).toBe(
      "oauth-2025-04-20,context-management-2025-06-27",
    );

    // host is stripped and recomputed — the proof that the header set is rebuilt.
    expect(headers["host"]).toBe(`127.0.0.1:${upstreamPort}`);

    expect(headers["connection"]).not.toBe("close");
  });

  it("logs the decision with the model the upstream actually served", async () => {
    const lines = await readLog(logPath, 1);
    const entry = lines.find((line) => line["agent_id"] === "agent-2");

    expect(entry).toBeDefined();
    expect(entry?.["kind"]).toBe("messages");
    expect(entry?.["model_in"]).toBe("claude-opus-5");
    expect(entry?.["model_out"]).toBe("claude-haiku-4-5");
    expect(entry?.["rewritten"]).toBe(true);
    expect(entry?.["tier"]).toBe("cheap");
    expect(entry?.["decision_source"]).toBe("rule");
    expect(entry?.["is_subagent"]).toBe(true);
    expect(entry?.["status"]).toBe(200);
    // Parsed out of the relayed stream, not of anything we sent.
    expect(entry?.["model_confirmed"]).toBe("claude-haiku-4-5");
    expect(entry?.["usage"]).toMatchObject({ input_tokens: 42, output_tokens: 7 });
  });

  it("holds the subagent decision across turns", async () => {
    received = [];
    await post(
      proxyPort,
      "/v1/messages",
      { model: "claude-sonnet-5", messages: [] },
      { "x-claude-code-agent-id": "agent-1" },
    );

    // The session was already put on the cheap tier, so a mid-tier incoming
    // model is pulled to cheap rather than honoured.
    expect(received[0]?.model).toBe("claude-haiku-4-5");
  });

  it("serves the connection-warming probe without touching upstream", async () => {
    received = [];
    const response = await request(`http://127.0.0.1:${proxyPort}/api/hello`, {
      method: "HEAD",
    });

    expect(response.statusCode).toBe(200);
    await response.body.dump();
    expect(received).toHaveLength(0);
  });

  it("reports unknown paths clearly", async () => {
    const response = await request(`http://127.0.0.1:${proxyPort}/v1/nope`, {
      method: "GET",
    });
    expect(response.statusCode).toBe(404);
    await response.body.dump();
  });
});

describe("observe-only mode", () => {
  it("forwards the original model and still logs the decision it would have made", async () => {
    const observeDir = mkdtempSync(join(tmpdir(), "cmr-observe-"));
    const observeLog = join(observeDir, "decisions.jsonl");
    const config = buildConfig({ enabled: false });
    config.log = observeLog;

    const port = await startProxy(config);
    received = [];

    await post(
      port,
      "/v1/messages",
      { model: "claude-opus-5", messages: [] },
      { "x-claude-code-agent-id": "agent-observe" },
    );

    expect(received[0]?.model).toBe("claude-opus-5");

    const lines = await readLog(observeLog, 1);
    expect(lines[0]?.["rewritten"]).toBe(false);
    // Observe mode runs the full policy and flags what it would have done.
    expect(lines[0]?.["reason"]).toContain("observe: would rewrite");
    expect(lines[0]?.["observe"]).toBe(true);
    expect(lines[0]?.["tier"]).toBe("cheap");

    rmSync(observeDir, { recursive: true, force: true });
  });
});
