#!/usr/bin/env node
import { buildRouter } from "./classify.js";
import { describeConfig, expandHome, loadConfig, type Config, type RouterName } from "./config.js";
import { DecisionLog } from "./decisions.js";
import { loadDotEnv } from "./envfile.js";
import { Policy } from "./policy.js";
import { createServer } from "./server.js";

const USAGE = `
claude-model-router — local routing proxy for Claude Code

Usage
  claude-model-router [options]

Options
  -c, --config <path>        TOML config file (see default.toml)
      --port <n>             Listen port                    (default 8787)
      --host <addr>          Listen address                 (default 127.0.0.1)
      --upstream <url>       Upstream base URL       (default https://api.anthropic.com)
      --log <path>           JSONL decision log        (default ~/.claude-model-router/decisions.jsonl)
      --enable               Turn routing on. Without this the proxy observes only.
      --disable              Force observe-only, overriding the config file.
      --router <name>        none | head | jev — router for the main thread (default none)
      --subagent-router <n>  none | head | jev — router for subagents (default none)
      --subagent-tier <tier> Static tier for subagents, used as the router's fallback (default cheap)
      --main-tier <tier>     Tier for the main conversation (default: leave alone)
      --main-router          Let the router decide the main conversation
      --print-config         Print the resolved config and exit
  -h, --help                 Show this message

Environment
  TYPESAFE_API_KEY           Required when a router is "jev". Read from the real
                             environment, or from .env in the working directory,
                             or from ~/.claude-model-router/.env (in that order).
  TYPESAFE_MODEL             Jev model id         (default jev-1.13.0)

Usage with Claude Code
  # 1. start the proxy (in its own terminal)
  claude-model-router --config ~/.claude-model-router/config.toml

  # 2. point Claude Code at it
  ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude

Observe-only is the default: nothing is rewritten, but the full policy runs —
router calls included — and every decision is logged with what *would* have
been chosen. When the log shows the calls are worth it, restart with --enable.
`;

interface CliOptions {
  configPath: string | null;
  port: number | null;
  host: string | null;
  upstream: string | null;
  log: string | null;
  enable: boolean | null;
  router: RouterName | null;
  subagentRouter: RouterName | null;
  subagentTier: string | null;
  mainTier: string | null;
  mainRouter: boolean | null;
  printConfig: boolean;
  help: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    configPath: null,
    port: null,
    host: null,
    upstream: null,
    log: null,
    enable: null,
    router: null,
    subagentRouter: null,
    subagentTier: null,
    mainTier: null,
    mainRouter: null,
    printConfig: false,
    help: false,
  };

  const next = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "-c":
      case "--config":
        options.configPath = next(index, arg);
        index += 1;
        break;
      case "--port":
        options.port = Number.parseInt(next(index, arg), 10);
        index += 1;
        break;
      case "--host":
        options.host = next(index, arg);
        index += 1;
        break;
      case "--upstream":
        options.upstream = next(index, arg);
        index += 1;
        break;
      case "--log":
        options.log = next(index, arg);
        index += 1;
        break;
      case "--enable":
        options.enable = true;
        break;
      case "--disable":
        options.enable = false;
        break;
      case "--router":
      case "--subagent-router": {
        const value = next(index, arg);
        if (value !== "none" && value !== "head" && value !== "jev") {
          throw new Error(`${arg} must be none, head or jev (got ${value})`);
        }
        if (arg === "--router") options.router = value;
        else options.subagentRouter = value;
        index += 1;
        break;
      }
      case "--subagent-tier":
        options.subagentTier = next(index, arg);
        index += 1;
        break;
      case "--main-tier":
        options.mainTier = next(index, arg);
        index += 1;
        break;
      case "--main-router":
        options.mainRouter = true;
        break;
      case "--print-config":
        options.printConfig = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

function applyOverrides(config: Config, options: CliOptions): Config {
  if (options.port !== null) {
    if (!Number.isInteger(options.port)) throw new Error("--port must be an integer");
    config.port = options.port;
  }
  if (options.host !== null) config.host = options.host;
  if (options.upstream !== null) config.upstream = options.upstream;
  if (options.log !== null) config.log = options.log === "" ? null : expandHome(options.log);
  if (options.enable !== null) config.policy.enabled = options.enable;
  if (options.router !== null) config.policy.router = options.router;
  if (options.subagentRouter !== null) config.policy.subagentRouter = options.subagentRouter;
  if (options.subagentTier !== null) config.policy.subagentTier = options.subagentTier;
  if (options.mainTier !== null) config.policy.mainTier = options.mainTier;
  if (options.mainRouter !== null) config.policy.mainRouter = options.mainRouter;
  return config;
}

function banner(config: Config, router: string, envFile: string | null): string {
  const baseUrl = `http://${config.host}:${config.port}`;
  const mode = config.policy.enabled ? "ROUTING ENABLED" : "OBSERVE ONLY (no rewrite)";
  const subagentNote =
    config.policy.subagentRouter !== "none"
      ? `router '${config.policy.subagentRouter}' (fallback ${config.policy.subagentTier ?? "none"})`
      : (config.policy.subagentTier ?? "(none)");

  const lines = [
    "",
    `  claude-model-router  ${baseUrl}`,
    `  mode     ${mode}`,
    `  router   ${router}`,
    `  subagent -> ${subagentNote}`,
    `  upstream ${config.upstream}`,
    `  log      ${config.log ?? "(disabled)"}`,
    envFile === null ? null : `  env      ${envFile}`,
  ].filter((line): line is string => line !== null);

  if (config.policy.enabled) {
    lines.push(`  tiers    ${JSON.stringify(config.tiers)}`);
    lines.push(
      `  main     -> ${config.policy.mainTier ?? (config.policy.mainRouter ? "(router)" : "(leave alone)")}`,
    );
  } else {
    lines.push("  Nothing will be rewritten. Every decision is logged, including what");
    lines.push("  the router would choose. Add --enable when the log looks right.");
  }

  lines.push("", "  Point Claude Code at it:", `    ANTHROPIC_BASE_URL=${baseUrl} claude`, "");
  lines.push(
    "  First run: check /status inside Claude Code to confirm the base URL is",
    "  yours and that settings sources do not override it.",
    "",
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${String(error instanceof Error ? error.message : error)}\n`);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  let config: Config;
  let router;
  let envFile: string | null = null;
  try {
    // .env first, so a real exported variable can still override it.
    envFile = loadDotEnv([".env", expandHome("~/.claude-model-router/.env")]);
    config = applyOverrides(loadConfig({ configPath: options.configPath }), options);
    router = buildRouter({ config });
  } catch (error) {
    process.stderr.write(
      `claude-model-router: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (options.printConfig) {
    process.stdout.write(`${JSON.stringify(describeConfig(config), null, 2)}\n`);
    return;
  }

  const log = new DecisionLog(config.log);
  const policy = new Policy(config, router);
  const server = createServer({ config, policy, router, log });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  }).catch((error: unknown) => {
    process.stderr.write(
      `claude-model-router: cannot listen on ${config.host}:${config.port} — ` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });

  if (process.exitCode === 1) return;

  process.stdout.write(banner(config, router.name, envFile));

  const shutdown = (): void => {
    process.stdout.write("\n  shutting down\n");
    server.close(() => {
      void router.close().finally(() => process.exit(0));
    });
    // Do not hang on a stalled connection.
    setTimeout(() => process.exit(0), 2000).unref();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
