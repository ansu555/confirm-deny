import type { CaseFile } from '@confirm-deny/casefile';
import type { PendingCall } from './gate.ts';

export type TriageEvent =
  | { type: 'session.started'; sessionId: string; issueUrl: string }
  | { type: 'turn.started'; turnId: string }
  | { type: 'sandbox.created'; sandboxId: string }
  | { type: 'thread.started'; threadId: string; title: string }
  | { type: 'agent.said'; threadId: string; text: string }
  | { type: 'tool.called'; threadId: string; toolName: string; server: string | null; args: string }
  | { type: 'tool.returned'; threadId: string; toolCallId: string; preview: string }
  | { type: 'gate.opened'; turnId: string; calls: PendingCall[] }
  | { type: 'gate.resolved'; toolCallId: string; status: 'allow' | 'deny'; reason?: string }
  | { type: 'casefile.ready'; casefile: CaseFile; path: string }
  | { type: 'casefile.rejected'; reason: string }
  | { type: 'casefile.repair'; round: number; limit: number }
  | { type: 'artifact.available'; label: string; path: string }
  | { type: 'turn.finished'; turnId: string; paused: boolean }
  | { type: 'failed'; message: string; detail?: string };

export type TriageEventSink = (event: TriageEvent) => void | Promise<void>;
