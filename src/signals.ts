/**
 * The judgement registry: what the router is allowed to have an opinion about.
 *
 * `head` answers these from local regex cues, no network. Jev answers the same
 * instructions as typed questions and returns calibrated probabilities. Same
 * signals, same weights, same thresholds — only the source of the number
 * changes. That is the whole seam.
 *
 * Signals are written for Jev's known behaviour: literal, one judgement per
 * question, no arithmetic, state kept small (it suffers context rot).
 */

export interface Signal {
  id: string;
  instructions: string;
  /** Positive pushes toward a stronger model, negative toward a weaker one. */
  weight: number;
  /** Cues used by the local `head` stand-in. Never sent to Jev. */
  positiveCues: readonly RegExp[];
}

/**
 * No `g` flag on any of these: a global regex carries `lastIndex` between
 * `.test()` calls, so a shared pattern silently alternates between matching
 * and not matching. There is a test guarding this.
 */
function re(...patterns: string[]): readonly RegExp[] {
  return patterns.map((pattern) => new RegExp(pattern, "i"));
}

export const SIGNALS: readonly Signal[] = [
  {
    id: "is_root_cause_investigation",
    instructions:
      "Does `turn.text` ask to find the cause of a problem that is not yet identified, " +
      "rather than apply a fix whose nature is already known?",
    weight: 2.0,
    positiveCues: re(
      "\\bwhy\\b",
      "\\broot cause\\b",
      "\\bdiagnose\\b",
      "\\bdebug\\b",
      "\\bflake\\b|\\bflaky\\b",
      "\\bintermittent\\b",
      "\\bnot sure why\\b",
      "\\binvestigate\\b",
      "\\btrack down\\b",
    ),
  },
  {
    id: "needs_architecture_judgment",
    instructions:
      "Does `turn.text` ask for a design, interface, structure, or architecture " +
      "decision rather than a specific change?",
    weight: 1.5,
    positiveCues: re(
      "\\barchitecture\\b",
      "\\bdesign\\b",
      "\\brestructure\\b",
      "\\bhow should (i|we)\\b",
      "\\btrade-?offs?\\b",
      "\\bwhich approach\\b",
      "\\bpattern\\b",
      "\\brefactor\\b|\\bre-?architect\\b",
    ),
  },
  {
    id: "spans_multiple_concerns",
    instructions:
      "Does `turn.text` bundle several independent changes or questions together?",
    weight: 1.0,
    positiveCues: re("\\balso\\b.*\\band\\b", "\\bplus\\b", "\\bas well as\\b", "\\d+\\.\\s", "\\n\\s*[-*]\\s"),
  },
  {
    id: "scope_is_stated",
    instructions:
      "Does `turn.text` name the specific file, module, symbol, or line that must change?",
    weight: -1.0,
    positiveCues: re(
      "[A-Za-z0-9_/\\.-]+\\.[a-z]{1,4}\\b",
      "\\b[A-Za-z_][A-Za-z0-9_]*\\(\\)",
      "\\bline \\d+\\b",
      "\\bfunction \\w+\\b",
      "\\bclass \\w+\\b",
    ),
  },
  {
    id: "is_question_about_existing_code",
    instructions:
      "Does `turn.text` ask what existing code does or where something lives, " +
      "with a named target?",
    weight: -1.0,
    positiveCues: re(
      "^\\s*(what does|where is|where are|which file|show me|list)\\b",
      "\\bwhat is the\\b.*\\bfor\\b",
    ),
  },
  {
    id: "is_mechanical",
    instructions:
      "Is `turn.text` a mechanical edit, rename, format, or lookup whose target " +
      "is explicitly named?",
    weight: -2.0,
    positiveCues: re(
      "\\brename\\b",
      "\\btypo\\b",
      "\\bformat\\b",
      "\\blint\\b",
      "\\bbump\\b",
      "\\bupdate the (version|changelog)\\b",
      "\\badd a (comment|log line)\\b",
      "\\bfix the wording\\b",
    ),
  },
];

export const SIGNAL_IDS: readonly string[] = SIGNALS.map((signal) => signal.id);

export const TOTAL_WEIGHT: number = SIGNALS.reduce(
  (total, signal) => total + Math.abs(signal.weight),
  0,
);

/** Thresholds on the normalised score: >= PREMIUM_AT is opus-tier, <= CHEAP_AT is haiku-tier. */
export const PREMIUM_AT = 0.35;
export const CHEAP_AT = -0.3;

export interface Combination {
  tier: string;
  /** How far past the nearest threshold the decision landed. */
  margin: number;
  normalised: number;
}

/**
 * Weighted sum over P(yes), normalised to [-1, 1] so the thresholds are
 * readable fractions. The maths lives in code, never in the model — Jev
 * cannot count, and its own docs say to keep the arithmetic on our side.
 * The margin is distance past the nearest threshold: close call, defer.
 */
export function combine(probabilities: Readonly<Record<string, number>>): Combination {
  if (TOTAL_WEIGHT === 0) return { tier: "mid", margin: 0, normalised: 0 };

  let score = 0;
  for (const signal of SIGNALS) {
    const p = probabilities[signal.id];
    if (p === undefined) continue;
    score += (p - 0.5) * 2.0 * signal.weight;
  }

  const normalised = score / TOTAL_WEIGHT;

  if (normalised >= PREMIUM_AT) {
    return { tier: "premium", margin: normalised - PREMIUM_AT, normalised };
  }
  if (normalised <= CHEAP_AT) {
    return { tier: "cheap", margin: CHEAP_AT - normalised, normalised };
  }
  return {
    tier: "mid",
    margin: Math.min(PREMIUM_AT - normalised, normalised - CHEAP_AT),
    normalised,
  };
}

/**
 * Cue matching for `router = "head"`. Binary and transparent on purpose — it
 * is the baseline Jev has to beat to earn a network call.
 */
export function headProbabilities(text: string): Record<string, number> {
  const probabilities: Record<string, number> = {};
  for (const signal of SIGNALS) {
    if (signal.positiveCues.length === 0) continue;
    const hit = signal.positiveCues.some((cue) => cue.test(text));
    probabilities[signal.id] = hit ? 1.0 : 0.0;
  }
  return probabilities;
}

/** The same signals in Jev's request shape. */
export function jevQuestions(): Record<string, { type: "noul"; instructions: string }> {
  const questions: Record<string, { type: "noul"; instructions: string }> = {};
  for (const signal of SIGNALS) {
    questions[signal.id] = { type: "noul", instructions: signal.instructions };
  }
  return questions;
}
