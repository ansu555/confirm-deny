import { TrueForge } from '@truefoundry/trueforge-sdk';
import type { CaseFile } from '@confirm-deny/casefile';
import { buildAgentSpec, triageMessage, CRITICAL_WRITE_TOOLS, APPROVAL_POLICY } from './agent-spec.js';
import {
  EventIndex,
  buildApprovalResume,
  pausedApprovals,
  resolvePendingCalls,
  type PendingCall,
  type PendingDecision,
} from './gate.js';
import { auditPolicy, assertGated, type McpToolEntry, type PolicyReport } from './policy.js';
import { findCaseFilePath, parseSandboxArtifacts, validateCaseFile } from './artifacts.js';
import type { TriageEvent, TriageEventSink } from './events.js';

/**
 * Session lifecycle and stream fan-out.
 *
 * The TrueForge key lives here and only here. The browser talks to our route
 * handlers, never to the harness — which is the same boundary that keeps model
 * and MCP credentials out of the sandbox, applied one layer further out.
 */

export interface RunnerOptions {
  /** TrueForge API token. Stays server-side; it never reaches the browser. */
  token: string;
  /** e.g. http://localhost:3000 for `npx @truefoundry/trueforge`. */
  baseUrl: string;
  model: string;
  githubServerName?: string;
}

export interface TurnOutcome {
  turnId: string;
  /** Non-empty when the turn ended paused on the gate. */
  pending: PendingCall[];
  /** Present once the agent has announced and written a valid case file. */
  casefile: CaseFile | null;
  finalText: string | null;
}

export class TriageRunner {
  private readonly client: TrueForge;
  private readonly index = new EventIndex();

  constructor(private readonly options: RunnerOptions) {
    this.client = new TrueForge({ baseUrl: options.baseUrl, token: options.token });
  }

  /**
   * Preflight: resolve the approval policy against the LIVE tool list.
   *
   * Literal names in `requireApprovalForTools` are never validated by the
   * harness, and the list replaces the default rather than extending it. So a
   * stale name gates nothing and says nothing. This turns that silent failure
   * into a refusal to start.
   */
  async auditApprovalPolicy(): Promise<PolicyReport> {
    const serverName = this.options.githubServerName ?? 'github';
    const response = await this.client.mcpServers.listTools(serverName);
    const tools = response.data as unknown as McpToolEntry[];

    const report = auditPolicy(tools, APPROVAL_POLICY, CRITICAL_WRITE_TOOLS);
    assertGated(report);
    return report;
  }

  /** Open a session with the agent spec inline — no pre-registration needed. */
  async startSession(): Promise<string> {
    const session = await this.client.sessions.create({
      agent: {
        spec: buildAgentSpec({
          model: this.options.model,
          ...(this.options.githubServerName
            ? { githubServerName: this.options.githubServerName }
            : {}),
        }),
      },
    });
    return session.data.id;
  }

  /** Begin triage of one issue. Returns when the turn ends — done or paused. */
  async triage(sessionId: string, issueUrl: string, emit: TriageEventSink): Promise<TurnOutcome> {
    await emit({ type: 'session.started', sessionId, issueUrl });
    return this.runTurn(sessionId, { input: [triageMessage(issueUrl)] }, emit);
  }

  /**
   * Resume a paused turn with the operator's decisions.
   *
   * This is a NEW turn. The paused one is over — it reached a terminal state
   * with no output. Nothing is "unpaused".
   */
  async resolveGate(
    sessionId: string,
    decisions: readonly PendingDecision[],
    emit: TriageEventSink,
  ): Promise<TurnOutcome> {
    for (const d of decisions) {
      await emit({
        type: 'gate.resolved',
        toolCallId: d.toolCallId,
        status: d.status,
        ...(d.status === 'deny' ? { reason: d.reason } : {}),
      });
    }
    // Throws if a deny arrived without a reason — enforced before the wire.
    return this.runTurn(sessionId, { input: buildApprovalResume(decisions) }, emit);
  }

  /**
   * Re-attach to a turn already in flight.
   *
   * A reload must never re-run the triage: that would burn a sandbox, re-clone
   * the repo, and — worse — could re-open a gate the operator already answered.
   */
  async reattach(sessionId: string, turnId: string, emit: TriageEventSink): Promise<TurnOutcome> {
    const stream = await this.client.sessions.subscribeToTurn(sessionId, turnId);
    return this.consume(sessionId, turnId, stream, emit);
  }

  private async runTurn(
    sessionId: string,
    request: Parameters<TrueForge['sessions']['createTurnStream']>[1],
    emit: TriageEventSink,
  ): Promise<TurnOutcome> {
    const stream = await this.client.sessions.createTurnStream(sessionId, request);
    return this.consume(sessionId, null, stream, emit);
  }

  private async consume(
    sessionId: string,
    knownTurnId: string | null,
    stream: AsyncIterable<unknown>,
    emit: TriageEventSink,
  ): Promise<TurnOutcome> {
    let turnId = knownTurnId ?? '';
    let pending: PendingCall[] = [];
    let finalText: string | null = null;
    let casefile: CaseFile | null = null;
    let casefilePath: string | null = null;

    for await (const raw of stream) {
      const event = raw as { type: string } & Record<string, unknown>;
      this.index.record(event as never);

      switch (event.type) {
        case 'turn.created': {
          turnId = String(event['id'] ?? turnId);
          await emit({ type: 'turn.started', turnId });
          break;
        }

        case 'sandbox.created': {
          await emit({ type: 'sandbox.created', sandboxId: String(event['sandboxId']) });
          break;
        }

        case 'thread.created': {
          await emit({
            type: 'thread.started',
            threadId: String(event['threadId']),
            title: String(event['title'] ?? 'subagent'),
          });
          break;
        }

        case 'model.message': {
          const text = textOf(event['content']);
          const threadId = String(event['threadId'] ?? 'main');

          if (text) {
            finalText = text;
            await emit({ type: 'agent.said', threadId, text });

            for (const artifact of parseSandboxArtifacts(text)) {
              await emit({ type: 'artifact.available', ...artifact });
            }
          }

          for (const call of (event['toolCalls'] as ToolCallish[] | undefined) ?? []) {
            await emit({
              type: 'tool.called',
              threadId,
              toolName: call.function.name,
              server: call.toolInfo?.type === 'mcp' ? call.toolInfo.serverName : null,
              args: call.function.arguments ?? '',
            });
          }
          break;
        }

        case 'tool.response': {
          await emit({
            type: 'tool.returned',
            threadId: String(event['threadId'] ?? 'main'),
            toolCallId: String(event['toolCallId']),
            preview: String(event['content'] ?? '').slice(0, 2000),
          });
          break;
        }

        case 'tool.approval_required': {
          // Resolve now, while the stream that produced the source message is
          // still being read — the operator must see the real arguments.
          pending = resolvePendingCalls(event as never, this.index);
          await emit({ type: 'gate.opened', turnId, calls: pending });
          break;
        }

        case 'turn.done': {
          const state = event['state'] as Parameters<typeof pausedApprovals>[0];
          const paused = pausedApprovals(state).length > 0;

          if (!paused && finalText) {
            const path = findCaseFilePath(parseSandboxArtifacts(finalText));
            if (path) {
              casefilePath = path;
              casefile = await this.pullCaseFile(sessionId, turnId, path);
              await emit({ type: 'casefile.ready', casefile, path });
            }
          }

          await emit({ type: 'turn.finished', turnId, paused });
          break;
        }
      }
    }

    return { turnId, pending, casefile, finalText: casefilePath ? finalText : finalText };
  }

  /** Pull an artifact out of the sandbox and validate it at the boundary. */
  async pullCaseFile(sessionId: string, turnId: string, path: string): Promise<CaseFile> {
    const raw = await this.downloadText(sessionId, turnId, path);
    return validateCaseFile(path, raw);
  }

  async downloadText(sessionId: string, turnId: string, path: string): Promise<string> {
    const file = await this.client.sessions.downloadSandboxFile(sessionId, turnId, { path });
    return new TextDecoder().decode(await file.arrayBuffer());
  }
}

interface ToolCallish {
  id: string;
  function: { name: string; arguments?: string };
  toolInfo?: { type: string; serverName: string };
}

/** Message content is either a string or content parts; flatten to text. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : '',
    )
    .join('');
}

export type { TriageEvent, TriageEventSink };
