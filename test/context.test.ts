import type { IncomingHttpHeaders } from "node:http";

import { describe, expect, it } from "vitest";

import {
  MAX_TURN_CHARS,
  buildContext,
  isSubagent,
  latestUserText,
  parseJsonBody,
  serialiseBody,
  stickyKey,
} from "../src/context.js";

describe("latestUserText", () => {
  it("reads string content", () => {
    const result = latestUserText([
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ]);

    expect(result.text).toBe("second");
    expect(result.index).toBe(2);
  });

  it("reads text blocks and ignores tool results", () => {
    const result = latestUserText([
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "tool_result", tool_use_id: "t1", content: "huge output" },
        ],
      },
    ]);

    expect(result.text).toBe("look at this");
  });

  it("skips a user turn that carries no text", () => {
    const result = latestUserText([
      { role: "user", content: "the real question" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] },
    ]);

    expect(result.text).toBe("the real question");
    expect(result.index).toBe(0);
  });

  it("returns empty for anything that is not a message list", () => {
    expect(latestUserText(undefined).text).toBe("");
    expect(latestUserText("nope").text).toBe("");
    expect(latestUserText([]).text).toBe("");
  });

  it("truncates an enormous turn", () => {
    const result = latestUserText([{ role: "user", content: "x".repeat(50_000) }]);
    expect(result.text.length).toBe(MAX_TURN_CHARS);
  });
});

describe("buildContext", () => {
  const headers: IncomingHttpHeaders = {
    "x-claude-code-session-id": "session-abc",
    "x-claude-code-agent-id": "agent-xyz",
    "x-claude-code-parent-agent-id": "agent-root",
    "content-type": "application/json",
  };

  it("pulls identity out of the Claude Code headers", () => {
    const ctx = buildContext({ headers, body: { model: "claude-opus-5" }, bodyBytes: 10 });

    expect(ctx.sessionId).toBe("session-abc");
    expect(ctx.agentId).toBe("agent-xyz");
    expect(ctx.parentAgentId).toBe("agent-root");
    expect(ctx.modelIn).toBe("claude-opus-5");
    expect(isSubagent(ctx)).toBe(true);
    expect(stickyKey(ctx)).toBe("agent-xyz");
  });

  it("treats an absent agent header as the main conversation", () => {
    const ctx = buildContext({
      headers: { "x-claude-code-session-id": "s" },
      body: { model: "claude-opus-5" },
      bodyBytes: 0,
    });

    expect(ctx.agentId).toBeNull();
    expect(isSubagent(ctx)).toBe(false);
    expect(stickyKey(ctx)).toBe("s");
  });

  it("tolerates a body that failed to parse", () => {
    const ctx = buildContext({ headers, body: null, bodyBytes: 0 });

    expect(ctx.modelIn).toBe("");
    expect(ctx.toolCount).toBe(0);
    expect(ctx.latestUserText).toBe("");
  });

  it("counts tools and reads the stream flag", () => {
    const ctx = buildContext({
      headers,
      body: { model: "m", tools: [{}, {}], stream: true },
      bodyBytes: 0,
    });

    expect(ctx.toolCount).toBe(2);
    expect(ctx.stream).toBe(true);
  });

  it("falls back to a stable key when there is no identity at all", () => {
    const ctx = buildContext({ headers: {}, body: null, bodyBytes: 0 });
    expect(stickyKey(ctx)).toBe("unknown");
  });
});

describe("parseJsonBody", () => {
  it("parses an object", () => {
    expect(parseJsonBody(Buffer.from('{"a":1}'))).toEqual({ a: 1 });
  });

  it("returns null for shapes it cannot route on", () => {
    expect(parseJsonBody(Buffer.from("[1,2]"))).toBeNull();
    expect(parseJsonBody(Buffer.from('"a string"'))).toBeNull();
    expect(parseJsonBody(Buffer.from("not json"))).toBeNull();
    expect(parseJsonBody(Buffer.alloc(0))).toBeNull();
  });
});

describe("serialiseBody", () => {
  it("round-trips without dropping fields", () => {
    const original = {
      model: "claude-opus-5",
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "Read" }],
      metadata: { user_id: "u1" },
    };

    const parsed = parseJsonBody(serialiseBody(original));
    expect(parsed).toEqual(original);
  });
});
