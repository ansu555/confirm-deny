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

/**
 * What `EventIndex.record` will take: a session event, or the envelope the
 * events endpoint wraps one in.
 */
export type IndexableEvent =
  | { type?: string; id?: string }
  | { event?: { type?: string; id?: string } };

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

  /**
   * Accepts either a bare event or the `{ turn_id, event }` envelope the
   * events endpoint returns. The live stream yields the former and the
   * durable listing the latter; unwrapping here keeps every caller from
   * having to know which one it holds.
   */
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
    // Not JSON. Show it exactly as it came rather than inventing structure.
    return raw;
  }
}

/**
 * TrueForge dispatches MCP tools through a generic `call_tool` envelope:
 *
 *   { tool_name: "add_issue_comment", mcp_server: "github", input: { … } }
 *
 * The harness resolves the inner name for approval purposes — that is why
 * `@write` pauses it at all — but the outer call still reads `call_tool` with
 * no server. Presenting that to a human would show a meaningless tool name and
 * bury the real payload one level down, so unwrap it for display.
 *
 * `argumentsJson` keeps the envelope exactly as it arrived; only the presented
 * view is unwrapped. Verified live 2026-08-30 against `add_issue_comment`.
 */
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
    // Unrecognised shape — show it as it came rather than inventing structure.
    return { toolName: name, serverName: null, pretty: prettyArguments(raw) };
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
