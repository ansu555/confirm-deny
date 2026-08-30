import { describe, expect, it } from 'vitest';
import {
  rejectionReason,
  ApprovalOnRejectedCaseFileError,
  TriageRunner,
  type CaseFileRejection,
} from '../src/runner.ts';
import { CaseFileInvalidError, MissingCaseFileError } from '../src/artifacts.ts';

describe('rejectionReason', () => {
  it('tells the agent the gate never opened, so it does not assume a human refused', () => {
    const reason = rejectionReason(
      new CaseFileInvalidError('/work/case/casefile.json', ['verdict: Invalid option'], '{}'),
    );
    expect(reason).toContain('no human has seen this reply yet');
    expect(reason).toContain('/work/case/casefile.json');
  });

  it('lists every schema problem so the agent can fix all of them at once', () => {
    const reason = rejectionReason(
      new CaseFileInvalidError(
        '/work/case/casefile.json',
        ['verdict: Invalid option', 'analysis.summary: Required'],
        '{}',
      ),
    );
    expect(reason).toContain('- verdict: Invalid option');
    expect(reason).toContain('- analysis.summary: Required');
  });

  it('names the conventional path when no case file could be read at all', () => {
    const reason = rejectionReason(new MissingCaseFileError('turn_1'));
    expect(reason).toContain('/work/case/casefile.json');
    expect(reason).toContain('sandbox_artifacts');
  });
});

describe('approval after a rejected case file', () => {
  const runner = () =>
    new TriageRunner({ baseUrl: 'http://localhost:1', token: '', model: 'x/y' }) as unknown as {
      rejection: CaseFileRejection | null;
      resolveGate: TriageRunner['resolveGate'];
    };

  const allow = [{ toolCallId: 'call_1', threadId: 'main', status: 'allow' as const }];
  const deny = [
    { toolCallId: 'call_1', threadId: 'main', status: 'deny' as const, reason: 'fix the verdict' },
  ];

  it('refuses an allow while a rejection stands', async () => {
    const r = runner();
    r.rejection = new MissingCaseFileError('turn_1');
    await expect(r.resolveGate('s1', allow, () => {})).rejects.toBeInstanceOf(
      ApprovalOnRejectedCaseFileError,
    );
  });

  it('still lets a denial through, so the agent can be told what to fix', async () => {
    const r = runner();
    r.rejection = new MissingCaseFileError('turn_1');
    await expect(r.resolveGate('s1', deny, () => {})).rejects.not.toBeInstanceOf(
      ApprovalOnRejectedCaseFileError,
    );
  });

  it('carries the rejection so the operator learns why the approval was refused', () => {
    const rejection = new CaseFileInvalidError('/work/case/casefile.json', ['verdict: bad'], '{}');
    const error = new ApprovalOnRejectedCaseFileError(rejection);
    expect(error.rejection).toBe(rejection);
    expect(error.message).toContain('verdict: bad');
  });
});
