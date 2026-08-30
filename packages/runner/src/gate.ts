import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';

export type IndexableEvent =
  | { type?: string; id?: string }
  | { event?: { type?: string; id?: string } };

export class DenyReasonRequiredError extends Error {
  readonly toolCallId: string;

  constructor(toolCallId: string) {
    super(
      `Deny requires a reason (tool call ${toolCallId}). The harness treats reason as ` +
        `optional; we do not. A gate that accepts a bare "no" teaches the agent nothing ` +
        `and teaches the operator to click.`,
    );
    this.name = 'DenyReasonRequiredError';
    this.toolCallId = toolCallId;
  }
}

export class UnresolvedToolCallError extends Error {
  readonly toolCallId: string;
  readonly sourceEventId: string;

  constructor(toolCallId: string, sourceEventId: string) {
    super(
      `Cannot resolve tool call ${toolCallId} — no model.message with id ${sourceEventId} in the ` +
        `event index. Refusing to present an approval whose arguments we cannot show verbatim.`,
    );
    this.name = 'UnresolvedToolCallError';
    this.toolCallId = toolCallId;
    this.sourceEventId = sourceEventId;
  }
}

export interface PendingCall {
  toolCallId: string;
  threadId: string;
  toolName: string;
  serverName: string | null;
  argumentsJson: string;
  argumentsPretty: string;
}

export type PendingDecision =
  | { toolCallId: string; threadId: string; status: 'allow' }
  | { toolCallId: string; threadId: string; status: 'deny'; reason: string };

export class EventIndex {
  private readonly messages = new Map<string, TrueForgeApi.ModelMessageEvent>();

  record(event: IndexableEvent): void {
    const inner = 'event' in event && event.event ? event.event : event;
    const { type, id } = inner as { type?: string; id?: string };
    if (type === 'model.message' && id) {
      this.messages.set(id, inner as TrueForgeApi.ModelMessageEvent);
    }
  }

  get(id: string): TrueForgeApi.ModelMessageEvent | undefined {
    return this.messages.get(id);
  }

  get size(): number {
    return this.messages.size;
  }
}

function prettyArguments(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function unwrapMcpEnvelope(
  name: string,
  raw: string,
): { toolName: string; serverName: string | null; pretty: string } {
  if (name !== 'call_tool') return { toolName: name, serverName: null, pretty: prettyArguments(raw) };
  try {
    const outer = JSON.parse(raw) as {
      tool_name?: string;
      mcp_server?: string;
      input?: unknown;
    };
    if (!outer?.tool_name) throw new Error('not an envelope');
    return {
      toolName: outer.tool_name,
      serverName: outer.mcp_server ?? null,
      pretty: JSON.stringify(outer.input ?? {}, null, 2),
    };
  } catch {
    return { toolName: name, serverName: null, pretty: prettyArguments(raw) };
  }
}

export function resolvePendingCalls(
  event: TrueForgeApi.ToolApprovalRequiredEvent,
  index: EventIndex,
): PendingCall[] {
  return event.toolCalls.map((ref) => {
    const source = index.get(ref.sourceEventId);
    const call = source?.toolCalls?.find((c) => c.id === ref.id);
    if (!call) throw new UnresolvedToolCallError(ref.id, ref.sourceEventId);

    const raw = call.function.arguments ?? '';
    const unwrapped = unwrapMcpEnvelope(call.function.name, raw);
    return {
      toolCallId: ref.id,
      threadId: event.threadId,
      toolName: unwrapped.toolName,
      serverName:
        unwrapped.serverName ??
        (call.toolInfo?.type === 'mcp' ? call.toolInfo.serverName : null),
      argumentsJson: raw,
      argumentsPretty: unwrapped.pretty,
    };
  });
}

export function pausedApprovals(
  state: TrueForgeApi.TurnState,
): TrueForgeApi.ToolApprovalRequiredEvent[] {
  if (state.status !== 'done') return [];
  if (state.output !== null) return [];
  return state.requiredActions.filter(
    (a): a is TrueForgeApi.ToolApprovalRequiredEvent => a.type === 'tool.approval_required',
  );
}

export function buildApprovalResume(decisions: readonly PendingDecision[]): TrueForgeApi.TurnInputItem[] {
  if (decisions.length === 0) {
    throw new Error('Refusing to resume with no decisions; that would silently re-run the turn.');
  }

  const seen = new Set<string>();
  return decisions.map((d) => {
    if (seen.has(d.toolCallId)) {
      throw new Error(`Duplicate decision for tool call ${d.toolCallId}.`);
    }
    seen.add(d.toolCallId);

    if (d.status === 'deny' && !d.reason.trim()) {
      throw new DenyReasonRequiredError(d.toolCallId);
    }

    return {
      type: 'user.tool_approval',
      threadId: d.threadId,
      toolCallId: d.toolCallId,
      approval:
        d.status === 'allow' ? { status: 'allow' } : { status: 'deny', reason: d.reason.trim() },
    } satisfies TrueForgeApi.UserToolApprovalEvent;
  });
}
