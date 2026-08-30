import { describe, expect, it } from 'vitest';
import {
  DenyReasonRequiredError,
  EventIndex,
  UnresolvedToolCallError,
  buildApprovalResume,
  pausedApprovals,
  resolvePendingCalls,
} from '../src/gate.ts';
import {
  COMMENT_ARGUMENTS,
  SECOND_TOOL_CALL_ID,
  SOURCE_EVENT_ID,
  TOOL_CALL_ID,
  approvalRequired,
  completedState,
  modelMessage,
  pausedState,
} from './fixtures/paused-turn.ts';

/**
 * T2 — the gate regression test.
 *
 * This is a regression test for a *safety property*: that an irreversible action
 * stops for a human, that the human is shown the real payload, and that a denial
 * carries a reason. If this file goes red, the product's central claim is false.
 */

const indexed = () => {
  const index = new EventIndex();
  index.record(modelMessage);
  return index;
};

describe('T2 · detecting the pause', () => {
  it('recognises a turn that ended paused on approval', () => {
    const pending = pausedApprovals(pausedState);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.toolCalls).toHaveLength(2);
  });

  it('does not treat a completed turn as paused', () => {
    expect(pausedApprovals(completedState)).toEqual([]);
  });

  it('does not treat a still-running turn as paused', () => {
    expect(pausedApprovals({ status: 'running', startedAt: '2026-08-30T11:04:00.000Z' } as never)).toEqual(
      [],
    );
  });

  it('ignores non-approval required actions', () => {
    const authPause = {
      ...pausedState,
      requiredActions: [
        { type: 'mcp.auth_required', id: 'e1', createdAt: '', threadId: 'main', serverName: 'github' },
      ],
    } as never;
    expect(pausedApprovals(authPause)).toEqual([]);
  });
});

describe('T2 · the operator sees the real payload', () => {
  it('resolves each pending call back to its tool name and verbatim arguments', () => {
    const calls = resolvePendingCalls(approvalRequired, indexed());

    expect(calls).toHaveLength(2);
    expect(calls[0]!.toolName).toBe('add_issue_comment');
    expect(calls[0]!.serverName).toBe('github');

    // Verbatim, not a paraphrase. If the human approves a summary of the action,
    // they did not approve the action.
    expect(calls[0]!.argumentsJson).toBe(COMMENT_ARGUMENTS);
    expect(JSON.parse(calls[0]!.argumentsJson)).toMatchObject({ issue_number: 12 });
    expect(calls[0]!.argumentsPretty).toContain('"issue_number": 12');
  });

  it('refuses to present a call it cannot trace to a source message', () => {
    // An empty index is the realistic failure: a reconnect that replayed only
    // part of the stream. Better to fail loudly than to show a blank drawer.
    expect(() => resolvePendingCalls(approvalRequired, new EventIndex())).toThrow(
      UnresolvedToolCallError,
    );
  });

  it('indexes only model messages', () => {
    const index = new EventIndex();
    index.record(approvalRequired);
    expect(index.size).toBe(0);
    index.record(modelMessage);
    expect(index.get(SOURCE_EVENT_ID)).toBeDefined();
  });
});

describe('T2 · the resume is one approval per pending call', () => {
  it('emits exactly one user.tool_approval per call, with the right ids', () => {
    const resume = buildApprovalResume([
      { toolCallId: TOOL_CALL_ID, threadId: 'main', status: 'allow' },
      { toolCallId: SECOND_TOOL_CALL_ID, threadId: 'main', status: 'allow' },
    ]);

    expect(resume).toHaveLength(2);
    expect(resume.every((i) => i.type === 'user.tool_approval')).toBe(true);
    expect(resume.map((i) => (i as { toolCallId: string }).toolCallId)).toEqual([
      TOOL_CALL_ID,
      SECOND_TOOL_CALL_ID,
    ]);
    expect(resume.every((i) => (i as { threadId: string }).threadId === 'main')).toBe(true);
  });

  it('carries the reason on a denial', () => {
    const [item] = buildApprovalResume([
      {
        toolCallId: TOOL_CALL_ID,
        threadId: 'main',
        status: 'deny',
        reason: '  mention the workaround in comment #3  ',
      },
    ]);

    expect(item).toMatchObject({
      type: 'user.tool_approval',
      toolCallId: TOOL_CALL_ID,
      approval: { status: 'deny', reason: 'mention the workaround in comment #3' },
    });
  });

  it('rejects a denial with no reason — our rule, not the harness\'s', () => {
    // The harness marks `reason` optional. Requiring it is the difference
    // between a gate and a checkbox, so it is enforced here in code.
    expect(() =>
      buildApprovalResume([
        { toolCallId: TOOL_CALL_ID, threadId: 'main', status: 'deny', reason: '   ' },
      ]),
    ).toThrow(DenyReasonRequiredError);
  });

  it('refuses to resume with no decisions', () => {
    expect(() => buildApprovalResume([])).toThrow(/no decisions/);
  });

  it('refuses to decide the same call twice', () => {
    expect(() =>
      buildApprovalResume([
        { toolCallId: TOOL_CALL_ID, threadId: 'main', status: 'allow' },
        { toolCallId: TOOL_CALL_ID, threadId: 'main', status: 'deny', reason: 'changed my mind' },
      ]),
    ).toThrow(/Duplicate decision/);
  });

  it('never mixes approvals with a user message', () => {
    // The harness throws if a turn's input is not homogeneous. Assert the shape
    // we build can never be the cause.
    const resume = buildApprovalResume([{ toolCallId: TOOL_CALL_ID, threadId: 'main', status: 'allow' }]);
    expect(resume.some((i) => i.type === 'user.message')).toBe(false);
  });
});
