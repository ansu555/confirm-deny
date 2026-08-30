export interface McpToolEntry {
  name: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
}

export const isReadOnly = (t: McpToolEntry): boolean => t.annotations?.readOnlyHint === true;

export const isWrite = (t: McpToolEntry): boolean =>
  t.annotations?.readOnlyHint === false && t.annotations?.destructiveHint !== true;

export const isDestructive = (t: McpToolEntry): boolean => t.annotations?.destructiveHint === true;

export function matchesSelector(tool: McpToolEntry, selector: string): boolean {
  switch (selector) {
    case '@all':
      return true;
    case '@write':
      return isWrite(tool);
    case '@destructive':
      return isDestructive(tool);
    case '@read-only':
      return isReadOnly(tool);
    default:
      return tool.name === selector;
  }
}

export interface PolicyReport {
  gated: string[];
  ungatedWrites: string[];
  deadLiterals: string[];
  missingCritical: string[];
}

export function auditPolicy(
  tools: readonly McpToolEntry[],
  policy: readonly string[],
  critical: readonly string[] = [],
): PolicyReport {
  const gated = tools.filter((t) => policy.some((s) => matchesSelector(t, s))).map((t) => t.name);
  const gatedSet = new Set(gated);

  const literals = policy.filter((s) => !s.startsWith('@'));
  const known = new Set(tools.map((t) => t.name));

  return {
    gated,
    ungatedWrites: tools
      .filter((t) => (isWrite(t) || isDestructive(t)) && !gatedSet.has(t.name))
      .map((t) => t.name),
    deadLiterals: literals.filter((l) => !known.has(l)),
    missingCritical: critical.filter((c) => known.has(c) && !gatedSet.has(c)),
  };
}

export const REMOTE_SANDBOX_PREFIX = 'v1:daytona:';

export class HostExecutionError extends Error {
  readonly sandboxId: string;

  constructor(sandboxId: string, expectedPrefix: string) {
    super(
      `Refusing to continue: sandbox "${sandboxId}" does not start with "${expectedPrefix}".\n` +
        `TrueForge executes on the host when no sandbox provider is configured, which would ` +
        `run the reporter's code on this machine. Configure a sandbox provider, or set ` +
        `CONFIRM_DENY_SANDBOX_PREFIX if your provider issues ids in another form.`,
    );
    this.name = 'HostExecutionError';
    this.sandboxId = sandboxId;
  }
}

export function assertRemoteSandbox(sandboxId: string, expectedPrefix: string): void {
  if (!sandboxId.startsWith(expectedPrefix)) {
    throw new HostExecutionError(sandboxId, expectedPrefix);
  }
}

export class UngatedWritePathError extends Error {
  readonly report: PolicyReport;

  constructor(report: PolicyReport) {
    super(
      `Refusing to run: the approval policy leaves a write path ungated.\n` +
        `  ungated writes : ${report.ungatedWrites.join(', ') || '(none)'}\n` +
        `  missing gates  : ${report.missingCritical.join(', ') || '(none)'}\n` +
        `  dead literals  : ${report.deadLiterals.join(', ') || '(none)'}\n` +
        `A literal that matches nothing gates nothing, and does so silently.`,
    );
    this.name = 'UngatedWritePathError';
    this.report = report;
  }
}

export function assertGated(report: PolicyReport): void {
  if (report.ungatedWrites.length > 0 || report.missingCritical.length > 0) {
    throw new UngatedWritePathError(report);
  }
}
