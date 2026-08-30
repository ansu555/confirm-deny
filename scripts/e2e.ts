import { TriageRunner } from '../packages/runner/src/runner.ts';
import type { TriageEvent } from '../packages/runner/src/events.ts';
import { loadDotEnv } from '../packages/runner/src/env.ts';

loadDotEnv();

const ISSUE = process.argv[2] ?? 'https://github.com/ansu555/colwrap/issues/1';

const runner = new TriageRunner({
  baseUrl: process.env['TRUEFORGE_BASE_URL'] ?? 'http://localhost:8790',
  token: process.env['TRUEFORGE_TOKEN'] ?? '',
  model: process.env['CONFIRM_DENY_MODEL'] ?? 'openrouter/glm-5-3-flash',
  githubServerName: 'github',
});

const seen: string[] = [];
let validated: { verdict: string; confidence: string } | null = null;
const log = (e: TriageEvent) => {
  seen.push(e.type);
  if (e.type === 'casefile.ready') validated = { verdict: e.casefile.verdict, confidence: e.casefile.confidence };
  if (e.type === 'sandbox.created') console.log(`  sandbox ${e.sandboxId}`);
  if (e.type === 'casefile.ready') console.log(`  casefile ${e.casefile.verdict} / ${e.casefile.confidence} / exit ${e.casefile.evidence?.exitCode}`);
  if (e.type === 'casefile.rejected') console.log(`  REJECTED: ${e.reason.split('\n')[0]}`);
  if (e.type === 'gate.opened') console.log(`  gate: ${e.calls.map((c) => c.toolName).join(', ')}`);
  if (e.type === 'failed') console.log(`  FAILED: ${e.message.slice(0, 160)}`);
};

await runner.auditApprovalPolicy();
console.log('preflight ok');

const sessionId = await runner.startSession();
let outcome = await runner.triage(sessionId, ISSUE, log);

const commentCall = (o: typeof outcome) => {
  const calls = o.pending.filter((c) => c.toolName === 'add_issue_comment');
  if (calls.length !== 1) {
    throw new Error(`expected exactly one gated add_issue_comment, got ${calls.length} (pending: ${o.pending.map((c) => c.toolName).join(', ')})`);
  }
  return calls[0]!;
};

if (outcome.pending.length === 0) throw new Error('no gate opened on the first turn');
const firstCall = commentCall(outcome);
const firstBody = JSON.parse(firstCall.argumentsPretty) as { body?: string };
console.log(`\nGATE 1 body: ${(firstBody.body ?? '').slice(0, 90)}...`);

console.log('\n-- denying with a reason --');
outcome = await runner.resolveGate(
  sessionId,
  [
    {
      toolCallId: firstCall.toolCallId,
      threadId: firstCall.threadId,
      status: 'deny' as const,
      reason: 'State the exact command you ran and its exit code, and name which versions you did and did not check.',
    },
  ],
  log,
);

if (outcome.pending.length === 0) throw new Error('agent did not call the tool again after the denial');
if (outcome.casefileError) throw new Error(`case file still rejected after the denial: ${outcome.casefileError.message}`);
const secondCall = commentCall(outcome);
const secondBody = JSON.parse(secondCall.argumentsPretty) as { body?: string };
console.log(`\nGATE 2 body: ${(secondBody.body ?? '').slice(0, 160)}...`);
if (secondBody.body === firstBody.body) {
  throw new Error('the agent ignored the denial: the second draft is byte-identical to the first');
}
console.log('revised: yes');

console.log('\n-- allowing --');
outcome = await runner.resolveGate(
  sessionId,
  [{ toolCallId: secondCall.toolCallId, threadId: secondCall.threadId, status: 'allow' as const }],
  log,
);

if (outcome.pending.length > 0) throw new Error('a gate is still open after the approval');
if (!validated) throw new Error('no case file was ever validated, so the gate should never have opened');
const { verdict, confidence } = validated as { verdict: string; confidence: string };
console.log(`\nvalidated casefile: ${verdict} / ${confidence}`);
console.log(`events: ${[...new Set(seen)].join(', ')}`);
console.log('\nPASS — preflight, gate, denial, revision, approval, validated case file');
