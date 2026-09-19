import { describe, expect, it } from "vitest";

import {
  CHEAP_AT,
  PREMIUM_AT,
  SIGNALS,
  combine,
  headProbabilities,
  jevQuestions,
} from "../src/signals.js";

/** Probabilities with only the named signals true. */
function only(...ids: string[]): Record<string, number> {
  const probabilities: Record<string, number> = {};
  for (const signal of SIGNALS) probabilities[signal.id] = ids.includes(signal.id) ? 1 : 0;
  return probabilities;
}

/**
 * Unanimous probabilities.
 *
 * `complex` fires every complexity signal and leaves the simplicity signals
 * at zero; `simple` is the mirror image. Keying off the sign of the weight is
 * what matters — setting every signal to 1 just makes the weights cancel.
 */
function unanimous(lean: "complex" | "simple"): Record<string, number> {
  const probabilities: Record<string, number> = {};
  for (const signal of SIGNALS) {
    const pushesUp = signal.weight > 0;
    const agree = lean === "complex" ? pushesUp : !pushesUp;
    probabilities[signal.id] = agree ? 1 : 0;
  }
  return probabilities;
}

const ALL_COMPLEX = unanimous("complex");
const ALL_SIMPLE = unanimous("simple");

describe("combine", () => {
  it("returns mid when nothing points either way", () => {
    const probabilities = Object.fromEntries(SIGNALS.map((s) => [s.id, 0.5]));
    expect(combine(probabilities).tier).toBe("mid");
  });

  it("returns premium when every complexity signal fires and none oppose", () => {
    const result = combine(ALL_COMPLEX);
    expect(result.tier).toBe("premium");
    expect(result.normalised).toBeCloseTo(1.0, 6);
    expect(result.margin).toBeCloseTo(1 - PREMIUM_AT, 6);
  });

  it("returns cheap when every simplicity signal fires and none oppose", () => {
    const result = combine(ALL_SIMPLE);
    expect(result.tier).toBe("cheap");
    expect(result.normalised).toBeCloseTo(-1.0, 6);
    expect(result.margin).toBeCloseTo(CHEAP_AT + 1, 6);
  });

  it("is symmetric: leaning complex and leaning simple are mirror images", () => {
    expect(combine(ALL_COMPLEX).normalised).toBeCloseTo(-combine(ALL_SIMPLE).normalised, 6);
  });

  it("routes a purely mechanical ask to the cheap tier", () => {
    const result = combine(only("is_mechanical"));
    expect(result.tier).toBe("cheap");
    expect(result.normalised).toBeLessThan(CHEAP_AT);
  });

  it("routes a root-cause question to the premium tier", () => {
    const result = combine(only("is_root_cause_investigation"));
    expect(result.tier).toBe("premium");
    expect(result.normalised).toBeGreaterThan(PREMIUM_AT);
  });

  it("reports a small margin for a genuinely balanced prompt", () => {
    // Root cause (+2) against mechanical (-2) is a dead heat.
    const result = combine(only("is_root_cause_investigation", "is_mechanical"));
    expect(result.tier).toBe("mid");
    expect(result.margin).toBeLessThan(0.25);
  });

  it("ignores signals it does not know about", () => {
    const result = combine({ not_a_signal: 1.0 });
    expect(result.tier).toBe("mid");
  });
});

describe("headProbabilities", () => {
  it("gives a probability for every signal", () => {
    const probabilities = headProbabilities("hello");
    expect(Object.keys(probabilities).sort()).toEqual(
      SIGNALS.map((signal) => signal.id).sort(),
    );
  });

  it("is stable across repeated calls", () => {
    // A /g flag on a shared regex would alternate between matching and not matching.
    const text = "rename the widget in foo.ts";
    const first = headProbabilities(text);
    const second = headProbabilities(text);
    const third = headProbabilities(text);

    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("recognises a mechanical ask with a stated target", () => {
    const probabilities = headProbabilities("rename the widget in foo.ts");
    expect(probabilities["is_mechanical"]).toBe(1);
    expect(probabilities["scope_is_stated"]).toBe(1);
    expect(combine(probabilities).tier).toBe("cheap");
  });

  it("recognises an open-ended diagnostic question", () => {
    const probabilities = headProbabilities("why is this test flaky?");
    expect(probabilities["is_root_cause_investigation"]).toBe(1);
    expect(combine(probabilities).tier).toBe("premium");
  });

  it("does not fire on unrelated text", () => {
    const probabilities = headProbabilities("good morning");
    expect(Object.values(probabilities).every((value) => value === 0)).toBe(true);
  });
});

describe("jevQuestions", () => {
  it("emits one noul question per signal, keyed by signal id", () => {
    const questions = jevQuestions();
    expect(Object.keys(questions).sort()).toEqual(
      SIGNALS.map((signal) => signal.id).sort(),
    );
    for (const question of Object.values(questions)) {
      expect(question.type).toBe("noul");
      expect(question.instructions.length).toBeGreaterThan(20);
    }
  });

  it("states each condition explicitly, since Jev reads literally", () => {
    const questions = jevQuestions();
    for (const question of Object.values(questions)) {
      expect(question.instructions).not.toMatch(/\betc\b|and so on/i);
    }
  });
});
