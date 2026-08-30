import { describe, expect, it } from 'vitest';
import {
  UngatedWritePathError,
  assertGated,
  auditPolicy,
  isDestructive,
  isWrite,
  type McpToolEntry,
} from '../src/policy.js';

/**
 * The annotations below are GitHub's own committed tool definitions, read from
 * `github/github-mcp-server` `pkg/github/__toolsnaps__/`. If the server changes
 * them, this test is where we find out — not the demo.
 */
const githubTools: McpToolEntry[] = [
  { name: 'get_issue', annotations: { readOnlyHint: true } },
  { name: 'list_issues', annotations: { readOnlyHint: true } },
  { name: 'add_issue_comment', annotations: { readOnlyHint: false } },
  { name: 'create_or_update_file', annotations: { readOnlyHint: false } },
  { name: 'issue_write', annotations: { readOnlyHint: false } },
  { name: 'update_issue_labels', annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'label_write', annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: 'delete_repository', annotations: { readOnlyHint: false, destructiveHint: true } },
];

describe('selector logic mirrors the harness', () => {
  it('treats @write and @destructive as disjoint', () => {
    const labelWrite = githubTools.find((t) => t.name === 'label_write')!;
    expect(isDestructive(labelWrite)).toBe(true);
    // The correction that matters: @write EXCLUDES destructive tools.
    expect(isWrite(labelWrite)).toBe(false);
  });

  it('counts an absent destructiveHint as non-destructive, so @write covers it', () => {
    const comment = githubTools.find((t) => t.name === 'add_issue_comment')!;
    expect(isWrite(comment)).toBe(true);
    expect(isDestructive(comment)).toBe(false);
  });
});

describe('the policy audit catches the silent failures', () => {
  it('accepts the shipped policy — both tags plus literals', () => {
    const report = auditPolicy(
      githubTools,
      ['@write', '@destructive', 'add_issue_comment', 'update_issue_labels'],
      ['add_issue_comment'],
    );
    expect(report.ungatedWrites).toEqual([]);
    expect(report.deadLiterals).toEqual([]);
    expect(report.missingCritical).toEqual([]);
    expect(report.gated).toContain('label_write');
    expect(() => assertGated(report)).not.toThrow();
  });

  it('catches dropping @destructive — the mistake an earlier draft nearly shipped', () => {
    const report = auditPolicy(githubTools, ['@write', 'add_issue_comment']);
    // label_write and delete_repository fall straight through.
    expect(report.ungatedWrites).toEqual(['label_write', 'delete_repository']);
    expect(() => assertGated(report)).toThrow(UngatedWritePathError);
  });

  it('catches a literal-only policy built from stale names', () => {
    // The original Agent Spec: three of these four do not exist on current main,
    // and supplying any list discards the working default.
    const report = auditPolicy(
      githubTools,
      ['add_issue_comment', 'update_issue', 'add_labels_to_issue', 'remove_label_from_issue'],
      ['add_issue_comment'],
    );

    expect(report.deadLiterals).toEqual([
      'update_issue',
      'add_labels_to_issue',
      'remove_label_from_issue',
    ]);
    // Exactly one gated tool out of every write path on the server.
    expect(report.gated).toEqual(['add_issue_comment']);
    expect(report.ungatedWrites.length).toBeGreaterThan(0);
    expect(() => assertGated(report)).toThrow(UngatedWritePathError);
  });

  it('flags a critical tool that the policy fails to gate', () => {
    const report = auditPolicy(githubTools, ['@destructive'], ['add_issue_comment']);
    expect(report.missingCritical).toEqual(['add_issue_comment']);
  });

  it('does not report a critical tool the server never exposed as an ungated one', () => {
    // Naming drift is a dead literal, not a gating hole — different fix.
    const report = auditPolicy(githubTools, ['@write', '@destructive'], ['update_issue']);
    expect(report.missingCritical).toEqual([]);
  });

  it('@all gates everything — noisy, but the safe fallback', () => {
    const report = auditPolicy(githubTools, ['@all'], ['add_issue_comment']);
    expect(report.ungatedWrites).toEqual([]);
    expect(report.gated).toHaveLength(githubTools.length);
  });
});
