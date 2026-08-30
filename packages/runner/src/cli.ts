#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { VERDICT_GLYPH } from '@confirm-deny/casefile';
import { TriageRunner, rejectionReason, ApprovalOnRejectedCaseFileError } from './runner.ts';
import { CaseStore, newCase } from './store.ts';
import { UngatedWritePathError, HostExecutionError } from './policy.ts';
import { CaseFileInvalidError, MissingCaseFileError } from './artifacts.ts';
import type { PendingCall, PendingDecision } from './gate.ts';
import type { TriageEvent } from './events.ts';
import { loadDotEnv } from './env.ts';

const REPAIR_LIMIT = 2;

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
    case 'casefile.rejected':
      console.log(`\n${c.amber('⛔ case file rejected — the gate stays shut')}`);
      for (const line of event.reason.split('\n')) console.log(c.amber(`   ${line}`));
      break;
    case 'casefile.repair':
      console.log(c.dim(`   handing the schema errors back to the agent (${event.round}/${event.limit})`));
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

let prompt: ReturnType<typeof createInterface> | null = null;
function operatorPrompt(): ReturnType<typeof createInterface> {
  prompt ??= createInterface({ input: stdin, output: stdout });
  return prompt;
}

class OperatorInputClosedError extends Error {
  constructor() {
    super(
      'Standard input closed while the gate was waiting for a decision. Nothing was posted.\n' +
        'The gate needs an interactive terminal: run confirm-deny directly rather than piping ' +
        'answers in, since readline drops buffered lines between prompts.',
    );
    this.name = 'OperatorInputClosedError';
  }
}

async function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  let onClose: (() => void) | null = null;
  const closed = new Promise<never>((_, reject) => {
    onClose = () => reject(new OperatorInputClosedError());
    rl.once('close', onClose);
  });
  try {
    return await Promise.race([rl.question(question), closed]);
  } finally {
    if (onClose) rl.removeListener('close', onClose);
  }
}

async function askOperator(calls: PendingCall[]): Promise<PendingDecision[]> {
  const rl = operatorPrompt();
  const decisions: PendingDecision[] = [];

  {
    for (const call of calls) {
      console.log(`\n${c.amber('⏸  APPROVAL REQUIRED')}`);
      console.log(`   ${c.bold(call.toolName)} ${c.dim(`on ${call.serverName ?? 'local'}`)}`);
      console.log(c.mono(call.argumentsPretty.split('\n').map((l) => `   ${l}`).join('\n')));

      let answer = '';
      while (!['a', 'd'].includes(answer)) {
        answer = (await ask(rl, `\n   [a]llow / [d]eny: `)).trim().toLowerCase().slice(0, 1);
      }

      if (answer === 'a') {
        decisions.push({ toolCallId: call.toolCallId, threadId: call.threadId, status: 'allow' });
        continue;
      }

      let reason = '';
      while (!reason) {
        
        reason = (await ask(rl, `   reason (required): `)).trim();
        if (!reason) console.log(c.dim('   A denial without a reason teaches the agent nothing.'));
      }
      decisions.push({ toolCallId: call.toolCallId, threadId: call.threadId, status: 'deny', reason });
    }
  }

  return decisions;
}

function rejectedValues(error: CaseFileInvalidError): [string, string][] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(error.raw);
  } catch {
    return [['(file)', error.raw.slice(0, 300)]];
  }

  const rows: [string, string][] = [];
  for (const problem of error.problems) {
    const path = problem.split(':')[0]?.trim();
    if (!path || path === '(root)') continue;
    let cursor: unknown = parsed;
    for (const key of path.split('.')) {
      if (cursor && typeof cursor === 'object') cursor = (cursor as Record<string, unknown>)[key];
      else cursor = undefined;
    }
    rows.push([path, JSON.stringify(cursor) ?? 'undefined']);
  }
  return rows;
}

async function main(): Promise<void> {
  const fromFile = loadDotEnv();
  const [command, argument] = process.argv.slice(2);

  const usage = (code: number): never => {
    console.log('usage:\n  confirm-deny preflight\n  confirm-deny triage <github issue url>');
    process.exit(code);
  };
  if (!command) usage(0);
  if (command !== 'preflight' && command !== 'triage') usage(2);
  const issueUrl = command === 'triage' ? (argument ?? usage(2)) : '';

  const baseUrl = env('TRUEFORGE_BASE_URL', 'http://localhost:8790');
  const model = env('CONFIRM_DENY_MODEL', 'openrouter/glm-5-3-flash');

  console.log(
    c.dim(
      `  ${baseUrl} · ${model}${fromFile.length ? ` · ${fromFile.length} from .env` : ''}`,
    ),
  );

  const runner = new TriageRunner({
    baseUrl,
    token: process.env['TRUEFORGE_TOKEN'] ?? '',
    model,
    githubServerName: process.env['GITHUB_MCP_SERVER'] ?? 'github',
    ...(process.env['CONFIRM_DENY_SANDBOX_PREFIX']
      ? { sandboxPrefix: process.env['CONFIRM_DENY_SANDBOX_PREFIX'] }
      : {}),
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

  const report = await runner.auditApprovalPolicy();
  console.log(c.green(`✓ gate covers ${report.gated.length} tools`) + c.dim(' (preflight)'));

  const store = CaseStore.default();
  const record = await store.upsert({ ...newCase(issueUrl), status: 'running' });
  const markFailed = async (): Promise<void> => {
    await store.patch(record.id, { status: 'failed' });
  };

  try {
    await runTriage();
  } catch (error) {
    await markFailed();
    throw error;
  }

  async function runTriage(): Promise<void> {
    const sessionId = await runner.startSession();
    await store.patch(record.id, { sessionId });

    let outcome = await runner.triage(sessionId, issueUrl, render);

    let repairs = 0;
    for (let round = 0; outcome.pending.length > 0 && round < 8; round++) {
      await store.patch(record.id, { status: 'awaiting_approval', turnId: outcome.turnId });

      if (outcome.casefileError) {
        if (repairs >= REPAIR_LIMIT) throw outcome.casefileError;
        repairs += 1;
        await render({ type: 'casefile.repair', round: repairs, limit: REPAIR_LIMIT });
        const reason = rejectionReason(outcome.casefileError);
        outcome = await runner.resolveGate(
          sessionId,
          outcome.pending.map((call) => ({
            toolCallId: call.toolCallId,
            threadId: call.threadId,
            status: 'deny' as const,
            reason,
          })),
          render,
        );
        continue;
      }

      const decisions = await askOperator(outcome.pending);
      outcome = await runner.resolveGate(sessionId, decisions, render);
    }

    if (outcome.casefileError) throw outcome.casefileError;

    await store.patch(record.id, {
      status: outcome.pending.length ? 'awaiting_approval' : 'done',
      turnId: outcome.turnId,
      casefile: outcome.casefile,
    });

    console.log(outcome.casefile ? c.green('\n✓ case file validated and stored') : c.dim('\nno case file this run'));
    prompt?.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ApprovalOnRejectedCaseFileError) {
    console.error(`\n${c.red(error.message)}`);
    process.exit(1);
  }
  if (error instanceof OperatorInputClosedError) {
    console.error(`\n${c.red(error.message)}`);
    process.exit(1);
  }
  if (error instanceof UngatedWritePathError) {
    console.error(`\n${c.red(error.message)}`);
    process.exit(1);
  }
  if (error instanceof CaseFileInvalidError) {
    console.error(`\n${c.red(error.message)}`);
    for (const [path, value] of rejectedValues(error)) {
      console.error(c.mono(`  ${path} = ${value}`));
    }
    console.error(c.dim('\nThe agent wrote a case file its own verdict could not support.'));
    console.error(c.dim('Nothing was posted; the gate is not opened on an invalid case file.'));
    process.exit(1);
  }
  if (error instanceof MissingCaseFileError) {
    console.error(`\n${c.red(error.message)}`);
    process.exit(1);
  }
  if (error instanceof HostExecutionError) {
    console.error(`\n${c.red(error.message)}`);
    process.exit(1);
  }
  console.error(`\n${c.red(String((error as Error)?.stack ?? error))}`);
  process.exit(1);
});
