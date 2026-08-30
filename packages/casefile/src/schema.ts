import { z } from 'zod';
import { VERDICTS, deriveConfidence, type Verdict } from './verdict.ts';

/**
 * The case file — the agent's output contract.
 *
 * THE DESIGN RULE: observed evidence and inference never share a field.
 * Everything the sandbox actually produced lives under `evidence`; everything
 * the model concluded lives under `analysis`. A maintainer must be able to read
 * only `evidence` and reach their own verdict.
 *
 * This schema is validated on OUR side, at the boundary, after pulling the file
 * out of the sandbox. A malformed case file is a visible error, never a silent
 * half-rendered one.
 */

/** Captured output is truncated by capture.sh at this size, per stream. */
export const CAPTURE_LIMIT_BYTES = 64_000;

const Environment = z.object({
  os: z.string().min(1),
  runtime: z.string().min(1),
  packageVersions: z.record(z.string(), z.string()),
});

const ReproScript = z.object({
  path: z.string().min(1),
  contents: z.string(),
});

/** Produced by the sandbox. Never by the model. */
export const Evidence = z.object({
  environment: Environment,
  reproScript: ReproScript,
  command: z.string().min(1),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().int().nonnegative(),
  /** True when capture.sh hit CAPTURE_LIMIT_BYTES and cut the stream. */
  truncated: z.boolean().default(false),
});

/** The model's reading. Clearly marked as such, everywhere it surfaces. */
export const Analysis = z.object({
  summary: z.string().min(1),
  firstBadVersion: z.string().nullable(),
  bisectTrail: z.array(z.object({ version: z.string(), failed: z.boolean() })),
  duplicateOf: z.array(
    z.object({ number: z.number().int(), url: z.string(), why: z.string().min(1) }),
  ),
  /**
   * What the agent could NOT confirm. The honesty valve, and the field that
   * makes a human reach for Deny. Most agents present inference as fact; this
   * one has to enumerate its own gaps.
   */
  unverifiedClaims: z.array(z.string()),
  /** NEEDS_INFO only: one specific, answerable question. Never "please provide more detail". */
  openQuestion: z.string().nullable(),
  /** NOT_A_BUG only: the doc or test that defines the behaviour. */
  documentedBehaviourRef: z.string().nullable(),
});

const Issue = z.object({
  repo: z.string().min(1),
  number: z.number().int().positive(),
  url: z.string().url(),
});

const Revision = z.object({
  deniedReason: z.string().min(1),
  revisedAt: z.string(),
  /** The draft that was denied, kept so the Desk can diff it. */
  previousDraft: z.string(),
});

/** What the agent writes into the sandbox. Note: no `confidence` — see below. */
export const CaseFileInput = z.object({
  issue: Issue,
  verdict: z.enum(VERDICTS),
  evidence: Evidence.nullable(),
  analysis: Analysis,
  draftReply: z.string().min(1),
  labels: z.array(z.string()),
  revisions: z.array(Revision).default([]),
});

/** The validated, enriched case file the rest of the system passes around. */
export const CaseFile = CaseFileInput.extend({
  confidence: z.enum(['high', 'medium', 'low']),
});

export type CaseFileInput = z.infer<typeof CaseFileInput>;
export type CaseFile = z.infer<typeof CaseFile>;
export type Evidence = z.infer<typeof Evidence>;
export type Analysis = z.infer<typeof Analysis>;

/**
 * The honesty rules, executable.
 *
 * Each verdict may only be reached when the evidence that would justify it is
 * present. A verdict that cannot show its evidence fails validation — which
 * means it fails the build, and it never reaches a maintainer.
 */
export function verdictViolations(cf: CaseFileInput): string[] {
  const problems: string[] = [];
  const { verdict, evidence, analysis } = cf;

  switch (verdict satisfies Verdict) {
    case 'REPRODUCED':
      if (!evidence) {
        problems.push('REPRODUCED requires evidence; the failure must have been observed.');
      } else if (evidence.exitCode === 0) {
        problems.push(
          `REPRODUCED requires a non-zero exit code; the capture exited ${evidence.exitCode}, which is a success.`,
        );
      }
      break;

    case 'CANNOT_REPRODUCE':
      if (!evidence) {
        problems.push(
          'CANNOT_REPRODUCE requires evidence; "we could not reproduce it" is only credible with proof of what was run.',
        );
      } else if (evidence.exitCode !== 0) {
        problems.push(
          `CANNOT_REPRODUCE requires a zero exit code; the capture exited ${evidence.exitCode}, which means something did fail.`,
        );
      }
      break;

    case 'NEEDS_INFO':
      if (evidence) {
        problems.push('NEEDS_INFO requires no evidence; if something ran, judge what it showed.');
      }
      if (!analysis.openQuestion?.trim()) {
        problems.push('NEEDS_INFO requires exactly one specific, answerable question.');
      }
      break;

    case 'DUPLICATE':
      if (analysis.duplicateOf.length === 0) {
        problems.push('DUPLICATE requires at least one linked issue.');
      }
      if (analysis.duplicateOf.some((d) => !d.why.trim())) {
        problems.push('Every DUPLICATE link requires a stated reason the two issues match.');
      }
      break;

    case 'NOT_A_BUG':
      if (!analysis.documentedBehaviourRef?.trim()) {
        problems.push(
          'NOT_A_BUG requires a link to the documentation or test that defines the behaviour.',
        );
      }
      break;
  }

  return problems;
}

/** `CaseFileInput` plus the honesty rules. This is what the boundary uses. */
export const ValidatedCaseFileInput = CaseFileInput.superRefine((cf, ctx) => {
  for (const message of verdictViolations(cf)) {
    ctx.addIssue({ code: 'custom', message });
  }
});

/**
 * Parse and enrich a case file pulled out of the sandbox.
 *
 * Throws `ZodError` on anything malformed — deliberately loud. Callers render
 * the failure; they never render a half-empty case file.
 */
export function parseCaseFile(raw: unknown): CaseFile {
  const input = ValidatedCaseFileInput.parse(raw);
  return {
    ...input,
    confidence: deriveConfidence({
      verdict: input.verdict,
      hasEvidence: input.evidence !== null,
      exitCode: input.evidence?.exitCode ?? null,
      unverifiedClaimCount: input.analysis.unverifiedClaims.length,
      bisectSteps: input.analysis.bisectTrail.length,
    }),
  };
}
