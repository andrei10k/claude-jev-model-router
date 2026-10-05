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

/** Tools that can modify the repository. Their presence raises the bar for downgrades. */
const MUTATION_TOOLS = new Set(["write", "edit", "notebookedit"]);

/** Tools that can execute commands. Their absence (with no mutation tools) marks read-only agents. */
const EXEC_TOOLS = new Set(["bash", "powershell"]);

/** How the request's tool list classifies: what this subagent can do to the repo. */
export type ToolSetClass = "readonly" | "mutating" | "exec" | "mixed" | "empty";

export function classifyTools(tools: unknown): { toolClass: ToolSetClass; toolCount: number } {
  if (!Array.isArray(tools) || tools.length === 0) return { toolClass: "empty", toolCount: 0 };

  let mutating = false;
  let exec = false;
  let other = false;
  let count = 0;
  for (const entry of tools) {
    count += 1;
    if (typeof entry !== "object" || entry === null) continue;
    const name = (entry as Record<string, unknown>)["name"];
    if (typeof name !== "string") continue;
    const lower = name.toLowerCase();
    if (MUTATION_TOOLS.has(lower)) mutating = true;
    else if (EXEC_TOOLS.has(lower)) exec = true;
    else other = true;
  }

  let toolClass: ToolSetClass;
  // "mixed" (mutation-capable) requires Write/Edit/NotebookEdit. Bash alone
  // does NOT qualify: read-only agents like Explore carry Bash for grep, and
  // treating them as mutation-capable would force them onto mid.
  if (mutating) toolClass = "mixed";
  else if (exec) toolClass = "exec";
  else toolClass = "readonly";

  return { toolClass, toolCount: count };
}

export interface RequestContext {
  sessionId: string;
  agentId: string | null;
  parentAgentId: string | null;
  modelIn: string;
  latestUserText: string;
  turnIndex: number;
  bodyBytes: number;
  toolCount: number;
  toolClass: ToolSetClass;
  maxTokens: number | null;
  /**
   * Positions of system-role messages in `messages`. The cheap model rejects
   * any of them; where they sit says whether the client is sending its agent
   * prompt (index 0) or steering a running conversation (mid-sequence).
   */
  systemRoleIndexes: number[];
  /** Content-free layout of `messages`: role and size per message. Diagnosis only. */
  messageShape: string;
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

export function headerValue(headers: IncomingHttpHeaders, name: string): string | null {
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

/** Positions of system-role messages in `messages`.
 *
 * Sonnet and Opus accept those; Haiku answers with 400 "role 'system' is not
 * supported on this model". Requests are written for the model the caller
 * asked for, so a downgrade has to know.
 */
export function systemRoleIndexes(messages: unknown): number[] {
  if (!Array.isArray(messages)) return [];
  const indexes: number[] = [];
  messages.forEach((message, index) => {
    if (typeof message !== "object" || message === null) return;
    if ((message as Record<string, unknown>)["role"] === "system") indexes.push(index);
  });
  return indexes;
}

/** Positions of the system-role messages that sit at the head of `messages`, or
 * null when one sits after the conversation has started.
 *
 * Clients have shipped both layouts: the prompt at messages[0], and a first user
 * turn followed by the prompt at messages[1]. Everything before the first
 * assistant message counts as the head. A system entry after that is
 * mid-conversation steering, which cannot be relocated without changing the
 * prefix the upstream already validated against its thinking signatures.
 */
function headSystemRoleIndexes(messages: unknown[]): number[] | null {
  const head: number[] = [];
  for (const [index, message] of messages.entries()) {
    if (typeof message !== "object" || message === null) continue;
    const role = (message as Record<string, unknown>)["role"];
    if (role === "assistant") break;
    if (role === "system") head.push(index);
  }
  return head.length === systemRoleIndexes(messages).length ? head : null;
}

/** A message's content as blocks, so it can move to the `system` array as-is. */function contentBlocks(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (content === undefined) return [];
  return [{ type: "text", text: String(content) }];
}

/** Move the client's system prompt into the top-level `system` field.
 *
 * Claude Code delivers the agent's system prompt as a `system` role entry inside
 * `messages` (beta mid-conversation-system) instead of the top-level `system`
 * field. Haiku rejects any system-role message, so without this every subagent
 * request has to stay on the caller's model.
 *
 * Every head entry moves, whatever their number, so both client layouts work.
 * The head is the only part that can move safely: the transform has to produce
 * the same prefix on every turn, or the upstream's preserved-thinking check sees
 * a different conversation. Anything the head rule does not cover returns null,
 * and the routing gate keeps the request on the caller's model.
 * The caller applies it to subagents only, and to every one of their requests
 * that matches rather than only the downgraded ones.
 */
export function hoistSystemMessage(body: Record<string, unknown>): Record<string, unknown> | null {
  const messages = body["messages"];
  if (!Array.isArray(messages) || messages.length === 0) return null;

  const head = headSystemRoleIndexes(messages);
  if (head === null || head.length === 0 || head.length === messages.length) return null;

  const hoisted = head.flatMap((index) =>
    contentBlocks((messages[index] as Record<string, unknown>)["content"]),
  );
  if (hoisted.length === 0) return null;

  const existing = body["system"];
  let base: unknown[] = [];
  if (Array.isArray(existing)) base = existing;
  else if (typeof existing === "string" && existing !== "") base = [{ type: "text", text: existing }];

  return {
    ...body,
    system: [...base, ...hoisted],
    messages: messages.filter((_, index) => !head.includes(index)),
  };
}

/** Remove fields the target model rejects, in place. Returns what it dropped.
 *
 * A downgraded request was written for a stronger model, so it can carry
 * capabilities the target does not have: Haiku answers adaptive thinking with
 * 400 "adaptive thinking is not supported on this model" and the effort
 * parameter with 400 "This model does not support the effort parameter".
 * Claude Code retries without them on its own, which costs a round trip per
 * capability per conversation. Only fields the API is known to reject are
 * removed, so nothing the target accepts ever disappears.
 */
export function stripUnsupported(
  body: Record<string, unknown>,
  family: string | null,
): string[] | null {
  if (family !== "haiku") return null;
  const removed: string[] = [];

  const thinking = body["thinking"];
  if (
    typeof thinking === "object" &&
    thinking !== null &&
    (thinking as Record<string, unknown>)["type"] === "adaptive"
  ) {
    delete body["thinking"];
    removed.push("thinking");
  }

  // Effort travels inside output_config with its own beta; remove the sub-field
  // the API named and leave the rest of the block alone.
  const outputConfig = body["output_config"];
  if (typeof outputConfig === "object" && outputConfig !== null) {
    const config = outputConfig as Record<string, unknown>;
    if (config["effort"] !== undefined) {
      delete config["effort"];
      removed.push("output_config.effort");
      if (Object.keys(config).length === 0) delete body["output_config"];
    }
  }

  // Context management pairs with thinking: a clear_thinking strategy is a 400
  // ("requires thinking to be enabled or adaptive") once the field is gone, so
  // removing one without the other trades one rejection for another. Only the
  // thinking-dependent edits are dropped; an unrecognised shape goes whole
  // rather than being guessed at.
  if (body["thinking"] === undefined) {
    const management = body["context_management"];
    const config =
      typeof management === "object" && management !== null
        ? (management as Record<string, unknown>)
        : null;
    if (config !== null) {
      const edits = config["edits"];
      if (Array.isArray(edits)) {
        const kept = edits.filter((edit) => !clearsThinking(edit));
        if (kept.length !== edits.length) {
          removed.push("context_management.edits[clear_thinking]");
          if (kept.length === 0) delete body["context_management"];
          else config["edits"] = kept;
        }
      } else if (JSON.stringify(config).includes("clear_thinking")) {
        delete body["context_management"];
        removed.push("context_management");
      }
    }
  }

  return removed.length > 0 ? removed : null;
}

/** True when a context-management edit clears thinking blocks. */
function clearsThinking(edit: unknown): boolean {
  if (typeof edit !== "object" || edit === null) return false;
  const type = (edit as Record<string, unknown>)["type"];
  return typeof type === "string" && type.startsWith("clear_thinking");
}

/** Content-free layout of `messages`: role and size per message, first eight only.
 *
 * Sizes and roles, never content. This is what tells a provider change to the
 * request shape apart from a routing bug.
 */
export function messageShape(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  const parts = messages.slice(0, 8).map((message) => {
    if (typeof message !== "object" || message === null) return "?";
    const record = message as Record<string, unknown>;
    const role = typeof record["role"] === "string" ? record["role"] : "?";
    return `${role}:${JSON.stringify(record["content"] ?? "").length}`;
  });
  const rest = messages.length - parts.length;
  return rest > 0 ? `${parts.join(",")},+${rest}` : parts.join(",");
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
  const { toolClass, toolCount } = classifyTools(safeBody["tools"]);
  const model = safeBody["model"];
  const maxTokensRaw = safeBody["max_tokens"];

  return {
    sessionId: headerValue(headers, SESSION_HEADER) ?? "",
    agentId: headerValue(headers, AGENT_HEADER),
    parentAgentId: headerValue(headers, PARENT_AGENT_HEADER),
    modelIn: typeof model === "string" ? model : "",
    latestUserText: text,
    turnIndex: index,
    bodyBytes,
    toolCount,
    toolClass,
    maxTokens: typeof maxTokensRaw === "number" && Number.isFinite(maxTokensRaw) ? maxTokensRaw : null,
    systemRoleIndexes: systemRoleIndexes(safeBody["messages"]),
    messageShape: messageShape(safeBody["messages"]),
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
