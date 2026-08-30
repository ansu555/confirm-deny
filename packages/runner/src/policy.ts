/**
 * The approval policy, and a preflight that proves it actually gates something.
 *
 * THE TRAP THIS EXISTS TO CLOSE:
 *
 *   1. `requireApprovalForTools` REPLACES the default `["@write","@destructive"]`
 *      rather than extending it (`requireApprovalForTools ?? DEFAULT_...`).
 *   2. Literal names in that list are NEVER validated. Only `enableTools`
 *      literals get a missing-name check.
 *   3. GitHub's MCP server ships several naming schemes for the same operation,
 *      selected by toolset and feature flag.
 *
 * Together those mean a stale or misspelled tool name gates nothing, fails
 * silently, and you find out when the agent posts a comment during your demo.
 *
 * So we resolve the policy against the LIVE tool list before running, and refuse
 * to start if the demo-critical write path is ungated.
 */

/** A `tools/list` entry, as the MCP server published it. */
export interface McpToolEntry {
  name: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
}

/**
 * TrueForge's selector logic, mirrored exactly.
 *
 * Note `isWrite` excludes destructive tools — `@write` and `@destructive` are
 * DISJOINT. Dropping either tag leaves a real hole: `@write` alone would not
 * cover `label_write` or `delete_repository`.
 */
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
  /** Every tool the policy will actually pause on. */
  gated: string[];
  /** Tools that can mutate GitHub and are NOT gated. Must be empty. */
  ungatedWrites: string[];
  /** Literal names in the policy that match nothing on this server. */
  deadLiterals: string[];
  /** Tools that must be gated for the demo to be safe. */
  missingCritical: string[];
}

/**
 * Resolve a policy against a live tool list.
 *
 * `critical` names the calls whose gating is non-negotiable. They may be gated
 * by a tag rather than by their own literal — what matters is that they pause,
 * not how.
 */
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
    // A critical tool the server does not expose at all is not a gating failure;
    // it is a naming drift we report separately via deadLiterals.
    missingCritical: critical.filter((c) => known.has(c) && !gatedSet.has(c)),
  };
}

export class UngatedWritePathError extends Error {
  constructor(public readonly report: PolicyReport) {
    super(
      `Refusing to run: the approval policy leaves a write path ungated.\n` +
        `  ungated writes : ${report.ungatedWrites.join(', ') || '(none)'}\n` +
        `  missing gates  : ${report.missingCritical.join(', ') || '(none)'}\n` +
        `  dead literals  : ${report.deadLiterals.join(', ') || '(none)'}\n` +
        `A literal that matches nothing gates nothing, and does so silently.`,
    );
    this.name = 'UngatedWritePathError';
  }
}

/** Throws unless every write path on this server pauses for a human. */
export function assertGated(report: PolicyReport): void {
  if (report.ungatedWrites.length > 0 || report.missingCritical.length > 0) {
    throw new UngatedWritePathError(report);
  }
}
