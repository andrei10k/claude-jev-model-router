import type { IncomingHttpHeaders } from "node:http";

import { describe, expect, it } from "vitest";

import {
  MAX_TURN_CHARS,
  buildContext,
  hoistSystemMessage,
  isSubagent,
  latestUserText,
  parseJsonBody,
  serialiseBody,
  stickyKey,
  stripUnsupported,
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
    const ctx = buildContext({ headers, body: { model: "claude-opus-5-5" }, bodyBytes: 10 });

    expect(ctx.sessionId).toBe("session-abc");
    expect(ctx.agentId).toBe("agent-xyz");
    expect(ctx.parentAgentId).toBe("agent-root");
    expect(ctx.modelIn).toBe("claude-opus-5-5");
    expect(isSubagent(ctx)).toBe(true);
    expect(stickyKey(ctx)).toBe("agent-xyz");
  });

  it("treats an absent agent header as the main conversation", () => {
    const ctx = buildContext({
      headers: { "x-claude-code-session-id": "s" },
      body: { model: "claude-opus-5-5" },
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

  it("flags a system-role message the cheap model would reject", () => {
    const ctx = buildContext({
      headers,
      body: { model: "claude-sonnet-5-5", messages: [{ role: "system", content: "be terse" }] },
      bodyBytes: 10,
    });

    expect(ctx.systemRoleIndexes).toEqual([0]);
  });

  it("leaves an ordinary turn unflagged", () => {
    const ctx = buildContext({
      headers,
      body: {
        model: "claude-sonnet-5-5",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
      },
      bodyBytes: 10,
    });

    expect(ctx.systemRoleIndexes).toEqual([]);
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

describe("hoistSystemMessage", () => {
  const subagent = () => ({
    model: "claude-sonnet-5-5",
    messages: [
      { role: "user", content: "investigate the currency switcher" },
      { role: "system", content: [{ type: "text", text: "you are Explore" }] },
    ],
  });

  it("moves a lone system prompt into the system field", () => {
    const hoisted = hoistSystemMessage(subagent());

    expect(hoisted?.["system"]).toEqual([{ type: "text", text: "you are Explore" }]);
    expect(hoisted?.["messages"]).toEqual([
      { role: "user", content: "investigate the currency switcher" },
    ]);
  });

  it("keeps existing system content ahead of the hoisted prompt", () => {
    const hoisted = hoistSystemMessage({
      ...subagent(),
      system: [{ type: "text", text: "standing instructions" }],
    });

    expect(hoisted?.["system"]).toEqual([
      { type: "text", text: "standing instructions" },
      { type: "text", text: "you are Explore" },
    ]);
  });

  it("handles the layout with the prompt first", () => {
    const hoisted = hoistSystemMessage({
      messages: [
        { role: "system", content: "you are Explore" },
        { role: "user", content: "investigate" },
      ],
    });

    expect(hoisted?.["system"]).toEqual([{ type: "text", text: "you are Explore" }]);
    expect(hoisted?.["messages"]).toEqual([{ role: "user", content: "investigate" }]);
  });

  it("keeps hoisting when a later turn appends a steering message", () => {
    const hoisted = hoistSystemMessage({
      messages: [
        { role: "user", content: "investigate" },
        { role: "system", content: [{ type: "text", text: "you are Explore" }] },
        { role: "assistant", content: "working" },
        { role: "user", content: "go on" },
      ],
    });

    // The head transforms the same way on every turn, which is what keeps the
    // upstream's preserved-thinking check happy.
    expect(hoisted?.["system"]).toEqual([{ type: "text", text: "you are Explore" }]);
    expect(hoisted?.["messages"]).toEqual([
      { role: "user", content: "investigate" },
      { role: "assistant", content: "working" },
      { role: "user", content: "go on" },
    ]);
  });

  it("refuses to touch steering that arrived mid-conversation", () => {
    // Relocating this would change the prefix the upstream already validated.
    expect(
      hoistSystemMessage({
        messages: [
          { role: "user", content: "investigate" },
          { role: "system", content: "you are Explore" },
          { role: "assistant", content: "working" },
          { role: "system", content: "stay in scope" },
        ],
      }),
    ).toBeNull();
  });

  it("leaves every other shape alone", () => {
    expect(hoistSystemMessage({ messages: [{ role: "user", content: "a" }] })).toBeNull();
    expect(
      hoistSystemMessage({
        messages: [
          { role: "user", content: "a" },
          { role: "user", content: "b" },
        ],
      }),
    ).toBeNull();
  });
});

describe("stripUnsupported", () => {
  it("drops the capabilities Haiku rejects", () => {
    const body: Record<string, unknown> = {
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
    };

    expect(stripUnsupported(body, "haiku")).toEqual(["thinking", "output_config.effort"]);
    expect(body["thinking"]).toBeUndefined();
    // The rest of the block stays: only the named sub-field is rejected.
    expect(body["output_config"]).toBeUndefined();
  });

  it("keeps sub-fields the model does accept", () => {
    const body: Record<string, unknown> = { output_config: { effort: "high", format: { type: "json" } } };

    expect(stripUnsupported(body, "haiku")).toEqual(["output_config.effort"]);
    expect(body["output_config"]).toEqual({ format: { type: "json" } });
  });

  it("keeps budgeted thinking, which Haiku does support", () => {
    const body: Record<string, unknown> = { thinking: { type: "enabled", budget_tokens: 2048 } };

    expect(stripUnsupported(body, "haiku")).toBeNull();
    expect(body["thinking"]).toEqual({ type: "enabled", budget_tokens: 2048 });
  });

  it("drops the clear_thinking edits that depend on the field it removed", () => {
    const body: Record<string, unknown> = {
      thinking: { type: "adaptive" },
      context_management: {
        edits: [
          { type: "clear_thinking_20251015", keep: 1 },
          { type: "clear_tool_uses_20250919" },
        ],
      },
    };

    expect(stripUnsupported(body, "haiku")).toEqual([
      "thinking",
      "context_management.edits[clear_thinking]",
    ]);
    expect(body["context_management"]).toEqual({
      edits: [{ type: "clear_tool_uses_20250919" }],
    });
  });

  it("drops the whole context-management block when nothing else is in it", () => {
    const body: Record<string, unknown> = {
      thinking: { type: "adaptive" },
      context_management: { edits: [{ type: "clear_thinking_20251015" }] },
    };

    stripUnsupported(body, "haiku");
    expect(body["context_management"]).toBeUndefined();
  });

  it("leaves context management alone while thinking is still on", () => {
    const body: Record<string, unknown> = {
      thinking: { type: "enabled", budget_tokens: 2048 },
      context_management: { edits: [{ type: "clear_thinking_20251015" }] },
    };

    expect(stripUnsupported(body, "haiku")).toBeNull();
    expect(body["context_management"]).toEqual({ edits: [{ type: "clear_thinking_20251015" }] });
  });

  it("leaves stronger models untouched", () => {
    const body: Record<string, unknown> = {
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
    };

    expect(stripUnsupported(body, "sonnet")).toBeNull();
    expect(body["thinking"]).toEqual({ type: "adaptive" });
    expect(body["output_config"]).toEqual({ effort: "high" });
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
      model: "claude-opus-5-5",
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "Read" }],
      metadata: { user_id: "u1" },
    };

    const parsed = parseJsonBody(serialiseBody(original));
    expect(parsed).toEqual(original);
  });
});
