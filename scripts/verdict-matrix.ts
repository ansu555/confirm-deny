import { TriageRunner } from '../packages/runner/src/runner.ts';
import type { TriageEvent } from '../packages/runner/src/events.ts';

const EXPECTED: Record<string, string> = {
  '2': 'CANNOT_REPRODUCE',
  '3': 'NEEDS_INFO',
  '4': 'NOT_A_BUG',
};

const numbers = (process.argv[2] ?? '2,3,4').split(',');

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
    const sessionId = await runner.startSession();
    const outcome = await runner.triage(
      sessionId,
      `https://github.com/ansu555/colwrap/issues/${n}`,
      quiet,
    );
    const cf = outcome.casefile;
    if (!cf) {
      console.log(`    NO CASE FILE (gate pending: ${outcome.pending.length})`);
      continue;
    }
    const ok = cf.verdict === EXPECTED[n];
    console.log(`    verdict ${cf.verdict} ${ok ? '✓ MATCH' : `✗ expected ${EXPECTED[n]}`}`);
    console.log(`    confidence ${cf.confidence} | exit ${cf.evidence?.exitCode ?? 'n/a'} | unverified ${cf.analysis.unverifiedClaims.length}`);
    if (cf.analysis.openQuestion) console.log(`    question: ${cf.analysis.openQuestion}`);
    console.log(`    gate pending: ${outcome.pending.length} (left unresolved — nothing posted)`);
  } catch (error) {
    console.log(`    ERROR: ${(error as Error).message.split('\n')[0]}`);
  }
}
