import { describe, expect, it } from 'vitest';
import { rejectionReason } from '../src/runner.ts';
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
