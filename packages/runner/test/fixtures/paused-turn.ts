import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';

/**
 * A real paused turn, as the server emits it: the model asks to post a comment,
 * the gate fires, and the turn reaches `done` with no output.
 *
 * Kept as a fixture so the gate's behaviour can be pinned without a live server,
 * a Daytona key, or a GitHub token.
 */

export const SOURCE_EVENT_ID = '01JQZ8MODELMESSAGE000000001';
export const TOOL_CALL_ID = 'call_9f2b1c';
export const SECOND_TOOL_CALL_ID = 'call_9f2b1d';

export const COMMENT_ARGUMENTS = JSON.stringify({
  owner: 'ansu555',
  repo: 'colwrap',
  issue_number: 12,
  body: 'Reproduced on 2.4.0.\n\n```\npython3 /work/case/repro.py\n→ exit 1\nAssertionError\n```',
});

export const modelMessage: TrueForgeApi.ModelMessageEvent = {
  type: 'model.message',
  id: SOURCE_EVENT_ID,
  createdAt: '2026-08-30T11:04:12.000Z',
  threadId: 'main',
  content: 'I have a verdict and a draft reply. Requesting approval to post it.',
  toolCalls: [
    {
      id: TOOL_CALL_ID,
      type: 'function',
      function: { name: 'add_issue_comment', arguments: COMMENT_ARGUMENTS },
      toolInfo: { type: 'mcp', name: 'add_issue_comment', serverId: 'srv_1', serverName: 'github' },
    },
    {
      id: SECOND_TOOL_CALL_ID,
      type: 'function',
      function: {
        name: 'update_issue_labels',
        arguments: JSON.stringify({ owner: 'ansu555', repo: 'colwrap', issue_number: 12, labels: ['bug'] }),
      },
      toolInfo: { type: 'mcp', name: 'update_issue_labels', serverId: 'srv_1', serverName: 'github' },
    },
  ],
};

export const approvalRequired: TrueForgeApi.ToolApprovalRequiredEvent = {
  type: 'tool.approval_required',
  id: '01JQZ8APPROVALREQUIRED00001',
  createdAt: '2026-08-30T11:04:12.400Z',
  threadId: 'main',
  toolCalls: [
    { id: TOOL_CALL_ID, sourceEventId: SOURCE_EVENT_ID },
    { id: SECOND_TOOL_CALL_ID, sourceEventId: SOURCE_EVENT_ID },
  ],
};

/** The turn ended paused: terminal state, no output, one required action. */
export const pausedState: TrueForgeApi.TurnState = {
  status: 'done',
  completedAt: '2026-08-30T11:04:12.500Z',
  output: null,
  requiredActions: [approvalRequired],
};

/** The same turn, completed normally. */
export const completedState: TrueForgeApi.TurnState = {
  status: 'done',
  completedAt: '2026-08-30T11:06:01.000Z',
  output: { ...modelMessage, toolCalls: [], content: 'Done — comment posted.' },
  requiredActions: [],
};
