# claude-jev-model-router

A local proxy that sits between [Claude Code](https://claude.com/claude-code) and the Anthropic API and uses [TypeSafe's Jev](https://docs.typesafe.ai/introduction) to route each subagent to the model the task actually needs. Your main conversation keeps whatever model you picked. Delegated work - a quick file lookup, a lint pass, or a flaky-test investigation - is classified when the subagent spawns and sent to Haiku, Sonnet or Opus accordingly. Nothing is hardcoded to a cheap model: the hard subagents keep their strong model, and only the easy ones get downgraded.

## Why

By default, every subagent Claude Code spawns inherits the main conversation's model. A background grep that just finds a filename runs on the same Opus you chose for hard architecture work. Multiply that by every session and the waste is real - and Anthropic gives you no way to say "subagents on Haiku, but only the simple ones". The closest native option is a static env var that pins *every* subagent to one model, with no judgement involved.

This proxy does the judgement. Each subagent request is classified by [TypeSafe's Jev](https://docs.typesafe.ai/introduction), a small decision model that answers "is this task mechanical or hard?" in under a second, and routed to the right tier: Haiku for lookups, Sonnet for real work, Opus for root-cause investigation. The main thread is never touched: it stays on your model for the whole session, so your prompt cache stays warm and your hardest thinking keeps its headroom.

## How the decision is made

There is no prompt asking an LLM "how hard is this?" and no hardcoded rules like "rename → Haiku". The decision is deterministic code over calibrated probabilities:

1. **Deterministic gate first.** The proxy looks at context it can trust outright: is this a subagent (`x-claude-code-agent-id` header), has this subagent already been assigned a tier, is the model pinned by the user (`never_reroute`, `/model` choices)? Only a first-time subagent reaches the classifier.
2. **Tool-set gates.** The request's tool list says what the subagent can do to your repo, and that cannot be gamed by how the task is worded:
   - **Read-only** tool set (no Write/Edit, no Bash) → capped at the cheap tier without consulting Jev. Such an agent physically cannot modify anything, so no prompt can make the work harder than a lookup.
   - **Exec** tool set (Bash but no Write/Edit — Explore agents, which use Bash for grep) → Jev decides with the normal confidence bar; router failure falls back to cheap. Bash without edit tools is search, not repo mutation.
   - **Mutation-capable** tool set (Write/Edit present) → Jev still decides, but a downgrade to cheap needs extra confidence (see step 5), and a router failure falls back to Sonnet rather than Haiku.
3. **Jev scores the delegation prompt.** The text Claude Code writes when spawning the subagent is sent as *state* to Jev alongside six fixed yes/no questions - is this root-cause investigation? does it need an architecture decision? is it a mechanical edit with a named target? is the scope stated? Jev is not a text generator: it returns a calibrated probability (0–1) for each question in a single call. The prompt is never rewritten, and only the current turn is sent - not the transcript.
4. **Code combines the answers.** Each question has a hand-tuned weight (root-cause +2.0, mechanical −2.0, architecture +1.5, scope stated −1.0, …). The weighted sum is normalised to a score in [-1, 1] and mapped to a tier by fixed thresholds: score ≥ +0.35 → Opus tier, ≤ −0.30 → Haiku tier, in between → Sonnet. The arithmetic lives in code, not in the model, so the behaviour is inspectable and reproducible - same input, same routing, every time.
5. **Confidence gate - asymmetric for mutation-capable agents.** The margin - how far the score landed past the nearest threshold - must clear `router_min_margin = 0.15` before the verdict is used. For a mutation-capable agent, a downgrade to cheap additionally needs `router_min_margin_mutation = 0.3`: a wrong cheap verdict on an agent that can edit your repo is the most expensive mistake this proxy can make, while a codebase-wide rename (score ≈ −0.7, margin ≈ 0.4) still clears it easily. Upgrades to mid/premium always keep the normal bar. Below the applicable margin, the request falls back to the static tier.
6. **Hold, log, fail open.** The verdict is stuck to the subagent for its lifetime (one Jev call total), every decision is written to a JSONL log with its margin, tool class and timing, and any Jev failure - timeout, HTTP error, bad response - degrades to the static tier rather than failing the request.

The result: routing you can audit line by line. The log shows every verdict, its confidence, the tool-set class, and what would have happened in observe mode - so you can watch the decisions for a day before letting them apply.

Two more constraints shaped the design:

- **One decision per subagent, then hold.** Every model has its own prompt cache; switching models mid-conversation re-reads the whole context uncached. So the proxy decides at the delegation boundary - the one place switching is free - and sticks to that tier for the subagent's lifetime.
- **The router can only help, never hurt.** If Jev is slow, erroring, or too unsure, the request falls back to a static tier you control. The proxy never breaks a session over a routing opinion.

## On the wire

```
Claude Code ──▶ claude-jev-model-router ──▶ api.anthropic.com
                     │
                     └─▶ api.typesafe.ai (Jev, first request of each subagent only)
```

The proxy listens on `127.0.0.1:8787` and answers the endpoints Claude Code calls (`/v1/messages`, `/v1/messages/count_tokens`, `/v1/models`). It rewrites **only** the `model` field and relays everything else byte-for-byte - `system`, `tools`, `messages`, `cache_control`, all `anthropic-*` headers - then streams the response back unbuffered. Main-thread requests pass through without any classification at all.

## Quick start

Install from npm (Node 20+):

```bash
npm install -g claude-jev-model-router
```

Put your TypeSafe API key in `.env` in the directory where you'll run the proxy (or `~/.claude-model-router/.env`, or export `TYPESAFE_API_KEY` in your shell):

```
TYPESAFE_API_KEY=apikey_...
```

Run it in observe mode first. Nothing is rewritten, but every decision is logged with what *would* have happened:

```bash
claude-jev-model-router
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
claude-jev-model-router --enable
```

That's the whole rollout. `--enable` applies exactly the policy you just watched; nothing else changes. On the next subagent, `/tasks` in Claude Code will still show the old model - Claude Code doesn't know the proxy exists. Check `model_confirmed` in the log instead; it reports the model the API actually served.

Prefer to run from source? Clone the repo, `npm install && npm run build`, then `node dist/index.js` — same flags.

## Configuration

`default.toml` is fully commented. The keys that matter:

| Key | Default | What it does |
|---|---|---|
| `policy.enabled` | `false` | Observe-only vs. actually rewriting. `--enable` overrides. |
| `policy.subagent_router` | `"jev"` | Jev decides subagent tiers. `"none"` = static tier. `"head"` = local regex cues, no network. |
| `policy.subagent_tier` | `"cheap"` | Fallback tier for read-only/exec subagents. Mutation-capable ones fall back to `mid`. |
| `policy.main_router` | `false` | Leave off. The main thread is deliberately out of the router's reach. |
| `policy.router_timeout_ms` | `3000` | Jev budget per call. On timeout: fall back to the tier above. |
| `policy.router_min_margin` | `0.15` | Verdicts closer than this count as "unsure". |
| `policy.router_min_margin_mutation` | `0.3` | Wider bar for downgrading a mutation-capable subagent to cheap. |
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

### Measuring your savings

```bash
claude-jev-model-router savings
```

Reads the decision log and prints what was saved over the last 1, 7 and 30 days — per route (`sonnet-5 -> haiku-4-5`) and in total. It's cache-aware (cached input at 10%, cache writes at 125%) and prices each rewrite both ways: what the tokens actually cost at the rerouted model vs. what they would have cost at the originally-requested model. Downgrades to a more expensive model count as negative savings, so the number is honest.

Prices default to Anthropic's published list and can be overridden with a JSON file (`claude-jev-model-router savings --pricing my-prices.json`) — useful for max-tier subscription accounting or if Anthropic's prices move.

## Limits worth knowing

- The classifier sees only the delegation prompt Claude Code writes when spawning the subagent. It can't see your codebase, so difficulty estimates are prompt-level. Prompts that name files ("fix the bug in `parser.ts`") read as simpler than they are; the margin gate catches ambiguous cases and falls back.
- Sticky state is in-memory and resets when the proxy restarts.
- Single user, localhost only.
