/**
 * The verdict vocabulary and the honesty rules that bind each verdict to the
 * evidence it is allowed to claim.
 *
 * A non-reproduction is a *successful* outcome, not a failure. The rules below
 * exist so that a verdict can never assert more than the sandbox actually
 * showed.
 */

export const VERDICTS = [
  'REPRODUCED',
  'CANNOT_REPRODUCE',
  'NEEDS_INFO',
  'DUPLICATE',
  'NOT_A_BUG',
] as const;

export type Verdict = (typeof VERDICTS)[number];

/** Display glyph. Never signal a verdict with colour alone — a judge may be
 *  colour-blind, or watching on a bad projector. */
export const VERDICT_GLYPH: Record<Verdict, string> = {
  REPRODUCED: '✓',
  CANNOT_REPRODUCE: '○',
  NEEDS_INFO: '?',
  DUPLICATE: '⧉',
  NOT_A_BUG: '—',
};

/** Palette token per verdict, matching the Desk design system. */
export const VERDICT_TOKEN: Record<Verdict, string> = {
  REPRODUCED: 'reproduced',
  CANNOT_REPRODUCE: 'cannot',
  NEEDS_INFO: 'needs-info',
  DUPLICATE: 'duplicate',
  NOT_A_BUG: 'not-a-bug',
};

/**
 * Confidence is *derived*, never model-reported.
 *
 * A model asked to rate its own confidence produces noise; it has no calibrated
 * access to its own uncertainty. What we can measure is how much of the case
 * file is backed by something the sandbox actually emitted, and how much the
 * agent admitted it could not check.
 */
export function deriveConfidence(input: {
  verdict: Verdict;
  hasEvidence: boolean;
  exitCode: number | null;
  unverifiedClaimCount: number;
  bisectSteps: number;
}): 'high' | 'medium' | 'low' {
  const { verdict, hasEvidence, unverifiedClaimCount, bisectSteps } = input;

  // A verdict that rests on execution is only as strong as its execution.
  if (verdict === 'REPRODUCED' || verdict === 'CANNOT_REPRODUCE') {
    if (!hasEvidence) return 'low';
    if (unverifiedClaimCount === 0 && bisectSteps > 0) return 'high';
    if (unverifiedClaimCount <= 2) return 'medium';
    return 'low';
  }

  // NEEDS_INFO is a statement about the report, not the software. If the agent
  // formed one specific question, that is a confident reading of the report.
  if (verdict === 'NEEDS_INFO') return unverifiedClaimCount <= 3 ? 'medium' : 'low';

  // DUPLICATE and NOT_A_BUG rest on a citation, which is checkable by a human.
  return unverifiedClaimCount === 0 ? 'medium' : 'low';
}
