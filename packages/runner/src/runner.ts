import { TrueForge } from '@truefoundry/trueforge-sdk';
import type { CaseFile } from '@confirm-deny/casefile';
import { buildAgentSpec, triageMessage, CRITICAL_WRITE_TOOLS, APPROVAL_POLICY } from './agent-spec.ts';
import {
  EventIndex,
  UnresolvedToolCallError,
  buildApprovalResume,
  pausedApprovals,
  resolvePendingCalls,
  type PendingCall,
  type PendingDecision,
} from './gate.ts';
import {
  auditPolicy,
  assertGated,
  assertRemoteSandbox,
  REMOTE_SANDBOX_PREFIX,
  type McpToolEntry,
  type PolicyReport,
} from './policy.ts';
import {
  findCaseFilePath,
  parseSandboxArtifacts,
  validateCaseFile,
  CaseFileInvalidError,
  MissingCaseFileError,
  DEFAULT_CASE_FILE_PATH,
} from './artifacts.ts';
import type { TriageEvent, TriageEventSink } from './events.ts';

export interface RunnerOptions {
  token: string;
  baseUrl: string;
  model: string;
  githubServerName?: string;
  sandboxPrefix?: string;
}

export interface TurnOutcome {
  turnId: string;
  pending: PendingCall[];
  casefile: CaseFile | null;
  casefileError: CaseFileRejection | null;
  finalText: string | null;
}

export type CaseFileRejection = CaseFileInvalidError | MissingCaseFileError;

export function rejectionReason(error: CaseFileRejection): string {
  if (error instanceof MissingCaseFileError) {
    return (
      `Your case file could not be read at ${DEFAULT_CASE_FILE_PATH}. Write it there, ` +
      `announce it in a fenced sandbox_artifacts block, and call add_issue_comment again.`
    );
  }
  return (
    `Your case file was rejected by the schema, so no human has seen this reply yet. ` +
    `Fix ${error.path} and call add_issue_comment again.\n` +
    error.problems.map((p) => `- ${p}`).join('\n')
  );
}

export class TriageRunner {
  private readonly client: TrueForge;
  private readonly index = new EventIndex();
  private casefilePath: string | null = null;

  private readonly options: RunnerOptions;

  constructor(options: RunnerOptions) {
    this.options = options;
    this.client = new TrueForge({ baseUrl: options.baseUrl, token: options.token });
  }

  async auditApprovalPolicy(): Promise<PolicyReport> {
    const serverName = this.options.githubServerName ?? 'github';
    const response = await this.client.mcpServers.listTools(serverName);
    const tools = response.data as unknown as McpToolEntry[];

    const report = auditPolicy(tools, APPROVAL_POLICY, CRITICAL_WRITE_TOOLS);
    assertGated(report);
    return report;
  }

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

  async triage(sessionId: string, issueUrl: string, emit: TriageEventSink): Promise<TurnOutcome> {
    await emit({ type: 'session.started', sessionId, issueUrl });
    return this.runTurn(sessionId, { input: [triageMessage(issueUrl)] }, emit);
  }

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
    return this.runTurn(sessionId, { input: buildApprovalResume(decisions) }, emit);
  }

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
    let casefileError: CaseFileRejection | null = null;

    for await (const raw of stream) {
      const event = raw as { type: string } & Record<string, unknown>;
      this.index.record(event as never);

      const carried = event['turnId'] ?? event['turn_id'];
      if (typeof carried === 'string' && carried) turnId = carried;

      switch (event.type) {
        case 'turn.created': {
          if (!turnId) turnId = String(event['id'] ?? '');
          await emit({ type: 'turn.started', turnId });
          break;
        }

        case 'sandbox.created': {
          const sandboxId = String(event['sandboxId']);
          assertRemoteSandbox(sandboxId, this.options.sandboxPrefix ?? REMOTE_SANDBOX_PREFIX);
          await emit({ type: 'sandbox.created', sandboxId });
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

            const artifacts = parseSandboxArtifacts(text);
            for (const artifact of artifacts) {
              await emit({ type: 'artifact.available', ...artifact });
            }
            this.casefilePath = findCaseFilePath(artifacts) ?? this.casefilePath;
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
          try {
            pending = resolvePendingCalls(event as never, this.index);
          } catch (error) {
            if (!(error instanceof UnresolvedToolCallError)) throw error;
            await this.backfillIndex(sessionId, turnId);
            pending = resolvePendingCalls(event as never, this.index);
          }
          await emit({ type: 'gate.opened', turnId, calls: pending });
          break;
        }

        case 'turn.done': {
          const state = event['state'] as Parameters<typeof pausedApprovals>[0];
          const paused = pausedApprovals(state).length > 0;

          if (state.status !== 'done') {
            await emit({
              type: 'failed',
              message:
                `Turn ended as "${state.status}" rather than done, with no error. The two ` +
                `causes are the iteration limit (raise CONFIRM_DENY_ITERATION_LIMIT) and the ` +
                `model's declared context_length. Compare total_input_tokens from ` +
                `GET /sessions/${sessionId}/turns against the context_length you registered ` +
                `for this model; a context declared smaller than the model really has will ` +
                `cancel a long triage that would otherwise finish.`,
            });
          }

          const path = this.casefilePath ?? (paused ? DEFAULT_CASE_FILE_PATH : null);

          if (path) {
            try {
              casefile = await this.pullCaseFile(sessionId, turnId, path);
              await emit({ type: 'casefile.ready', casefile, path });
            } catch (error) {
              if (!paused) throw error;
              casefileError =
                error instanceof CaseFileInvalidError
                  ? error
                  : new MissingCaseFileError(turnId);
              await emit({ type: 'casefile.rejected', reason: rejectionReason(casefileError) });
            }
          }

          await emit({ type: 'turn.finished', turnId, paused });
          break;
        }
      }
    }

    return { turnId, pending, casefile, casefileError, finalText };
  }

  private async backfillIndex(sessionId: string, turnId: string): Promise<void> {
    for (const id of await this.turnCandidates(sessionId, turnId)) {
      try {
        const page = await this.client.sessions.listTurnEvents(sessionId, id);
        for await (const event of page) this.index.record(event as never);
        return;
      } catch {
      }
    }
  }

  private async turnCandidates(sessionId: string, turnId: string): Promise<string[]> {
    const candidates = turnId ? [turnId] : [];
    try {
      const turns = await this.client.sessions.listTurns(sessionId);
      for await (const turn of turns) {
        const id = (turn as { id?: string }).id;
        if (id && !candidates.includes(id)) candidates.push(id);
      }
    } catch {
    }
    return candidates;
  }

  async pullCaseFile(sessionId: string, turnId: string, path: string): Promise<CaseFile> {
    let lastError: unknown = null;
    for (const id of await this.turnCandidates(sessionId, turnId)) {
      try {
        const raw = await this.downloadText(sessionId, id, path);
        return validateCaseFile(path, raw);
      } catch (error) {
        if (error instanceof CaseFileInvalidError) throw error;
        lastError = error;
      }
    }
    throw lastError ?? new Error(`Could not download ${path} from any turn in ${sessionId}.`);
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
