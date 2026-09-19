import { request } from "undici";

import type { Config, RouterName } from "./config.js";
import type { RequestContext } from "./context.js";
import { combine, headProbabilities, jevQuestions } from "./signals.js";

/**
 * Tier routers: `none` (rules only), `head` (local cues), `jev` (TypeSafe,
 * needs TYPESAFE_API_KEY).
 *
 * A router answers one question: which tier should serve this request? It
 * never sees more than the extracted context, and it can never fail a request
 * — any error falls through to the deterministic policy. The Jev request and
 * response shapes are isolated in this file so there is one place to fix if
 * the upstream contract changes.
 */

export const TYPESAFE_BASE_URL = "https://api.typesafe.ai";

// Pinned, not `jev-latest`: the alias moves when TypeSafe ships, which would
// change routing behaviour without a change on our side.
export const DEFAULT_JEV_MODEL = "jev-1.13.0";

/** Raised when a router cannot produce an answer. Always caught, never surfaced. */
export class RouterError extends Error {
  override name = "RouterError";
}

export interface Classification {
  tier: string;
  margin: number;
  probabilities: Record<string, number>;
}

export interface TierRouter {
  readonly name: RouterName;
  classify(ctx: RequestContext): Promise<Classification | null>;
  close(): Promise<void>;
}

export class NullRouter implements TierRouter {
  readonly name = "none" as const;

  classify(): Promise<Classification | null> {
    return Promise.resolve(null);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Local cue matching. Deterministic, zero network, zero vendor.
 *
 * Useful for exercising the seam and for getting a baseline: if Jev cannot beat
 * this, it is not earning a network call.
 */
export class HeadRouter implements TierRouter {
  readonly name = "head" as const;

  classify(ctx: RequestContext): Promise<Classification | null> {
    if (ctx.latestUserText.trim() === "") return Promise.resolve(null);
    const probabilities = headProbabilities(ctx.latestUserText);
    if (Object.keys(probabilities).length === 0) return Promise.resolve(null);
    const { tier, margin } = combine(probabilities);
    return Promise.resolve({ tier, margin, probabilities });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

export interface JevRouterOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export class JevRouter implements TierRouter {
  readonly name = "jev" as const;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: JevRouterOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_JEV_MODEL;
    this.baseUrl = (options.baseUrl ?? TYPESAFE_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 400;
  }

  async classify(ctx: RequestContext): Promise<Classification | null> {
    const text = ctx.latestUserText.trim();
    if (text === "") return null;

    // Only the turn goes in `state`. Jev's window is 32k and its accuracy
    // falls as unrelated material is added, so a transcript would be both
    // wasteful and worse.
    const payload = {
      model: this.model,
      state: { turn: { text, index: ctx.turnIndex } },
      questions: jevQuestions(),
    };

    let response;
    try {
      response = await request(`${this.baseUrl}/v1/systemone`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : "unknown";
      throw new RouterError(`jev call failed (${reason}): ${String(error)}`);
    }

    if (response.statusCode >= 400) {
      await response.body.dump();
      throw new RouterError(`jev HTTP ${response.statusCode}`);
    }

    let data: unknown;
    try {
      data = await response.body.json();
    } catch {
      throw new RouterError("jev returned non-JSON");
    }

    const probabilities = noulProbabilities(data);
    if (Object.keys(probabilities).length === 0) {
      throw new RouterError("jev returned no usable answers");
    }

    const { tier, margin } = combine(probabilities);
    return { tier, margin, probabilities };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Pull P(yes) out of a Jev response. Unrecognised answers are skipped rather
 * than defaulted, so a contract change shows up as a failed call instead of a
 * silent 0.5.
 */
export function noulProbabilities(data: unknown): Record<string, number> {
  if (typeof data !== "object" || data === null) return {};
  const answers = (data as Record<string, unknown>)["answers"];
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) return {};

  const probabilities: Record<string, number> = {};
  for (const [key, value] of Object.entries(answers as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const noul = (value as Record<string, unknown>)["noul"];
    if (typeof noul === "number" && Number.isFinite(noul)) probabilities[key] = noul;
  }
  return probabilities;
}

export interface BuildRouterOptions {
  config: Config;
  env?: Record<string, string | undefined>;
}

/** Construct the configured router. `jev` without a key throws at startup. */
export function buildRouter(options: BuildRouterOptions): TierRouter {
  const { config } = options;
  const env = options.env ?? process.env;
  // Either knob can ask for a router; the main-thread knob wins if both are set.
  const main = config.policy.router;
  const subagent = config.policy.subagentRouter;
  const name = main !== "none" ? main : subagent;

  switch (name) {
    case "none":
      return new NullRouter();
    case "head":
      return new HeadRouter();
    case "jev": {
      const apiKey = (env["TYPESAFE_API_KEY"] ?? "").trim();
      if (apiKey === "") {
        throw new Error(
          'policy.router / policy.subagent_router = "jev" but TYPESAFE_API_KEY is not set',
        );
      }
      return new JevRouter({
        apiKey,
        model: (env["TYPESAFE_MODEL"] ?? "").trim() || DEFAULT_JEV_MODEL,
        timeoutMs: config.policy.routerTimeoutMs,
      });
    }
    default: {
      const exhaustive: never = name;
      throw new Error(`unknown policy.router: ${String(exhaustive)}`);
    }
  }
}
