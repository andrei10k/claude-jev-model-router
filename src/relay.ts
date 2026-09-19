import { once } from "node:events";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { StringDecoder } from "node:string_decoder";

import { request, type Dispatcher } from "undici";

/**
 * Forwarding to the upstream. The parts of the gateway contract that have to
 * be exactly right:
 *
 * - Change nothing but `model`. Mangled `cache_control` makes the whole
 *   conversation bill uncached, with no error to tell you.
 * - Forward `anthropic-*` headers unchanged, as an open list. Allowlisting
 *   the beta values you observe today breaks the next release.
 * - Stream without buffering, propagate backpressure, forward error bodies
 *   unmodified (retry logic matches on the wording).
 * - `undici.request`, not `fetch`: request hands back raw undecompressed
 *   bytes, fetch decompresses while leaving `content-encoding` in place.
 */

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
]);

// host and content-length are recomputed downstream; accept-encoding is forced
// to identity below. undici sets its own connection header on the upstream hop,
// which is why the tests assert on host instead.
const DROP_REQUEST = new Set(["host", "content-length", "accept-encoding"]);

export class UpstreamUnreachable extends Error {
  override name = "UpstreamUnreachable";
}

export function buildUpstreamHeaders(incoming: IncomingHttpHeaders): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase();
    if (DROP_REQUEST.has(lower) || HOP_BY_HOP.has(lower) || lower === "proxy-authorization") {
      continue;
    }
    if (value === undefined) continue;
    headers[lower] = Array.isArray(value) ? value.join(", ") : value;
  }

  // Identity encoding plus undici not decompressing: the bytes we relay are
  // the bytes the upstream produced.
  headers["accept-encoding"] = "identity";
  return headers;
}

export function buildDownstreamHeaders(
  upstream: Dispatcher.ResponseData["headers"],
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(upstream)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (value === undefined) continue;
    headers[lower] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return headers;
}

/**
 * Reads an SSE stream without altering it, extracting token usage and the
 * model the upstream actually served. StringDecoder handles a multi-byte
 * character split across chunks. Failures are swallowed: this is
 * observability, not control flow.
 */
export class SseUsageScanner {
  usage: Record<string, number> = {};
  model: string | null = null;

  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private static readonly MAX_BUFFER = 64 * 1024;

  constructor(private readonly enabled: boolean) {}

  push(chunk: Buffer): void {
    if (!this.enabled) return;
    try {
      this.ingest(chunk);
    } catch {
      // Never let telemetry affect the relay.
    }
  }

  private ingest(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    if (this.buffer.length > SseUsageScanner.MAX_BUFFER) {
      this.buffer = this.buffer.slice(-SseUsageScanner.MAX_BUFFER);
    }

    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) this.handleLine(line);
  }

  private handleLine(line: string): void {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (payload === "" || payload === "[DONE]") return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;

    const event = parsed as Record<string, unknown>;
    const type = event["type"];

    if (type === "message_start") {
      const message = event["message"];
      if (typeof message === "object" && message !== null) {
        const record = message as Record<string, unknown>;
        if (typeof record["model"] === "string") this.model = record["model"];
        this.absorbUsage(record["usage"]);
      }
    } else if (type === "message_delta") {
      this.absorbUsage(event["usage"]);
    }
  }

  private absorbUsage(value: unknown): void {
    if (typeof value !== "object" || value === null) return;
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (typeof raw === "number" && Number.isFinite(raw)) this.usage[key] = raw;
    }
  }
}

export interface ForwardOptions {
  upstream: string;
  path: string;
  search: string;
  method: string;
  headers: IncomingHttpHeaders;
  body: Buffer | null;
  res: ServerResponse;
}

export interface ForwardResult {
  status: number;
  usage: Record<string, number>;
  modelConfirmed: string | null;
  clientAborted: boolean;
}

/** Forward one request upstream and relay the response back, unmodified. */
export async function forward(options: ForwardOptions): Promise<ForwardResult> {
  const { upstream, path, search, method, headers, body, res } = options;
  const url = `${upstream.replace(/\/+$/, "")}${path}${search}`;

  let upstreamRes: Dispatcher.ResponseData;
  try {
    upstreamRes = await request(url, {
      method: method as Dispatcher.HttpMethod,
      headers: buildUpstreamHeaders(headers),
      body: body ?? undefined,
    });
  } catch (error) {
    throw new UpstreamUnreachable(String(error));
  }

  const contentType = String(upstreamRes.headers["content-type"] ?? "");
  const scanner = new SseUsageScanner(contentType.includes("text/event-stream"));

  res.writeHead(upstreamRes.statusCode, buildDownstreamHeaders(upstreamRes.headers));

  let clientAborted = false;
  try {
    for await (const chunk of upstreamRes.body) {
      const buffer = chunk as Buffer;
      if (res.writableEnded || res.destroyed) {
        clientAborted = true;
        break;
      }
      scanner.push(buffer);
      if (!res.write(buffer)) {
        // Backpressure. Ignoring this buffers the whole conversation in memory.
        await once(res, "drain");
      }
    }
  } finally {
    if (!res.writableEnded && !res.destroyed) res.end();
    upstreamRes.body.destroy();
  }

  return {
    status: upstreamRes.statusCode,
    usage: scanner.usage,
    modelConfirmed: scanner.model,
    clientAborted,
  };
}
