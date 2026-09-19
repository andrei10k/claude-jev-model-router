import type { IncomingHttpHeaders } from "node:http";

/**
 * Extraction of the routing-relevant facts from a request.
 *
 * Everything here is read-only. A gateway that rewrites request content breaks
 * Claude Code — 400s from preserved thinking, silently uncached prompt
 * prefixes. The only field the proxy is ever allowed to change is `model`.
 */

/** Headers Claude Code sets that carry routing-relevant identity. */
export const SESSION_HEADER = "x-claude-code-session-id";
export const AGENT_HEADER = "x-claude-code-agent-id";
export const PARENT_AGENT_HEADER = "x-claude-code-parent-agent-id";

/** Cap on the turn text handed to a classifier. */
export const MAX_TURN_CHARS = 4000;

export interface RequestContext {
  sessionId: string;
  agentId: string | null;
  parentAgentId: string | null;
  modelIn: string;
  latestUserText: string;
  turnIndex: number;
  bodyBytes: number;
  toolCount: number;
  stream: boolean;
}

/** True when Claude Code spawned this request from a subagent. */
export function isSubagent(ctx: RequestContext): boolean {
  return ctx.agentId !== null && ctx.agentId !== "";
}

// Subagents get their own key so a cheap delegated task cannot drag the main
// conversation down, and vice versa.
export function stickyKey(ctx: RequestContext): string {
  return ctx.agentId ?? (ctx.sessionId !== "" ? ctx.sessionId : "unknown");
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  if (typeof value === "string") return value === "" ? null : value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

/** Flatten a message's `content` into plain text. */
function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record["type"] !== "text") continue;
    const text = record["text"];
    if (typeof text === "string") parts.push(text);
  }
  return parts.join("\n");
}

/** Latest user turn's text and its index. Only this is ever sent to a classifier. */
export function latestUserText(messages: unknown): { text: string; index: number } {
  if (!Array.isArray(messages)) return { text: "", index: 0 };

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (typeof message !== "object" || message === null) continue;
    const record = message as Record<string, unknown>;
    if (record["role"] !== "user") continue;

    const text = textFromContent(record["content"]);
    if (text.trim() !== "") {
      return { text: text.slice(0, MAX_TURN_CHARS), index };
    }
  }
  return { text: "", index: 0 };
}

export interface BuildContextInput {
  headers: IncomingHttpHeaders;
  body: Record<string, unknown> | null;
  bodyBytes: number;
}

/** Build a RequestContext. Tolerates an unparseable body: routing degrades to passthrough. */
export function buildContext(input: BuildContextInput): RequestContext {
  const { headers, body, bodyBytes } = input;
  const safeBody = body ?? {};

  const { text, index } = latestUserText(safeBody["messages"]);
  const tools = safeBody["tools"];
  const model = safeBody["model"];

  return {
    sessionId: headerValue(headers, SESSION_HEADER) ?? "",
    agentId: headerValue(headers, AGENT_HEADER),
    parentAgentId: headerValue(headers, PARENT_AGENT_HEADER),
    modelIn: typeof model === "string" ? model : "",
    latestUserText: text,
    turnIndex: index,
    bodyBytes,
    toolCount: Array.isArray(tools) ? tools.length : 0,
    stream: safeBody["stream"] === true,
  };
}

/**
 * Parse a request body, returning null when it is not a JSON object.
 *
 * Deliberately permissive: `count_tokens` and other endpoints may send shapes
 * we do not care about, and a parse failure must not fail the request.
 */
export function parseJsonBody(raw: Buffer): Record<string, unknown> | null {
  if (raw.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Re-encode a request body.
 *
 * Byte-for-byte identity is not preserved, but no field is altered or dropped —
 * only `model` is expected to differ.
 */
export function serialiseBody(body: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(body), "utf8");
}
