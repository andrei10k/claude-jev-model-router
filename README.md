# claude-model-router

A local proxy that sits between [Claude Code](https://claude.com/claude-code) and the Anthropic API and uses [TypeSafe's Jev](https://docs.typesafe.ai/introduction) to route each subagent to the model the task actually needs. Your main conversation keeps whatever model you picked. Delegated work - a quick file lookup, a lint pass, or a flaky-test investigation - is classified when the subagent spawns and sent to Haiku, Sonnet or Opus accordingly. Nothing is hardcoded to a cheap model: the hard subagents keep their strong model, and only the easy ones get downgraded.

## Why

By default, every subagent Claude Code spawns inherits the main conversation's model. A background grep that just finds a filename runs on the same Opus you chose for hard architecture work. Multiply that by every session and the waste is real - and Anthropic gives you no way to say "subagents on Haiku, but only the simple ones". The closest native option is a static env var that pins *every* subagent to one model, with no judgement involved.

This proxy does the judgement. Each subagent request is classified by [TypeSafe's Jev](https://docs.typesafe.ai/introduction), a small decision model that answers "is this task mechanical or hard?" in under a second, and routed to the right tier: Haiku for lookups, Sonnet for real work, Opus for root-cause investigation. The main thread is never touched: it stays on your model for the whole session, so your prompt cache stays warm and your hardest thinking keeps its headroom.

## How the decision is made

There is no prompt asking an LLM "how hard is this?" and no hardcoded rules like "rename → Haiku". The decision is deterministic code over calibrated probabilities:

1. **Deterministic gate first.** The proxy looks at context it can trust outright: is this a subagent (`x-claude-code-agent-id` header), has this subagent already been assigned a tier, is the model pinned by the user (`never_reroute`, `/model` choices)? Only a first-time subagent reaches the classifier.
2. **Jev scores the delegation prompt.** The text Claude Code writes when spawning the subagent is sent as *state* to Jev alongside seven fixed yes/no questions - is this root-cause investigation? does it need an architecture decision? is it a mechanical edit with a named target? is the scope stated? Jev is not a text generator: it returns a calibrated probability (0–1) for each question in a single call. The prompt is never rewritten, and only the current turn is sent - not the transcript.
3. **Code combines the answers.** Each question has a hand-tuned weight (root-cause +2.0, mechanical −2.0, architecture +1.5, scope stated −1.0, …). The weighted sum is normalised to a score in [-1, 1] and mapped to a tier by fixed thresholds: score ≥ +0.35 → Opus tier, ≤ −0.30 → Haiku tier, in between → Sonnet. The arithmetic lives in code, not in the model, so the behaviour is inspectable and reproducible - same input, same routing, every time.
4. **Confidence gate.** The margin - how far the score landed past the nearest threshold - must clear `router_min_margin = 0.15` before the verdict is used. Below that, the request falls back to the static tier. The threshold exists because a close call is exactly when a classifier is most likely to be wrong, and the cost of an unnecessary upgrade is a few dollars while the cost of downgrading a hard task is hours of worse work. Asymmetric risk, biased toward safety.
5. **Hold, log, fail open.** The verdict is stuck to the subagent for its lifetime (one Jev call total), every decision is written to a JSONL log with its margin and timing, and any Jev failure - timeout, HTTP error, bad response - degrades to the static tier rather than failing the request.

The result: routing you can audit line by line. The log shows every verdict, its confidence, and what would have happened in observe mode - so you can watch the decisions for a day before letting them apply.

Two more constraints shaped the design:

- **One decision per subagent, then hold.** Every model has its own prompt cache; switching models mid-conversation re-reads the whole context uncached. So the proxy decides at the delegation boundary - the one place switching is free - and sticks to that tier for the subagent's lifetime.
- **The router can only help, never hurt.** If Jev is slow, erroring, or too unsure, the request falls back to a static tier you control. The proxy never breaks a session over a routing opinion.

## On the wire

```
Claude Code ──▶ claude-model-router ──▶ api.anthropic.com
                     │
                     └─▶ api.typesafe.ai (Jev, first request of each subagent only)
```

The proxy listens on `127.0.0.1:8787` and answers the endpoints Claude Code calls (`/v1/messages`, `/v1/messages/count_tokens`, `/v1/models`). It rewrites **only** the `model` field and relays everything else byte-for-byte - `system`, `tools`, `messages`, `cache_control`, all `anthropic-*` headers - then streams the response back unbuffered. Main-thread requests pass through without any classification at all.

## Quick start

```bash
git clone <this repo>
cd claude-model-router
npm install && npm run build
```

Put your TypeSafe API key in `.env` at the repo root (gitignored):

```
TYPESAFE_API_KEY=apikey_...
```

Run it in observe mode first. Nothing is rewritten, but every decision is logged with what *would* have happened:

```bash
node dist/index.js --config default.toml
```

Point Claude Code at it:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
```

Check `/status` inside Claude Code to confirm the base URL took. Work normally for a while - ideally a day - then read the log:

```bash
# what Jev decided for each subagent
jq -r 'select(.is_subagent==true) | [.decision_source, .tier, .reason] | @tsv' \
  ~/.claude-model-router/decisions.jsonl

# how much of your traffic is even subagent work?
jq -r 'select(.kind=="messages") | .decision_source' \
  ~/.claude-model-router/decisions.jsonl | sort | uniq -c
```

If the decisions look right, turn routing on:

```bash
node dist/index.js --config default.toml --enable
```

That's the whole rollout. `--enable` applies exactly the policy you just watched; nothing else changes. On the next subagent, `/tasks` in Claude Code will still show the old model - Claude Code doesn't know the proxy exists. Check `model_confirmed` in the log instead; it reports the model the API actually served.

## Configuration

`default.toml` is fully commented. The keys that matter:

| Key | Default | What it does |
|---|---|---|
| `policy.enabled` | `false` | Observe-only vs. actually rewriting. `--enable` overrides. |
| `policy.subagent_router` | `"jev"` | Jev decides subagent tiers. `"none"` = static tier. `"head"` = local regex cues, no network. |
| `policy.subagent_tier` | `"cheap"` | Fallback tier when Jev is unsure or unavailable. |
| `policy.main_router` | `false` | Leave off. The main thread is deliberately out of the router's reach. |
| `policy.router_timeout_ms` | `3000` | Jev budget per call. On timeout: fall back to `subagent_tier`. |
| `policy.router_min_margin` | `0.15` | Verdicts closer than this count as "unsure". |
| `tiers.*` | haiku / sonnet / opus | Tier name → concrete model ID. Versioned IDs, not aliases. |

## What it doesn't do

- It doesn't read your files or send anything anywhere except your configured upstream and the TypeSafe classification call.
- It doesn't modify prompts, tools, or system content - only `model`.
- It doesn't touch credentials. Your existing login passes straight through.
- It doesn't route the main conversation, ever, unless you set `main_tier` or `main_router` yourself.

## A strict gateway

The proxy enforces the parts of Anthropic's [gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol) that are easy to get quietly wrong, and the test suite pins each one:

- only `model` is rewritten; mangled `cache_control` makes the whole conversation bill uncached, with no error to tell you
- `anthropic-beta` is forwarded as an open list - new releases add beta values, and an allowlist breaks them
- responses stream unbuffered with backpressure propagated (Claude Code aborts after 300s of silence)
- error bodies are forwarded unmodified, because retry logic matches on their wording
- the relay uses `undici.request` rather than `fetch`, which decompresses the body while still claiming `content-encoding: gzip` - a corruption trap

80 tests cover this, including byte-for-byte stream relay and header-rebuild assertions.

## Cost model

One Jev call per subagent, about 400 tokens. That's the entire overhead. Everything else just changes which Claude model the tokens you were already spending bill against. Haiku runs roughly 4–5× cheaper than Sonnet, so any session that delegates exploration work pays for the classifier many times over. If your sessions barely spawn subagents, the observe log will tell you that before you spend anything.

## Limits worth knowing

- The classifier sees only the delegation prompt Claude Code writes when spawning the subagent. It can't see your codebase, so difficulty estimates are prompt-level. Prompts that name files ("fix the bug in `parser.ts`") read as simpler than they are; the margin gate catches ambiguous cases and falls back.
- Sticky state is in-memory and resets when the proxy restarts.
- Single user, localhost only.
