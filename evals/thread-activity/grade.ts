import type { OrchestrationV2ThreadActivityPhase } from "@t3tools/contracts";
import { sanitizeThreadActivityLabel } from "@t3tools/provider-core/server/textGenerationPrompts";

export const PHASE_PASS_RATE = 0.8;

export interface Answer {
  readonly phase: OrchestrationV2ThreadActivityPhase;
  readonly label: string;
}

export interface Expectation {
  readonly phase: OrchestrationV2ThreadActivityPhase | null;
  readonly keywords: ReadonlyArray<string>;
}

/** A label passes when it survives sanitizing unchanged and names an accepted keyword. */
export const labelProblem = (label: string, keywords: ReadonlyArray<string>) => {
  if (sanitizeThreadActivityLabel(label) !== label) return "label fails sanitizing";
  if (keywords.length === 0) return undefined;
  const lower = label.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword.toLowerCase()))
    ? undefined
    : "label has no accepted keyword";
};

/**
 * A case passes when the phase matches in at least 80% of its samples and every label is clean
 * and contains a keyword. A null phase accepts any phase, for cases that only need a valid answer.
 */
export const gradeCase = (expected: Expectation, answers: ReadonlyArray<Answer>) => {
  if (answers.length === 0) return { pass: false, reason: "no samples" };
  const hits = answers.filter(
    (answer) => expected.phase === null || answer.phase === expected.phase,
  ).length;
  const rate = hits / answers.length;
  if (rate < PHASE_PASS_RATE)
    return { pass: false, reason: `phase ${hits}/${answers.length} is ${expected.phase}` };
  for (const answer of answers) {
    const problem = labelProblem(answer.label, expected.keywords);
    if (problem) return { pass: false, reason: `${problem}: "${answer.label}"` };
  }
  return { pass: true, reason: `phase ${hits}/${answers.length}` };
};
