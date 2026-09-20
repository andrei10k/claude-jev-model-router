import { RouterError, type TierRouter } from "./classify.js";
import { resolveTier, type Config } from "./config.js";
import { isSubagent, stickyKey, type RequestContext } from "./context.js";

/**
 * Ordered rules, first match wins:
 *
 * 1. Protected or exotic model -> untouched.
 * 2. Session already decided   -> hold it.
 * 3. Subagent request          -> tool-set gates, then subagent_router or subagentTier.
 * 4. Main conversation         -> only if mainRouter or mainTier is set (off by default).
 * 5. Otherwise                 -> untouched.
 *
 * Subagent tool-set gates run before any classification:
 * - read-only tool set  -> capped at the cheap tier. An agent without mutation
 *   or exec tools cannot change anything, so the prompt cannot make it harder.
 * - mutation or mixed   -> Jev may still decide, but a downgrade to cheap needs
 *   a wider margin (router_min_margin_mutation): the cost of a wrong cheap
 *   verdict on a repo-writing agent is higher than on a read-only one.
 *
 * Observe mode (enabled = false) runs all of this — router calls included —
 * but applies nothing. Every decision is logged with what would have happened.
 */

// fable, best, default signal deliberate human intent. A proxy has no business
// second-guessing that.
export const ROUTABLE_FAMILIES = ["opus", "sonnet", "haiku"] as const;
const KNOWN_FAMILIES = [...ROUTABLE_FAMILIES, "fable"] as const;

export const STICKY_TTL_MS = 12 * 60 * 60 * 1000;
export const MAX_STICKY_ENTRIES = 4096;

/** Map a model ID to its family, or null when unrecognised.
 *
 * An unrecognised model is never rewritten — guessing at an ID we don't
 * understand is how a proxy breaks a session.
 */
export function familyOf(model: string): string | null {
  if (model === "") return null;
  const lowered = model.toLowerCase();

  for (const family of KNOWN_FAMILIES) {
    if (lowered === family) return family;
  }

  const marker = "claude-";
  const index = lowered.indexOf(marker);
  if (index === -1) return null;

  const tail = lowered.slice(index + marker.length);
  for (const family of KNOWN_FAMILIES) {
    if (tail.startsWith(family)) return family;
  }
  return null;
}

export type DecisionSource = "passthrough" | "rule" | "router" | "sticky";

export interface Decision {
  modelOut: string;
  rewritten: boolean;
  tier: string | null;
  reason: string;
  source: DecisionSource;
  margin: number | null;
  routerMs: number | null;
  routerError: string | null;
  /** True when the decision was computed but NOT applied (observe mode). */
  observe: boolean;
}

export function decisionLogFields(decision: Decision): Record<string, unknown> {
  return {
    model_out: decision.modelOut,
    rewritten: decision.rewritten,
    observe: decision.observe ? true : undefined,
    tier: decision.tier,
    decision_source: decision.source,
    reason: decision.reason,
    router_margin: decision.margin === null ? null : Math.round(decision.margin * 1e4) / 1e4,
    router_ms: decision.routerMs === null ? null : Math.round(decision.routerMs * 10) / 10,
    router_error: decision.routerError,
  };
}

interface SettleInput {
  ctx: RequestContext;
  tier: string | null;
  resolved: string | null;
  source: DecisionSource;
  reason: string;
  modelIn?: string;
  margin?: number | null;
  routerMs?: number | null;
  routerError?: string | null;
  observe?: boolean;
}

/** Decides which model serves a request. Never mutates the request. */
export class Policy {
  private readonly config: Config;
  private readonly router: TierRouter;
  private readonly sticky = new Map<string, { tier: string; at: number }>();

  constructor(config: Config, router: TierRouter) {
    this.config = config;
    this.router = router;
  }

  async decide(ctx: RequestContext): Promise<Decision> {
    const { policy } = this.config;
    const modelIn = ctx.modelIn;
    // Observe mode never writes the sticky map, so every request is judged fresh.
    const observe = !policy.enabled;

    if (modelIn === "") return this.passthrough(modelIn, "request carried no model");
    if (policy.neverReroute.includes(modelIn)) {
      return this.passthrough(modelIn, "listed in never_reroute");
    }
    if (modelIn.endsWith("[1m]")) {
      return this.passthrough(modelIn, "extended-context variant pinned by the client");
    }

    const family = familyOf(modelIn);
    if (family === null || !(ROUTABLE_FAMILIES as readonly string[]).includes(family)) {
      return this.passthrough(modelIn, "model family is not routable");
    }

    // 3. Hold whatever this session or subagent was already given. Observe
    // mode never writes the map, so there is nothing to hold while observing.
    if (policy.sticky && !observe) {
      const held = this.held(stickyKey(ctx));
      if (held !== null) {
        const resolved = resolveTier(this.config, held);
        if (resolved !== null) {
          return this.settle({
            ctx,
            tier: held,
            resolved,
            source: "sticky",
            reason: `session held on '${held}'`,
          });
        }
      }
    }

    // The only place the router runs by default. A subagent starts at a
    // delegation boundary — nothing cached to invalidate — and delegated tasks
    // genuinely differ in difficulty. Low margin, timeout or error falls back
    // to the static tier.
    if (isSubagent(ctx)) {
      // Read-only agents (no mutation, no exec tools) cannot modify the repo.
      // Whatever the delegation prompt says, the work cannot be more than a
      // lookup, so skip the router and cap at the cheap tier.
      if (policy.subagentTier && ctx.toolClass === "readonly") {
        return this.settle({
          ctx,
          tier: policy.subagentTier,
          resolved: resolveTier(this.config, policy.subagentTier),
          source: "rule",
          reason: `read-only tool set (${ctx.toolCount} tools), capped at '${policy.subagentTier}'`,
          modelIn,
          observe,
        });
      }

      if (policy.subagentRouter !== "none" && this.router.name !== "none") {
        const verdict = await this.consultRouter(ctx);
        if (verdict.tier !== null && verdict.margin !== null) {
          // A downgrade to cheap on an agent with mutation tools needs more
          // confidence than usual: a wrong cheap verdict there can rewrite the
          // repo. Upgrades keep the normal bar.
          const mutationRisk = ctx.toolClass === "mutating" || ctx.toolClass === "mixed";
          const downgrade = verdict.tier === "cheap" && mutationRisk;
          const requiredMargin = downgrade ? policy.routerMinMarginMutation : policy.routerMinMargin;
          if (verdict.margin >= requiredMargin) {
            return this.settle({
              ctx,
              tier: verdict.tier,
              resolved: resolveTier(this.config, verdict.tier),
              source: "router",
              reason:
                `router '${this.router.name}' chose '${verdict.tier}' at margin ` +
                `${verdict.margin.toFixed(2)} for a subagent` +
                (downgrade
                  ? ` (mutation tools, downgrades need ${policy.routerMinMarginMutation})`
                  : ""),
              modelIn,
              margin: verdict.margin,
              routerMs: verdict.ms,
              observe,
            });
          }
        }
        if (policy.subagentTier) {
          // Fail-open tier: for mutation-capable agents the cautious default is
          // mid (falling back to cheap there is how a wrong edit happens).
          const mutationRisk = ctx.toolClass === "mutating" || ctx.toolClass === "mixed";
          const fallbackTier = mutationRisk ? "mid" : (policy.subagentTier ?? "mid");
          return this.settle({
            ctx,
            tier: fallbackTier,
            resolved: resolveTier(this.config, fallbackTier),
            source: "rule",
            reason: mutationRisk
              ? `work delegated to a mutation-capable subagent (router verdict below margin or unavailable), cautious default 'mid'`
              : "work delegated to a subagent (router verdict below margin or unavailable)",
            modelIn,
            margin: verdict.margin,
            routerMs: verdict.ms,
            routerError: verdict.error,
            observe,
          });
        }
        return this.passthrough(modelIn, "subagent, no subagent_tier configured");
      }
      if (policy.subagentTier) {
        return this.settle({
          ctx,
          tier: policy.subagentTier,
          resolved: resolveTier(this.config, policy.subagentTier),
          source: "rule",
          reason: "work delegated to a subagent",
          modelIn,
          observe,
        });
      }
      return this.passthrough(modelIn, "subagent, no subagent_tier configured");
    }

    // Main conversation is opt-in only. Its prompt cache is the most valuable
    // one, and a mid-session model switch re-reads the whole conversation
    // uncached.
    let tier: string | null = null;
    let margin: number | null = null;
    let routerMs: number | null = null;
    let routerError: string | null = null;
    let routerTier: string | null = null;

    if (policy.mainRouter && this.router.name !== "none") {
      const verdict = await this.consultRouter(ctx);
      routerMs = verdict.ms;
      routerError = verdict.error;
      if (verdict.tier !== null) {
        routerTier = verdict.tier;
        margin = verdict.margin;
      }
    }

    if (routerTier !== null && margin !== null && margin >= policy.routerMinMargin) {
      return this.settle({
        ctx,
        tier: routerTier,
        resolved: resolveTier(this.config, routerTier),
        source: "router",
        reason: `router '${this.router.name}' chose '${routerTier}' at margin ${margin.toFixed(2)}`,
        modelIn,
        margin,
        routerMs,
        observe,
      });
    }
    if (routerTier !== null) tier = routerTier;

    if (policy.mainTier) {
      return this.settle({
        ctx,
        tier: policy.mainTier,
        resolved: resolveTier(this.config, policy.mainTier),
        source: "rule",
        reason: "main-thread default",
        modelIn,
        routerMs,
        routerError,
        observe,
      });
    }

    return this.passthrough(modelIn, this.explainNoRoute(tier, margin, routerError));
  }

  /** Ask the router, timing it. Any failure becomes a loggable error, never an exception. */
  private async consultRouter(
    ctx: RequestContext,
  ): Promise<{ tier: string | null; margin: number | null; ms: number; error: string | null }> {
    const started = performance.now();
    try {
      const classification = await this.router.classify(ctx);
      const ms = performance.now() - started;
      if (classification === null) {
        return { tier: null, margin: null, ms, error: null };
      }
      return { tier: classification.tier, margin: classification.margin, ms, error: null };
    } catch (error) {
      const ms = performance.now() - started;
      return {
        tier: null,
        margin: null,
        ms,
        error:
          error instanceof RouterError
            ? error.message
            : `unexpected router error: ${String(error)}`,
      };
    }
  }

  /** Model for a token-count call: follows the session's held tier. */
  modelForTokens(ctx: RequestContext): string {
    if (this.config.policy.enabled && this.config.policy.sticky) {
      const held = this.held(stickyKey(ctx));
      if (held !== null) {
        const resolved = resolveTier(this.config, held);
        if (resolved !== null) return resolved;
      }
    }
    return ctx.modelIn;
  }

  /** Number of live sticky entries. Test and diagnostics only. */
  get stickySize(): number {
    return this.sticky.size;
  }

  private explainNoRoute(
    tier: string | null,
    margin: number | null,
    routerError: string | null,
  ): string {
    if (routerError !== null) {
      return `main thread left alone (router unavailable: ${routerError})`;
    }
    if (tier !== null && margin !== null) {
      return (
        `main thread left alone (router chose '${tier}' at margin ` +
        `${margin.toFixed(2)}, below ${this.config.policy.routerMinMargin})`
      );
    }
    if (!this.config.policy.mainRouter) {
      return "main thread left alone (main_router is off)";
    }
    return "main thread left alone";
  }

  private settle(input: SettleInput): Decision {
    const {
      ctx,
      tier,
      resolved,
      source,
      reason,
      modelIn,
      margin = null,
      routerMs = null,
      routerError = null,
      observe = false,
    } = input;
    const incoming = modelIn ?? ctx.modelIn;

    if (resolved === null) {
      return {
        modelOut: incoming,
        rewritten: false,
        tier,
        reason: `tier '${tier}' is not defined in [tiers]`,
        source: "passthrough",
        margin: null,
        routerMs,
        routerError,
        observe,
      };
    }

    const rewritten = resolved !== incoming;
    const applied = rewritten && !observe;
    if (this.config.policy.sticky && tier !== null && !observe) {
      this.remember(stickyKey(ctx), tier);
    }

    return {
      modelOut: applied ? resolved : incoming,
      rewritten: applied,
      tier,
      reason: observe
        ? rewritten
          ? `observe: would rewrite to ${resolved} (${reason})`
          : `observe: no rewrite needed (${reason}; already on ${resolved})`
        : rewritten
          ? reason
          : `${reason}; already on ${resolved}`,
      source,
      margin,
      routerMs,
      routerError,
      observe,
    };
  }

  private passthrough(modelIn: string, reason: string): Decision {
    return {
      modelOut: modelIn,
      rewritten: false,
      tier: null,
      reason,
      source: "passthrough",
      margin: null,
      routerMs: null,
      routerError: null,
      observe: false,
    };
  }

  private held(key: string): string | null {
    const entry = this.sticky.get(key);
    if (entry === undefined) return null;
    if (Date.now() - entry.at > STICKY_TTL_MS) {
      this.sticky.delete(key);
      return null;
    }
    return entry.tier;
  }

  private remember(key: string, tier: string): void {
    if (key === "") return;
    if (this.sticky.size >= MAX_STICKY_ENTRIES) this.prune();
    this.sticky.set(key, { tier, at: Date.now() });
  }

  private prune(): void {
    const cutoff = Date.now() - STICKY_TTL_MS;
    for (const [key, entry] of this.sticky) {
      if (entry.at < cutoff) this.sticky.delete(key);
    }
    if (this.sticky.size < MAX_STICKY_ENTRIES) return;

    // Still full: drop the oldest half.
    const ordered = [...this.sticky.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [key] of ordered.slice(0, Math.floor(ordered.length / 2))) {
      this.sticky.delete(key);
    }
  }
}
