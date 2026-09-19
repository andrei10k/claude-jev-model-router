import { describe, expect, it } from "vitest";

import {
  buildDownstreamHeaders,
  buildUpstreamHeaders,
  SseUsageScanner,
} from "../src/relay.js";

describe("buildUpstreamHeaders", () => {
  it("forwards credentials and the anthropic headers verbatim", () => {
    const headers = buildUpstreamHeaders({
      authorization: "Bearer oauth-token",
      "anthropic-beta": "oauth-2025-04-20,context-management-2025-06-27",
      "anthropic-version": "2023-06-01",
      "x-claude-code-session-id": "session-abc",
      "x-claude-code-agent-id": "agent-xyz",
      "content-type": "application/json",
    });

    expect(headers["authorization"]).toBe("Bearer oauth-token");
    // Must not be allowlisted or reformatted: new releases add beta values.
    expect(headers["anthropic-beta"]).toBe(
      "oauth-2025-04-20,context-management-2025-06-27",
    );
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["x-claude-code-session-id"]).toBe("session-abc");
    expect(headers["x-claude-code-agent-id"]).toBe("agent-xyz");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("drops hop-by-hop and recomputed headers", () => {
    const headers = buildUpstreamHeaders({
      host: "127.0.0.1:8787",
      "content-length": "1234",
      connection: "keep-alive",
      "transfer-encoding": "chunked",
      "proxy-authorization": "secret",
    });

    expect(headers["host"]).toBeUndefined();
    expect(headers["content-length"]).toBeUndefined();
    expect(headers["connection"]).toBeUndefined();
    expect(headers["transfer-encoding"]).toBeUndefined();
    expect(headers["proxy-authorization"]).toBeUndefined();
  });

  it("requests identity encoding so relayed bytes are the upstream's bytes", () => {
    const headers = buildUpstreamHeaders({ "accept-encoding": "gzip, br" });
    expect(headers["accept-encoding"]).toBe("identity");
  });
});

describe("buildDownstreamHeaders", () => {
  it("keeps content-length and content-type, drops transfer-encoding", () => {
    const headers = buildDownstreamHeaders({
      "content-type": "text/event-stream",
      "content-length": "42",
      "transfer-encoding": "chunked",
      connection: "keep-alive",
      "x-request-id": "req-1",
    } as never);

    expect(headers["content-type"]).toBe("text/event-stream");
    expect(headers["content-length"]).toBe("42");
    expect(headers["x-request-id"]).toBe("req-1");
    expect(headers["transfer-encoding"]).toBeUndefined();
    expect(headers["connection"]).toBeUndefined();
  });
});

const SSE = [
  "event: message_start",
  'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-5","usage":{"input_tokens":123,"cache_read_input_tokens":45}}}',
  "",
  "event: content_block_delta",
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"café"}}',
  "",
  "event: message_delta",
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":67}}',
  "",
  "event: message_stop",
  'data: {"type":"message_stop"}',
  "",
].join("\n");

describe("SseUsageScanner", () => {
  it("extracts usage and the served model from a whole stream", () => {
    const scanner = new SseUsageScanner(true);
    scanner.push(Buffer.from(SSE, "utf8"));

    expect(scanner.model).toBe("claude-sonnet-5");
    expect(scanner.usage["input_tokens"]).toBe(123);
    expect(scanner.usage["cache_read_input_tokens"]).toBe(45);
    expect(scanner.usage["output_tokens"]).toBe(67);
  });

  it("survives a stream split at arbitrary byte offsets", () => {
    // Byte-at-a-time is the worst case: a multi-byte character gets split.
    const bytes = Buffer.from(SSE, "utf8");
    const scanner = new SseUsageScanner(true);
    for (let offset = 0; offset < bytes.length; offset += 1) {
      scanner.push(bytes.subarray(offset, offset + 1));
    }

    expect(scanner.model).toBe("claude-sonnet-5");
    expect(scanner.usage["input_tokens"]).toBe(123);
    expect(scanner.usage["output_tokens"]).toBe(67);
  });

  it("ignores malformed lines without throwing", () => {
    const scanner = new SseUsageScanner(true);
    expect(() => {
      scanner.push(Buffer.from("data: not json\n\n", "utf8"));
      scanner.push(Buffer.from(": keep-alive comment\n\n", "utf8"));
      scanner.push(Buffer.from("data: [DONE]\n\n", "utf8"));
    }).not.toThrow();
    expect(scanner.usage).toEqual({});
  });

  it("does no work when disabled", () => {
    const scanner = new SseUsageScanner(false);
    scanner.push(Buffer.from(SSE, "utf8"));
    expect(scanner.usage).toEqual({});
  });
});
