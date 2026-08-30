import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';

/**
 * The approval gate.
 *
 * A gated tool call ends the turn. It does not suspend it — the turn reaches a
 * terminal `done` state with `output: null` and a non-empty `requiredActions`.
 * Resuming is therefore a NEW turn carrying `user.tool_approval` items, one per
 * pending call.
 *
 * Everything here is a pure function over events, which is what lets the gate be
 * tested without a live server. See test/gate.test.ts — a red test there means
 * a safety property has stopped holding.
 */

/** Raised when a deny arrives without a reason. See `PendingDecision`. */
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

/** Raised when a pending call cannot be traced back to the message that made it. */
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

/**
 * A pending call, resolved to the exact thing the agent wants to do.
 *
 * `argumentsJson` is the verbatim string the model emitted. A paraphrase here
 * would undermine the whole safety claim: if the human approves a summary, they
 * did not approve the action.
 */
export interface PendingCall {
  toolCallId: string;
  threadId: string;
  toolName: string;
  serverName: string | null;
  argumentsJson: string;
  /** Pretty-printed for display; falls back to the raw string if it isn't JSON. */
  argumentsPretty: string;
}

export type PendingDecision =
  | { toolCallId: string; threadId: string; status: 'allow' }
  | { toolCallId: string; threadId: string; status: 'deny'; reason: string };

/**
 * An id-keyed index of `model.message` events.
 *
 * Each pending approval carries only a `sourceEventId`; the tool name and its
 * arguments live on the message that requested the call. Without this index the
 * drawer can only say "a tool wants to run", which is exactly the rubber stamp
 * this project exists to avoid.
 */
export class EventIndex {
  private readonly messages = new Map<string, TrueForgeApi.ModelMessageEvent>();

  record(event: { type: string; id?: string }): void {
    if (event.type === 'model.message' && event.id) {
      this.messages.set(event.id, event as TrueForgeApi.ModelMessageEvent);
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
    // Not JSON. Show it exactly as it came rather than inventing structure.
    return raw;
  }
}

/** Resolve one `tool.approval_required` event into fully-described pending calls. */
export function resolvePendingCalls(
  event: TrueForgeApi.ToolApprovalRequiredEvent,
  index: EventIndex,
): PendingCall[] {
  return event.toolCalls.map((ref) => {
    const source = index.get(ref.sourceEventId);
    const call = source?.toolCalls?.find((c) => c.id === ref.id);
    if (!call) throw new UnresolvedToolCallError(ref.id, ref.sourceEventId);

    const raw = call.function.arguments ?? '';
    return {
      toolCallId: ref.id,
      threadId: event.threadId,
      toolName: call.function.name,
      serverName: call.toolInfo?.type === 'mcp' ? call.toolInfo.serverName : null,
      argumentsJson: raw,
      argumentsPretty: prettyArguments(raw),
    };
  });
}

/**
 * Did this turn end paused on an approval?
 *
 * `output === null` is the signal that the turn ended paused rather than
 * completing — a turn that produced a final message is done, even if it also
 * carries other required actions.
 */
export function pausedApprovals(
  state: TrueForgeApi.TurnState,
): TrueForgeApi.ToolApprovalRequiredEvent[] {
  if (state.status !== 'done') return [];
  if (state.output !== null) return [];
  return state.requiredActions.filter(
    (a): a is TrueForgeApi.ToolApprovalRequiredEvent => a.type === 'tool.approval_required',
  );
}

/**
 * Build the resume input.
 *
 * One `user.tool_approval` per pending call — never one decision batched across
 * several, because each call is a separate thing the human is agreeing to.
 * A turn's input must also be homogeneous: these items can never travel
 * alongside a `user.message`.
 */
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
