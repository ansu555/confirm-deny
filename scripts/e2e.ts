import { TriageRunner } from '../packages/runner/src/runner.ts';
import type { TriageEvent } from '../packages/runner/src/events.ts';

const ISSUE = process.argv[2] ?? 'https://github.com/ansu555/colwrap/issues/1';

const runner = new TriageRunner({
  baseUrl: process.env['TRUEFORGE_BASE_URL'] ?? 'http://localhost:8790',
  token: process.env['TRUEFORGE_TOKEN'] ?? '',
  model: process.env['CONFIRM_DENY_MODEL'] ?? 'openrouter/glm-5-3-flash',
  githubServerName: 'github',
});

const seen: string[] = [];
const log = (e: TriageEvent) => {
  seen.push(e.type);
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

if (outcome.pending.length === 0) throw new Error('no gate opened on the first turn');
const firstBody = JSON.parse(outcome.pending[0]!.argumentsPretty) as { body?: string };
console.log(`\nGATE 1 body: ${(firstBody.body ?? '').slice(0, 90)}...`);

console.log('\n-- denying with a reason --');
outcome = await runner.resolveGate(
  sessionId,
  outcome.pending.map((c) => ({
    toolCallId: c.toolCallId,
    threadId: c.threadId,
    status: 'deny' as const,
    reason: 'State the exact command you ran and its exit code, and name which versions you did and did not check.',
  })),
  log,
);

if (outcome.pending.length === 0) throw new Error('agent did not call the tool again after the denial');
const secondBody = JSON.parse(outcome.pending[0]!.argumentsPretty) as { body?: string };
console.log(`\nGATE 2 body: ${(secondBody.body ?? '').slice(0, 160)}...`);
console.log(`revised: ${secondBody.body !== firstBody.body}`);

console.log('\n-- allowing --');
outcome = await runner.resolveGate(
  sessionId,
  outcome.pending.map((c) => ({ toolCallId: c.toolCallId, threadId: c.threadId, status: 'allow' as const })),
  log,
);

console.log(`\nfinal casefile: ${outcome.casefile ? outcome.casefile.verdict : 'none'}`);
console.log(`pending after allow: ${outcome.pending.length}`);
console.log(`events: ${[...new Set(seen)].join(', ')}`);
