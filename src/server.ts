import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { TierRouter } from "./classify.js";
import { describeConfig, type Config } from "./config.js";
import { buildContext, isSubagent, parseJsonBody, serialiseBody } from "./context.js";
import type { DecisionLog } from "./decisions.js";
import { decisionLogFields, type Policy } from "./policy.js";
import { forward, UpstreamUnreachable } from "./relay.js";

/**
 * The HTTP surface Claude Code talks to: POST /v1/messages, an optional
 * /v1/messages/count_tokens, GET /v1/models, and the HEAD /api/hello
 * connection-warming probe.
 */

export interface ServerDeps {
  config: Config;
  policy: Policy;
  router: TierRouter;
  log: DecisionLog;
  quiet?: boolean;
}

export function createServer(deps: ServerDeps): Server {
  return createHttpServer((req, res) => {
    handle(req, res, deps).catch((error: unknown) => {
      sendError(res, 502, `proxy error: ${String(error)}`);
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = (req.method ?? "GET").toUpperCase();

  if (url.pathname === "/api/hello") {
    // Answered locally: it is only a connection-warming probe.
    res.writeHead(200);
    res.end();
    return;
  }

  if (url.pathname === "/healthz") {
    sendJson(res, 200, {
      ok: true,
      upstream: deps.config.upstream,
      routing_enabled: deps.config.policy.enabled,
      router: deps.router.name,
      config: describeConfig(deps.config),
    });
    return;
  }

  if (url.pathname === "/v1/models" && method === "GET") {
    sendJson(res, 200, { data: modelCatalogue(deps.config) });
    return;
  }

  if (url.pathname === "/v1/messages" && method === "POST") {
    await handleInference(req, res, deps, url.search, "messages");
    return;
  }

  if (url.pathname === "/v1/messages/count_tokens" && method === "POST") {
    await handleInference(req, res, deps, url.search, "count_tokens");
    return;
  }

  sendError(res, 404, `no route for ${method} ${url.pathname}`);
}

/** Shared path for both inference endpoints. A token-count call follows the session tier; it never creates a decision. */
async function handleInference(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  search: string,
  kind: "messages" | "count_tokens",
): Promise<void> {
  const started = performance.now();
  const raw = await readBody(req);
  const body = parseJsonBody(raw);
  const ctx = buildContext({ headers: req.headers, body, bodyBytes: raw.length });

  let modelOut = ctx.modelIn;
  let logFields: Record<string, unknown>;
  let payload = raw;

  if (kind === "count_tokens") {
    modelOut = deps.policy.modelForTokens(ctx);
    if (body !== null && modelOut !== ctx.modelIn && modelOut !== "") {
      body["model"] = modelOut;
      payload = serialiseBody(body);
    }
    logFields = { decision_source: "reuse", reason: "token count follows the session tier" };
  } else {
    const decision = await deps.policy.decide(ctx);
    modelOut = decision.modelOut;
    logFields = decisionLogFields(decision);
    if (decision.rewritten && body !== null) {
      body["model"] = decision.modelOut;
      payload = serialiseBody(body);
    }
  }

  const base = {
    kind,
    session_id: ctx.sessionId === "" ? null : ctx.sessionId,
    agent_id: ctx.agentId,
    parent_agent_id: ctx.parentAgentId,
    is_subagent: isSubagent(ctx),
    model_in: ctx.modelIn,
    model_out: modelOut,
    body_bytes: ctx.bodyBytes,
    tool_count: ctx.toolCount,
    turn_index: ctx.turnIndex,
    stream: ctx.stream,
    ...logFields,
  };

  try {
    const result = await forward({
      upstream: deps.config.upstream,
      path: `/v1/${kind === "messages" ? "messages" : "messages/count_tokens"}`,
      search,
      method: "POST",
      headers: req.headers,
      body: payload,
      res,
    });

    deps.log.write({
      ...base,
      status: result.status,
      model_confirmed: result.modelConfirmed,
      client_aborted: result.clientAborted,
      latency_ms: round(performance.now() - started),
      usage: result.usage,
    });
  } catch (error) {
    const message =
      error instanceof UpstreamUnreachable
        ? `proxy could not reach ${deps.config.upstream}: ${error.message}`
        : String(error);

    deps.log.write({
      ...base,
      status: 502,
      error: message,
      latency_ms: round(performance.now() - started),
    });

    sendError(res, 502, message);
  }
}

function modelCatalogue(config: Config): Array<Record<string, string>> {
  const seen = new Set<string>();
  const entries: Array<Record<string, string>> = [];
  for (const [tier, id] of Object.entries(config.tiers)) {
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({ id, display_name: `${id} (${tier})`, description: `Tier '${tier}'` });
  }
  return entries;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(body.length),
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    // Mid-stream: we can only stop, not replace the response.
    if (!res.writableEnded) res.end();
    return;
  }  sendJson(res, status, {
    type: "error",
    error: { type: "api_error", message },
  });
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
