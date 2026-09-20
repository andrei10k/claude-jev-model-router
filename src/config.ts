import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { parse as parseToml } from "smol-toml";

export type RouterName = "none" | "head" | "jev";

export const DEFAULT_TIERS: Readonly<Record<string, string>> = Object.freeze({
  cheap: "claude-haiku-4-5",
  mid: "claude-sonnet-5",
  premium: "claude-opus-5",
});

export const DEFAULT_LOG = "~/.claude-model-router/decisions.jsonl";
export const DEFAULT_UPSTREAM = "https://api.anthropic.com";

export interface PolicyConfig {
  /** false = observe only: nothing rewritten, everything logged. */
  enabled: boolean;
  /** Hold one decision per session/subagent. Protects the prompt cache. */
  sticky: boolean;
  subagentTier: string | null;
  /** Router consulted for subagent requests. "none" = static subagent_tier. */
  subagentRouter: RouterName;
  mainTier: string | null;
  /** Opt-in: let the router decide the main conversation. */
  mainRouter: boolean;
  neverReroute: string[];
  router: RouterName;
  routerTimeoutMs: number;
  routerMinMargin: number;
  /** Stricter margin for downgrading to cheap a subagent with mutation tools. */
  routerMinMarginMutation: number;
}

export interface Config {
  upstream: string;
  host: string;
  port: number;
  log: string | null;
  tiers: Record<string, string>;
  policy: PolicyConfig;
}

/** Expand a leading `~` the way a shell would. */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

export function defaultPolicy(): PolicyConfig {
  return {
    enabled: false,
    sticky: true,
    subagentTier: "cheap",
    subagentRouter: "none",
    mainTier: null,
    mainRouter: false,
    neverReroute: [],
    router: "none",
    routerTimeoutMs: 3000,
    routerMinMargin: 0.15,
    routerMinMarginMutation: 0.3,
  };
}

export function defaultConfig(): Config {
  return {
    upstream: DEFAULT_UPSTREAM,
    host: "127.0.0.1",
    port: 8787,
    log: expandHome(DEFAULT_LOG),
    tiers: { ...DEFAULT_TIERS },
    policy: defaultPolicy(),
  };
}

/**
 * Resolve a tier name to a model ID. Unknown tier returns null rather than a
 * default: a config typo should surface as "not routed" in the log, not as a
 * silent downgrade of every request.
 */
export function resolveTier(config: Config, tier: string | null | undefined): string | null {
  if (!tier) return null;
  return config.tiers[tier] ?? null;
}

const POLICY_KEYS = [
  "enabled",
  "sticky",
  "subagent_tier",
  "subagent_router",
  "main_tier",
  "main_router",
  "never_reroute",
  "router",
  "router_timeout_ms",
  "router_min_margin",
  "router_min_margin_mutation",
] as const;

const ROUTER_NAMES: readonly RouterName[] = ["none", "head", "jev"];

function asString(value: unknown, key: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`[policy] ${key} must be a string, got ${typeof value}`);
  }
  return value;
}

function asBoolean(value: unknown, key: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new Error(`[policy] ${key} must be a boolean, got ${typeof value}`);
  }
  return value;
}

function asNumber(value: unknown, key: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`[policy] ${key} must be a number, got ${typeof value}`);
  }
  return value;
}

function asStringArray(value: unknown, key: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`[policy] ${key} must be an array of strings`);
  }
  return value as string[];
}

function parsePolicy(raw: unknown): PolicyConfig {
  const policy = defaultPolicy();
  if (raw === undefined) return policy;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("[policy] must be a table");
  }

  const table = raw as Record<string, unknown>;
  const unknown = Object.keys(table).filter(
    (key) => !(POLICY_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw new Error(
      `unknown [policy] keys: ${unknown.sort().join(", ")}. ` +
        `Known keys: ${[...POLICY_KEYS].sort().join(", ")}`,
    );
  }

  policy.enabled = asBoolean(table["enabled"], "enabled", policy.enabled);
  policy.sticky = asBoolean(table["sticky"], "sticky", policy.sticky);
  policy.mainRouter = asBoolean(table["main_router"], "main_router", policy.mainRouter);
  policy.subagentTier = asString(table["subagent_tier"], "subagent_tier") ?? policy.subagentTier;
  policy.mainTier = asString(table["main_tier"], "main_tier");
  policy.neverReroute = asStringArray(table["never_reroute"], "never_reroute");
  policy.routerTimeoutMs = asNumber(
    table["router_timeout_ms"],
    "router_timeout_ms",
    policy.routerTimeoutMs,
  );
  policy.routerMinMargin = asNumber(
    table["router_min_margin"],
    "router_min_margin",
    policy.routerMinMargin,
  );
  policy.routerMinMarginMutation = asNumber(
    table["router_min_margin_mutation"],
    "router_min_margin_mutation",
    policy.routerMinMarginMutation,
  );

  const router = asString(table["router"], "router");
  const subagentRouter = asString(table["subagent_router"], "subagent_router");
  for (const [key, value] of [
    ["router", router],
    ["subagent_router", subagentRouter],
  ] as const) {
    if (value === null) continue;
    if (!(ROUTER_NAMES as readonly string[]).includes(value)) {
      throw new Error(
        `[policy] ${key} must be one of ${ROUTER_NAMES.join(", ")}, got ${JSON.stringify(value)}`,
      );
    }
  }
  if (router !== null) policy.router = router as RouterName;
  if (subagentRouter !== null) policy.subagentRouter = subagentRouter as RouterName;

  return policy;
}

export interface LoadOptions {
  configPath?: string | null;
}

/** Load config from TOML, falling back to defaults. A missing file is fine. */
export function loadConfig(options: LoadOptions = {}): Config {
  const config = defaultConfig();
  const { configPath } = options;
  if (!configPath) return config;

  const path = expandHome(configPath);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`config not found: ${path}`);
  }

  const data = parseToml(text) as Record<string, unknown>;

  const upstream = data["upstream"];
  if (typeof upstream === "string" && upstream.length > 0) config.upstream = upstream;

  const host = data["host"];
  if (typeof host === "string" && host.length > 0) config.host = host;

  const port = data["port"];
  if (typeof port === "number" && Number.isInteger(port)) config.port = port;

  const log = data["log"];
  if (typeof log === "string") config.log = log === "" ? null : expandHome(log);

  const tiers = data["tiers"];
  if (tiers !== undefined) {
    if (typeof tiers !== "object" || tiers === null || Array.isArray(tiers)) {
      throw new Error("[tiers] must be a table");
    }
    for (const [name, model] of Object.entries(tiers as Record<string, unknown>)) {
      if (typeof model !== "string") {
        throw new Error(`[tiers] ${name} must be a string`);
      }
      config.tiers[name] = model;
    }
  }

  config.policy = parsePolicy(data["policy"]);
  return config;
}

/** Redacted view for `--print-config`. */
export function describeConfig(config: Config): Record<string, unknown> {
  const { policy, ...rest } = config;
  return {
    ...rest,
    policy: {
      enabled: policy.enabled,
      sticky: policy.sticky,
      subagent_tier: policy.subagentTier,
      subagent_router: policy.subagentRouter,
      main_tier: policy.mainTier,
      main_router: policy.mainRouter,
      never_reroute: policy.neverReroute,
      router: policy.router,
      router_timeout_ms: policy.routerTimeoutMs,
      router_min_margin: policy.routerMinMargin,
      router_min_margin_mutation: policy.routerMinMarginMutation,
    },
  };
}
