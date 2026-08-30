import type { CaseFile } from '@confirm-deny/casefile';
import type { PendingCall } from './gate.js';

/**
 * What the runner emits.
 *
 * A narrow vocabulary the CLI and the Desk both consume, so the browser never
 * needs the raw SDK stream — and therefore never needs the TrueForge key.
 */
export type TriageEvent =
  | { type: 'session.started'; sessionId: string; issueUrl: string }
  | { type: 'turn.started'; turnId: string }
  | { type: 'sandbox.created'; sandboxId: string }
  /** A subagent thread opened. Several of these run concurrently during a bisect. */
  | { type: 'thread.started'; threadId: string; title: string }
  | { type: 'agent.said'; threadId: string; text: string }
  | { type: 'tool.called'; threadId: string; toolName: string; server: string | null; args: string }
  | { type: 'tool.returned'; threadId: string; toolCallId: string; preview: string }
  /** The gate fired. Everything the operator needs to decide is in `calls`. */
  | { type: 'gate.opened'; turnId: string; calls: PendingCall[] }
  | { type: 'gate.resolved'; toolCallId: string; status: 'allow' | 'deny'; reason?: string }
  | { type: 'casefile.ready'; casefile: CaseFile; path: string }
  | { type: 'artifact.available'; label: string; path: string }
  | { type: 'turn.finished'; turnId: string; paused: boolean }
  | { type: 'failed'; message: string; detail?: string };

export type TriageEventSink = (event: TriageEvent) => void | Promise<void>;
