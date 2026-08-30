#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { VERDICT_GLYPH } from '@confirm-deny/casefile';
import { TriageRunner } from './runner.ts';
import { CaseStore, newCase } from './store.ts';
import { UngatedWritePathError } from './policy.ts';
import { CaseFileInvalidError } from './artifacts.ts';
import type { PendingCall, PendingDecision } from './gate.ts';
import type { TriageEvent } from './events.ts';

/**
 * The CLI is the spine: an issue URL in, a validated case file out, with the
 * gate in the middle. The Desk is a nicer surface onto exactly this flow — if
 * the Desk is ever cut, this still demonstrates the whole product.
 */

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  amber: (s: string) => `\x1b[38;5;214m${s}\x1b[0m`,
  green: (s: string) => `\x1b[38;5;114m${s}\x1b[0m`,
  red: (s: string) => `\x1b[38;5;167m${s}\x1b[0m`,
  mono: (s: string) => `\x1b[38;5;151m${s}\x1b[0m`,
};

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    console.error(c.red(`Missing ${name}.`) + ` See .env.example.`);
    process.exit(2);
  }
  return value;
}

function render(event: TriageEvent): void {
  switch (event.type) {
    case 'session.started':
      console.log(c.dim(`session ${event.sessionId}`));
      console.log(c.bold(`triaging ${event.issueUrl}\n`));
      break;
    case 'sandbox.created':
      console.log(c.dim(`  sandbox  ${event.sandboxId}`));
      break;
    case 'thread.started':
      console.log(c.dim(`  subagent ${event.title} (${event.threadId})`));
      break;
    case 'tool.called':
      console.log(`  ${c.dim('▸')} ${event.server ?? 'sandbox'}  ${c.bold(event.toolName)}`);
      break;
    case 'tool.returned':
      if (event.preview.trim()) {
        console.log(c.mono(`      ${event.preview.split('\n')[0]?.slice(0, 120) ?? ''}`));
      }
      break;
    case 'agent.said':
      console.log(`\n${event.text}\n`);
      break;
    case 'artifact.available':
      console.log(c.dim(`  artifact ${event.label} → ${event.path}`));
      break;
    case 'casefile.ready': {
      const { casefile: cf } = event;
      console.log(
        `\n  ${c.bold(`${VERDICT_GLYPH[cf.verdict]} ${cf.verdict}`)}  ${c.dim(`confidence ${cf.confidence} (derived)`)}`,
      );
      if (cf.evidence) {
        console.log(c.mono(`  ${cf.evidence.command} → exit ${cf.evidence.exitCode}`));
      }
      if (cf.analysis.unverifiedClaims.length) {
        console.log(c.amber(`  ⚠ could not verify:`));
        for (const claim of cf.analysis.unverifiedClaims) console.log(c.amber(`    · ${claim}`));
      }
      break;
    }
    case 'failed':
      console.error(c.red(`  ${event.message}`));
      break;
  }
}

/** The gate, at a terminal. Deny requires a reason here too — same rule. */
async function askOperator(calls: PendingCall[]): Promise<PendingDecision[]> {
  const rl = createInterface({ input: stdin, output: stdout });
  const decisions: PendingDecision[] = [];

  try {
    for (const call of calls) {
      console.log(`\n${c.amber('⏸  APPROVAL REQUIRED')}`);
      console.log(`   ${c.bold(call.toolName)} ${c.dim(`on ${call.serverName ?? 'local'}`)}`);
      console.log(c.mono(call.argumentsPretty.split('\n').map((l) => `   ${l}`).join('\n')));

      let answer = '';
      while (!['a', 'd'].includes(answer)) {
        answer = (await rl.question(`\n   [a]llow / [d]eny: `)).trim().toLowerCase().slice(0, 1);
      }

      if (answer === 'a') {
        decisions.push({ toolCallId: call.toolCallId, threadId: call.threadId, status: 'allow' });
        continue;
      }

      let reason = '';
      while (!reason) {
        // Enforced twice on purpose: here for a usable prompt, and in
        // buildApprovalResume so no other caller can route around it.
        reason = (await rl.question(`   reason (required): `)).trim();
        if (!reason) console.log(c.dim('   A denial without a reason teaches the agent nothing.'));
      }
      decisions.push({ toolCallId: call.toolCallId, threadId: call.threadId, status: 'deny', reason });
    }
  } finally {
    rl.close();
  }

  return decisions;
}

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);

  // Usage before credentials: a stranger running this for the first time should
  // learn what it does, not what they forgot to export.
  const usage = (code: number): never => {
    console.log('usage:\n  confirm-deny preflight\n  confirm-deny triage <github issue url>');
    process.exit(code);
  };
  if (!command) usage(0);
  if (command !== 'preflight' && command !== 'triage') usage(2);
  const issueUrl = command === 'triage' ? (argument ?? usage(2)) : '';

  const runner = new TriageRunner({
    baseUrl: env('TRUEFORGE_BASE_URL', 'http://localhost:3000'),
    token: env('TRUEFORGE_TOKEN'),
    model: env('CONFIRM_DENY_MODEL', 'anthropic/claude-sonnet-4-6'),
    githubServerName: process.env['GITHUB_MCP_SERVER'] ?? 'github',
  });

  if (command === 'preflight') {
    const report = await runner.auditApprovalPolicy();
    console.log(c.green('✓ every write path on this server pauses for a human'));
    console.log(c.dim(`  gated: ${report.gated.join(', ')}`));
    if (report.deadLiterals.length) {
      console.log(c.amber(`  ⚠ literals matching nothing: ${report.deadLiterals.join(', ')}`));
    }
    return;
  }

  // Preflight is not optional. A demo where the gate silently does not fire is
  // worse than no demo.
  const report = await runner.auditApprovalPolicy();
  console.log(c.green(`✓ gate covers ${report.gated.length} tools`) + c.dim(' (preflight)'));

  const store = CaseStore.default();
  const record = await store.upsert({ ...newCase(issueUrl), status: 'running' });

  const sessionId = await runner.startSession();
  await store.patch(record.id, { sessionId });

  let outcome = await runner.triage(sessionId, issueUrl, render);

  // Deny → revise → gate again. Bounded so a disagreeing agent cannot loop
  // forever at the operator's expense.
  for (let round = 0; outcome.pending.length > 0 && round < 5; round++) {
    await store.patch(record.id, { status: 'awaiting_approval', turnId: outcome.turnId });
    const decisions = await askOperator(outcome.pending);
    outcome = await runner.resolveGate(sessionId, decisions, render);
  }

  await store.patch(record.id, {
    status: outcome.pending.length ? 'awaiting_approval' : 'done',
    turnId: outcome.turnId,
    casefile: outcome.casefile,
  });

  console.log(outcome.casefile ? c.green('\n✓ case file validated and stored') : c.dim('\nno case file this run'));
}

main().catch((error: unknown) => {
  if (error instanceof UngatedWritePathError) {
    console.error(`\n${c.red(error.message)}`);
    process.exit(1);
  }
  if (error instanceof CaseFileInvalidError) {
    // Loud on purpose: this is the boundary doing its job, not a crash.
    console.error(`\n${c.red(error.message)}`);
    console.error(c.dim('\nThe agent wrote a case file its own verdict could not support.'));
    process.exit(1);
  }
  console.error(`\n${c.red(String((error as Error)?.stack ?? error))}`);
  process.exit(1);
});
