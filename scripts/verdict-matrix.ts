import { TriageRunner } from '../packages/runner/src/runner.ts';
import type { TriageEvent } from '../packages/runner/src/events.ts';

const EXPECTED: Record<string, string> = {
  '1': 'REPRODUCED',
  '2': 'CANNOT_REPRODUCE',
  '3': 'NEEDS_INFO',
  '4': 'NOT_A_BUG',
};

const numbers = (process.argv[2] ?? '1,2,3,4').split(',');
const failures: string[] = [];

for (const n of numbers) {
  const runner = new TriageRunner({
    baseUrl: process.env['TRUEFORGE_BASE_URL'] ?? 'http://localhost:8790',
    token: process.env['TRUEFORGE_TOKEN'] ?? '',
    model: process.env['CONFIRM_DENY_MODEL'] ?? 'openrouter/glm-5-3-flash',
    githubServerName: 'github',
  });

  const quiet = (e: TriageEvent) => {
    if (e.type === 'casefile.rejected') console.log(`    rejected: ${e.reason.split('\n')[0]}`);
    if (e.type === 'failed') console.log(`    failed: ${e.message.slice(0, 120)}`);
  };

  console.log(`\n=== issue #${n} — expecting ${EXPECTED[n]} ===`);
  try {
    await runner.auditApprovalPolicy();
    const sessionId = await runner.startSession();
    const outcome = await runner.triage(
      sessionId,
      `https://github.com/ansu555/colwrap/issues/${n}`,
      quiet,
    );
    const cf = outcome.casefile;
    if (!cf) {
      failures.push(`#${n}: no validated case file (gate pending: ${outcome.pending.length})`);
      console.log(`    NO CASE FILE (gate pending: ${outcome.pending.length})`);
      continue;
    }
    const ok = cf.verdict === EXPECTED[n];
    if (!ok) failures.push(`#${n}: got ${cf.verdict}, expected ${EXPECTED[n]}`);
    console.log(`    verdict ${cf.verdict} ${ok ? '✓ MATCH' : `✗ expected ${EXPECTED[n]}`}`);
    console.log(`    confidence ${cf.confidence} | exit ${cf.evidence?.exitCode ?? 'n/a'} | unverified ${cf.analysis.unverifiedClaims.length}`);
    if (cf.analysis.openQuestion) console.log(`    question: ${cf.analysis.openQuestion}`);
    if (outcome.pending.length === 0) {
      failures.push(`#${n}: no gate opened, so the reply may already have been posted`);
      console.log('    NO GATE OPENED — cannot claim nothing was posted');
    } else {
      console.log(`    gate pending: ${outcome.pending.length} (left unresolved — nothing posted)`);
    }
  } catch (error) {
    failures.push(`#${n}: ${(error as Error).message.split('\n')[0]}`);
    console.log(`    ERROR: ${(error as Error).message.split('\n')[0]}`);
  }
}

if (failures.length > 0) {
  console.error(`\nFAIL — ${failures.length} of ${numbers.length} issues did not match:`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`\nPASS — all ${numbers.length} verdicts matched`);
