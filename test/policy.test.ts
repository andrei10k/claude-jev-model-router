import { describe, expect, it } from "vitest";

import { RouterError, type Classification, type TierRouter } from "../src/classify.js";
import { defaultConfig, type Config, type PolicyConfig } from "../src/config.js";
import type { RequestContext } from "../src/context.js";
import { familyOf, Policy } from "../src/policy.js";
class SpyRouter implements TierRouter {
  readonly name = "head" as const;
  calls = 0;

  constructor(
    private readonly result: Classification | null,
    private readonly fail = false,
  ) {}

  classify(): Promise<Classification | null> {
    this.calls += 1;
    if (this.fail) throw new RouterError("boom");
    return Promise.resolve(this.result);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function makeConfig(policy: Partial<PolicyConfig> = {}): Config {
  const config = defaultConfig();
  config.policy = { ...config.policy, enabled: true, ...policy };
  return config;
}

function makeContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    sessionId: "session-1",
    agentId: null,
    parentAgentId: null,
    modelIn: "claude-opus-5",
    latestUserText: "",
    turnIndex: 0,
    bodyBytes: 0,
    toolCount: 0,
    toolClass: "mixed",
    maxTokens: null,
    stream: true,
    ...overrides,
  };
}

describe("familyOf", () => {
  it("recognises aliases, first-party ids and provider-prefixed ids", () => {
    expect(familyOf("opus")).toBe("opus");
    expect(familyOf("claude-opus-5")).toBe("opus");
    expect(familyOf("claude-sonnet-5")).toBe("sonnet");
    expect(familyOf("us.anthropic.claude-haiku-4-5-v1:0")).toBe("haiku");
    expect(familyOf("claude-fable-5-1")).toBe("fable");
  });

  it("returns null for anything it does not understand", () => {
    expect(familyOf("")).toBeNull();
    expect(familyOf("gpt-5")).toBeNull();
    expect(familyOf("my-gateway-model")).toBeNull();
  });
});

describe("Policy precedence", () => {
  it("rewrites nothing in observe mode but still evaluates the policy", async () => {
    const policy = new Policy(
      makeConfig({ enabled: false, subagentTier: "cheap" }),
      new SpyRouter(null),
    );
    const decision = await policy.decide(makeContext({ agentId: "agent-1" }));

    expect(decision.rewritten).toBe(false);
    expect(decision.modelOut).toBe("claude-opus-5");
    expect(decision.tier).toBe("cheap");
    expect(decision.observe).toBe(true);
    expect(decision.reason).toContain("observe: would rewrite");
  });

  it("routes subagent work to the cheap tier", async () => {
    const policy = new Policy(makeConfig(), new SpyRouter(null));
    const decision = await policy.decide(
      makeContext({ agentId: "agent-1", modelIn: "claude-opus-5" }),
    );

    expect(decision.rewritten).toBe(true);
    expect(decision.modelOut).toBe("claude-haiku-4-5");
    expect(decision.tier).toBe("cheap");
    expect(decision.source).toBe("rule");
  });

  it("leaves the main thread alone by default", async () => {
    const policy = new Policy(makeConfig(), new SpyRouter(null));
    const decision = await policy.decide(makeContext({ latestUserText: "why is CI red?" }));

    expect(decision.rewritten).toBe(false);
    expect(decision.reason).toContain("main_router is off");
  });

  it("routes the main thread when main_tier is set", async () => {
    const policy = new Policy(makeConfig({ mainTier: "mid" }), new SpyRouter(null));
    const decision = await policy.decide(makeContext());

    expect(decision.rewritten).toBe(true);
    expect(decision.modelOut).toBe("claude-sonnet-5");
  });
});

describe("Policy exceptions", () => {
  it("never rewrites a model listed in never_reroute", async () => {
    const policy = new Policy(
      makeConfig({ neverReroute: ["claude-opus-5"] }),
      new SpyRouter(null),
    );
    const decision = await policy.decide(makeContext({ agentId: "agent-1" }));

    expect(decision.rewritten).toBe(false);
    expect(decision.reason).toContain("never_reroute");
  });

  it("never rewrites an extended-context variant", async () => {
    const policy = new Policy(makeConfig(), new SpyRouter(null));
    const decision = await policy.decide(makeContext({ modelIn: "claude-opus-5[1m]" }));

    expect(decision.rewritten).toBe(false);
    expect(decision.reason).toContain("extended-context");
  });

  it("never rewrites a family outside the routable set", async () => {
    const policy = new Policy(makeConfig(), new SpyRouter(null));

    const fable = await policy.decide(makeContext({ modelIn: "claude-fable-5-1" }));
    expect(fable.rewritten).toBe(false);

    const unknown = await policy.decide(makeContext({ modelIn: "my-gateway-model" }));
    expect(unknown.rewritten).toBe(false);
    expect(unknown.reason).toContain("not routable");
  });

  it("degrades to passthrough when a tier is not defined", async () => {
    const config = makeConfig({ mainTier: "typo" });
    const policy = new Policy(config, new SpyRouter(null));
    const decision = await policy.decide(makeContext());

    expect(decision.rewritten).toBe(false);
    expect(decision.reason).toContain("not defined in [tiers]");
  });
});

describe("Policy stickiness", () => {
  it("holds the chosen tier across turns in a session", async () => {
    const policy = new Policy(makeConfig({ mainTier: "mid" }), new SpyRouter(null));

    const first = await policy.decide(makeContext());
    const second = await policy.decide(makeContext({ turnIndex: 8 }));

    expect(first.modelOut).toBe("claude-sonnet-5");
    expect(second.modelOut).toBe("claude-sonnet-5");
    expect(second.source).toBe("sticky");
    expect(second.reason).toContain("session held on 'mid'");
  });

  it("gives subagents their own decision", async () => {
    const policy = new Policy(makeConfig({ mainTier: "mid" }), new SpyRouter(null));

    await policy.decide(makeContext());
    const subagent = await policy.decide(makeContext({ agentId: "agent-1" }));

    expect(subagent.modelOut).toBe("claude-haiku-4-5");
    expect(subagent.tier).toBe("cheap");
  });

  it("does not let a subagent drag the main conversation down", async () => {
    const policy = new Policy(makeConfig({ mainTier: "mid" }), new SpyRouter(null));

    await policy.decide(makeContext({ agentId: "agent-1" }));
    const main = await policy.decide(makeContext());

    expect(main.modelOut).toBe("claude-sonnet-5");
  });

  it("records a decision even when the model is already on tier", async () => {
    const policy = new Policy(
      makeConfig({ subagentTier: "premium" }),
      new SpyRouter(null),
    );
    const first = await policy.decide(makeContext({ agentId: "a", modelIn: "claude-opus-5" }));
    expect(first.rewritten).toBe(false);
    expect(first.reason).toContain("already on");

    // Tier is still held, so a cheaper incoming model gets pulled back up.
    const second = await policy.decide(makeContext({ agentId: "a", modelIn: "claude-haiku-4-5" }));
    expect(second.source).toBe("sticky");
    expect(second.modelOut).toBe("claude-opus-5");
  });
});

describe("Policy router integration", () => {
  it("does not consult the router unless main_router is on", async () => {
    const router = new SpyRouter({ tier: "premium", margin: 0.9, probabilities: {} });
    const policy = new Policy(makeConfig({ router: "head" }), router);

    await policy.decide(makeContext({ latestUserText: "why is this flaky?" }));
    expect(router.calls).toBe(0);
  });

  it("uses a router verdict that clears the margin", async () => {
    const router = new SpyRouter({ tier: "premium", margin: 0.9, probabilities: {} });
    const policy = new Policy(makeConfig({ mainRouter: true }), router);

    const decision = await policy.decide(makeContext({ latestUserText: "why is this flaky?" }));

    expect(router.calls).toBe(1);
    expect(decision.modelOut).toBe("claude-opus-5");
    expect(decision.source).toBe("router");
  });

  it("ignores a router verdict that is too close to call", async () => {
    const router = new SpyRouter({ tier: "premium", margin: 0.01, probabilities: {} });
    const policy = new Policy(
      makeConfig({ mainRouter: true, mainTier: "mid" }),
      router,
    );

    const decision = await policy.decide(makeContext());

    expect(decision.modelOut).toBe("claude-sonnet-5");
    expect(decision.source).toBe("rule");
  });

  it("fails open when the router throws", async () => {
    const router = new SpyRouter(null, true);
    const policy = new Policy(
      makeConfig({ mainRouter: true, mainTier: "mid" }),
      router,
    );

    const decision = await policy.decide(makeContext());

    expect(decision.modelOut).toBe("claude-sonnet-5");
    expect(decision.routerError).toContain("boom");
  });

  it("explains why nothing was routed when the router fails and there is no fallback", async () => {
    const router = new SpyRouter(null, true);
    const policy = new Policy(makeConfig({ mainRouter: true }), router);

    const decision = await policy.decide(makeContext());

    expect(decision.rewritten).toBe(false);
    expect(decision.reason).toContain("router unavailable");
  });
});

describe("Policy.modelForTokens", () => {
  it("follows the session tier without creating a decision", async () => {
    const router = new SpyRouter(null);
    const policy = new Policy(makeConfig({ mainTier: "mid" }), router);

    await policy.decide(makeContext());
    expect(policy.modelForTokens(makeContext())).toBe("claude-sonnet-5");
    expect(router.calls).toBe(0);
  });

  it("passes through when the session has no held tier", () => {
    const policy = new Policy(makeConfig(), new SpyRouter(null));
    expect(policy.modelForTokens(makeContext())).toBe("claude-opus-5");
  });
});

describe("Observe mode", () => {
  it("logs the router verdict for a subagent without rewriting", async () => {
    const router = new SpyRouter({ tier: "mid", margin: 0.9, probabilities: {} });
    const policy = new Policy(
      makeConfig({ enabled: false, subagentRouter: "head" }),
      router,
    );

    const decision = await policy.decide(makeContext({ agentId: "agent-1" }));

    expect(router.calls).toBe(1);
    expect(decision.rewritten).toBe(false);
    expect(decision.modelOut).toBe("claude-opus-5");
    expect(decision.tier).toBe("mid");
    expect(decision.observe).toBe(true);
    expect(decision.source).toBe("router");
    expect(decision.reason).toContain("would rewrite to claude-sonnet-5");
  });

  it("never sticks in observe mode, so every request is judged fresh", async () => {
    const router = new SpyRouter({ tier: "mid", margin: 0.9, probabilities: {} });
    const policy = new Policy(
      makeConfig({ enabled: false, subagentRouter: "head" }),
      router,
    );

    await policy.decide(makeContext({ agentId: "agent-1" }));
    const second = await policy.decide(makeContext({ agentId: "agent-1" }));

    expect(router.calls).toBe(2);
    expect(second.source).toBe("router");
    expect(second.observe).toBe(true);
    expect(policy.stickySize).toBe(0);
  });

  it("still leaves never_reroute models untouched while observing", async () => {
    const router = new SpyRouter({ tier: "mid", margin: 0.9, probabilities: {} });
    const policy = new Policy(
      makeConfig({ enabled: false, subagentRouter: "head", neverReroute: ["claude-opus-5"] }),
      router,
    );

    const decision = await policy.decide(makeContext({ agentId: "agent-1" }));

    expect(router.calls).toBe(0);
    expect(decision.observe).toBe(false);
    expect(decision.tier).toBeNull();
  });
});

describe("Subagent routing", () => {
  it("uses the router verdict for a subagent when it clears the margin", async () => {
    const router = new SpyRouter({ tier: "premium", margin: 0.9, probabilities: {} });
    const policy = new Policy(makeConfig({ subagentRouter: "head" }), router);

    const decision = await policy.decide(makeContext({ agentId: "agent-1" }));

    expect(router.calls).toBe(1);
    expect(decision.source).toBe("router");
    expect(decision.modelOut).toBe("claude-opus-5");
    expect(decision.reason).toContain("for a subagent");
  });

  it("falls back to subagent_tier when the verdict is too close to call", async () => {
    const router = new SpyRouter({ tier: "premium", margin: 0.01, probabilities: {} });
    const policy = new Policy(
      makeConfig({ subagentRouter: "head", subagentTier: "cheap" }),
      router,
    );

    const decision = await policy.decide(
      makeContext({ agentId: "agent-1", toolClass: "exec", toolCount: 3 }),
    );

    expect(decision.source).toBe("rule");
    expect(decision.modelOut).toBe("claude-haiku-4-5");
    expect(decision.routerError).toBeNull();
  });

  it("falls back to subagent_tier when the router throws", async () => {
    const router = new SpyRouter(null, true);
    const policy = new Policy(
      makeConfig({ subagentRouter: "head", subagentTier: "cheap" }),
      router,
    );

    const decision = await policy.decide(
      makeContext({ agentId: "agent-1", toolClass: "exec", toolCount: 3 }),
    );

    expect(decision.source).toBe("rule");
    expect(decision.modelOut).toBe("claude-haiku-4-5");
    expect(decision.routerError).toContain("boom");
  });

  it("holds the router's verdict for the subagent's lifetime", async () => {
    const router = new SpyRouter({ tier: "premium", margin: 0.9, probabilities: {} });
    const policy = new Policy(makeConfig({ subagentRouter: "head" }), router);

    const first = await policy.decide(makeContext({ agentId: "agent-1" }));
    const second = await policy.decide(
      makeContext({ agentId: "agent-1", turnIndex: 5 }),
    );

    expect(router.calls).toBe(1);
    expect(first.source).toBe("router");
    expect(second.source).toBe("sticky");
    expect(second.modelOut).toBe("claude-opus-5");
  });

  it("does not consult the router for a subagent when subagent_router is none", async () => {
    const router = new SpyRouter({ tier: "premium", margin: 0.9, probabilities: {} });
    const policy = new Policy(makeConfig(), router);

    const decision = await policy.decide(makeContext({ agentId: "agent-1" }));

    expect(router.calls).toBe(0);
    expect(decision.source).toBe("rule");
    expect(decision.modelOut).toBe("claude-haiku-4-5");
  });

  it("caps read-only subagents at the cheap tier without a router call", async () => {
    const router = new SpyRouter({ tier: "premium", margin: 0.9, probabilities: {} });
    const policy = new Policy(makeConfig({ subagentRouter: "head" }), router);

    const decision = await policy.decide(
      makeContext({ agentId: "agent-1", toolClass: "readonly", toolCount: 4 }),
    );

    expect(router.calls).toBe(0);
    expect(decision.source).toBe("rule");
    expect(decision.modelOut).toBe("claude-haiku-4-5");
    expect(decision.reason).toContain("read-only tool set");
  });

  it("caps read-only subagents even when the router is disabled", async () => {
    const router = new SpyRouter({ tier: "mid", margin: 0.9, probabilities: {} });
    const policy = new Policy(makeConfig({ subagentRouter: "none" }), router);

    const decision = await policy.decide(
      makeContext({ agentId: "agent-1", toolClass: "readonly", toolCount: 4 }),
    );

    expect(decision.source).toBe("rule");
    expect(decision.modelOut).toBe("claude-haiku-4-5");
  });

  it("requires the wider mutation margin before downgrading a mutating subagent to cheap", async () => {
    // Margin 0.22 clears the normal gate (0.15) but not the mutation gate (0.30).
    const router = new SpyRouter({ tier: "cheap", margin: 0.22, probabilities: {} });
    const policy = new Policy(
      makeConfig({ subagentRouter: "head", subagentTier: "cheap" }),
      router,
    );

    const decision = await policy.decide(
      makeContext({ agentId: "agent-1", toolClass: "mutating", toolCount: 5 }),
    );

    expect(router.calls).toBe(1);
    expect(decision.source).toBe("rule");
    expect(decision.modelOut).toBe("claude-sonnet-5");
    expect(decision.reason).toContain("mutation-capable");
  });

  it("lets a confident cheap verdict through for a mutating subagent", async () => {
    // A codebase-wide rename: mechanical signal dominates, margin ~0.4.
    const router = new SpyRouter({ tier: "cheap", margin: 0.4, probabilities: {} });
    const policy = new Policy(
      makeConfig({ subagentRouter: "head", subagentTier: "cheap" }),
      router,
    );

    const decision = await policy.decide(
      makeContext({ agentId: "agent-1", toolClass: "mutating", toolCount: 5 }),
    );

    expect(decision.source).toBe("router");
    expect(decision.modelOut).toBe("claude-haiku-4-5");
    expect(decision.reason).toContain("mutation tools");
  });

  it("keeps the normal margin for upgrades of mutating subagents", async () => {
    // premium verdict on a mutating agent: upgrade, normal gate applies.
    const router = new SpyRouter({ tier: "premium", margin: 0.2, probabilities: {} });
    const policy = new Policy(
      makeConfig({ subagentRouter: "head", subagentTier: "cheap" }),
      router,
    );

    const decision = await policy.decide(
      makeContext({ agentId: "agent-1", toolClass: "mutating", toolCount: 5 }),
    );

    expect(decision.source).toBe("router");
    expect(decision.modelOut).toBe("claude-opus-5");
  });

  it("falls mutating subagents back to mid when the router is unavailable", async () => {
    const router = new SpyRouter(null, true);
    const policy = new Policy(
      makeConfig({ subagentRouter: "head", subagentTier: "cheap" }),
      router,
    );

    const decision = await policy.decide(
      makeContext({ agentId: "agent-1", toolClass: "mutating", toolCount: 5 }),
    );

    expect(decision.source).toBe("rule");
    expect(decision.modelOut).toBe("claude-sonnet-5");
    expect(decision.reason).toContain("cautious default 'mid'");
  });

  it("keeps the static tier for read-only fallback even with a router error", async () => {
    const router = new SpyRouter(null, true);
    const policy = new Policy(
      makeConfig({ subagentRouter: "head", subagentTier: "cheap" }),
      router,
    );

    const decision = await policy.decide(
      makeContext({ agentId: "agent-1", toolClass: "exec", toolCount: 3 }),
    );

    expect(decision.source).toBe("rule");
    expect(decision.modelOut).toBe("claude-haiku-4-5");
  });
});
