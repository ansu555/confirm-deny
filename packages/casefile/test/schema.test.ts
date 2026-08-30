import { describe, expect, it } from 'vitest';
import {
  CAPTURE_LIMIT_BYTES,
  deriveConfidence,
  parseCaseFile,
  verdictViolations,
  type CaseFileInput,
} from '../src/index.ts';

/**
 * T1 — the honesty rules, executable.
 * T4 — the negative test at the Zod boundary.
 *
 * These are the tests that make "a verdict that cannot show its evidence fails
 * the build" a literal statement rather than a slogan.
 */

const evidence = (over: Partial<CaseFileInput['evidence'] & object> = {}) => ({
  environment: { os: 'linux', runtime: 'python 3.12.4', packageVersions: { colwrap: '2.4.0' } },
  reproScript: { path: '/work/case/repro.py', contents: 'import colwrap\n' },
  command: 'python /work/case/repro.py',
  exitCode: 1,
  stdout: '',
  stderr: 'AssertionError',
  durationMs: 412,
  truncated: false,
  ...over,
});

const base = (over: Partial<CaseFileInput> = {}): CaseFileInput => ({
  issue: { repo: 'ansu555/colwrap', number: 12, url: 'https://github.com/ansu555/colwrap/issues/12' },
  verdict: 'REPRODUCED',
  evidence: evidence(),
  analysis: {
    summary: 'Words exactly `width` characters long are split.',
    firstBadVersion: null,
    bisectTrail: [],
    duplicateOf: [],
    unverifiedClaims: [],
    openQuestion: null,
    documentedBehaviourRef: null,
  },
  draftReply: 'Confirmed on 2.4.0.',
  labels: ['bug'],
  revisions: [],
  ...over,
});

describe('T1 · verdict / evidence invariants', () => {
  it('REPRODUCED requires evidence with a non-zero exit code', () => {
    expect(verdictViolations(base())).toEqual([]);
    expect(verdictViolations(base({ evidence: null }))).toHaveLength(1);
    expect(verdictViolations(base({ evidence: evidence({ exitCode: 0 }) }))[0]).toMatch(
      /non-zero exit code/,
    );
  });

  it('CANNOT_REPRODUCE requires evidence AND a zero exit code', () => {
    const ok = base({ verdict: 'CANNOT_REPRODUCE', evidence: evidence({ exitCode: 0 }) });
    expect(verdictViolations(ok)).toEqual([]);

    // The failure mode this rule exists to stop: claiming "cannot reproduce"
    // while sitting on a capture that plainly failed.
    const contradiction = base({ verdict: 'CANNOT_REPRODUCE', evidence: evidence({ exitCode: 1 }) });
    expect(verdictViolations(contradiction)[0]).toMatch(/zero exit code/);

    expect(verdictViolations(base({ verdict: 'CANNOT_REPRODUCE', evidence: null }))).toHaveLength(1);
  });

  it('NEEDS_INFO requires no evidence and exactly one specific question', () => {
    const ok = base({
      verdict: 'NEEDS_INFO',
      evidence: null,
      analysis: { ...base().analysis, openQuestion: 'Which version of colwrap were you on?' },
    });
    expect(verdictViolations(ok)).toEqual([]);

    const noQuestion = base({ verdict: 'NEEDS_INFO', evidence: null });
    expect(verdictViolations(noQuestion)[0]).toMatch(/specific, answerable question/);

    const ranAnyway = base({
      verdict: 'NEEDS_INFO',
      analysis: { ...base().analysis, openQuestion: 'Which version?' },
    });
    expect(verdictViolations(ranAnyway)[0]).toMatch(/requires no evidence/);
  });

  it('DUPLICATE requires a linked issue with a stated reason', () => {
    const noLink = base({ verdict: 'DUPLICATE' });
    expect(verdictViolations(noLink)[0]).toMatch(/at least one linked issue/);

    const noWhy = base({
      verdict: 'DUPLICATE',
      analysis: {
        ...base().analysis,
        duplicateOf: [{ number: 9, url: 'https://example.test/9', why: '   ' }],
      },
    });
    expect(verdictViolations(noWhy).some((p) => /stated reason/.test(p))).toBe(true);
  });

  it('NOT_A_BUG requires a citation for the documented behaviour', () => {
    expect(verdictViolations(base({ verdict: 'NOT_A_BUG' }))[0]).toMatch(/documentation or test/);

    const cited = base({
      verdict: 'NOT_A_BUG',
      analysis: { ...base().analysis, documentedBehaviourRef: 'README.md#wrapping-rules' },
    });
    expect(verdictViolations(cited)).toEqual([]);
  });
});

describe('confidence is derived, never model-reported', () => {
  it('is not accepted as an input field', () => {
    const smuggled = { ...base(), confidence: 'high' } as unknown;
    // Extra keys are stripped, not trusted — the model cannot set its own score.
    expect(parseCaseFile(smuggled).confidence).toBe('medium');
  });

  it('falls as unverified claims accumulate', () => {
    const of = (n: number) =>
      deriveConfidence({
        verdict: 'REPRODUCED',
        hasEvidence: true,
        exitCode: 1,
        unverifiedClaimCount: n,
        bisectSteps: 0,
      });
    expect(of(0)).toBe('medium');
    expect(of(2)).toBe('medium');
    expect(of(3)).toBe('low');
  });

  it('rises only when a bisect backs the verdict and nothing is unverified', () => {
    expect(
      deriveConfidence({
        verdict: 'REPRODUCED',
        hasEvidence: true,
        exitCode: 1,
        unverifiedClaimCount: 0,
        bisectSteps: 4,
      }),
    ).toBe('high');
  });
});

describe('T4 · the boundary fails loudly', () => {
  it('rejects a malformed case file rather than half-rendering it', () => {
    expect(() => parseCaseFile({ issue: { repo: 'a/b' } })).toThrow();
    expect(() => parseCaseFile('not even an object')).toThrow();
    expect(() => parseCaseFile(null)).toThrow();
  });

  it('rejects a self-contradicting case file that is otherwise well-formed', () => {
    // This is the case a shape-only schema would wave through: every field is
    // the right type, and the document still lies.
    const wellFormedLie = base({ verdict: 'CANNOT_REPRODUCE', evidence: evidence({ exitCode: 2 }) });
    expect(() => parseCaseFile(wellFormedLie)).toThrow(/zero exit code/);
  });

  it('rejects an unknown verdict', () => {
    expect(() => parseCaseFile(base({ verdict: 'PROBABLY' as never }))).toThrow();
  });

  it('accepts a truncated capture and keeps the flag', () => {
    const big = base({
      evidence: evidence({ stderr: 'x'.repeat(CAPTURE_LIMIT_BYTES), truncated: true }),
    });
    expect(parseCaseFile(big).evidence?.truncated).toBe(true);
  });
});
