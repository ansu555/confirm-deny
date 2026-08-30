export const VERDICTS = [
  'REPRODUCED',
  'CANNOT_REPRODUCE',
  'NEEDS_INFO',
  'DUPLICATE',
  'NOT_A_BUG',
] as const;

export type Verdict = (typeof VERDICTS)[number];

export const VERDICT_GLYPH: Record<Verdict, string> = {
  REPRODUCED: '✓',
  CANNOT_REPRODUCE: '○',
  NEEDS_INFO: '?',
  DUPLICATE: '⧉',
  NOT_A_BUG: '—',
};

export const VERDICT_TOKEN: Record<Verdict, string> = {
  REPRODUCED: 'reproduced',
  CANNOT_REPRODUCE: 'cannot',
  NEEDS_INFO: 'needs-info',
  DUPLICATE: 'duplicate',
  NOT_A_BUG: 'not-a-bug',
};

export function deriveConfidence(input: {
  verdict: Verdict;
  hasEvidence: boolean;
  exitCode: number | null;
  unverifiedClaimCount: number;
  bisectSteps: number;
}): 'high' | 'medium' | 'low' {
  const { verdict, hasEvidence, unverifiedClaimCount, bisectSteps } = input;

  if (verdict === 'REPRODUCED' || verdict === 'CANNOT_REPRODUCE') {
    if (!hasEvidence) return 'low';
    if (unverifiedClaimCount === 0 && bisectSteps > 0) return 'high';
    if (unverifiedClaimCount <= 2) return 'medium';
    return 'low';
  }

  if (verdict === 'NEEDS_INFO') return unverifiedClaimCount <= 3 ? 'medium' : 'low';

  return unverifiedClaimCount === 0 ? 'medium' : 'low';
}
