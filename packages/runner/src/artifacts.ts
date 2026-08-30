import { parseCaseFile, type CaseFile } from '@confirm-deny/casefile';
import { ZodError } from 'zod';

/**
 * The sandbox artifact boundary.
 *
 * The agent announces what it produced in a fenced ```sandbox_artifacts block;
 * we pull each file out with the download endpoint and validate it HERE, on our
 * side, before anything renders it.
 *
 * That placement is the whole point: a malformed case file becomes a visible
 * error with a message, not a half-empty pane that looks like a verdict.
 */

export interface SandboxArtifact {
  label: string;
  path: string;
}

const FENCE = /```sandbox_artifacts\s*\n([\s\S]*?)```/g;
const LINK = /\[([^\]]+)\]\(([^)]+)\)/g;

/**
 * Parse the artifact announcements out of an assistant message.
 *
 * Tolerant by design — several blocks, odd spacing, links wrapped across lines.
 * The agent is a language model; the parser should not be the brittle part.
 */
export function parseSandboxArtifacts(content: string): SandboxArtifact[] {
  const found: SandboxArtifact[] = [];
  const seen = new Set<string>();

  for (const block of content.matchAll(FENCE)) {
    const body = block[1] ?? '';
    for (const link of body.matchAll(LINK)) {
      const label = link[1]?.trim();
      const path = link[2]?.trim();
      if (!label || !path || seen.has(path)) continue;
      seen.add(path);
      found.push({ label, path });
    }
  }

  return found;
}

/** Pick the case file out of a set of announced artifacts. */
export function findCaseFilePath(artifacts: readonly SandboxArtifact[]): string | null {
  const byName = artifacts.find((a) => a.path.endsWith('casefile.json'));
  if (byName) return byName.path;
  const byLabel = artifacts.find((a) => /case\s*file/i.test(a.label));
  return byLabel?.path ?? null;
}

export class CaseFileInvalidError extends Error {
  constructor(
    public readonly path: string,
    public readonly problems: string[],
    public readonly raw: string,
  ) {
    super(
      `The case file at ${path} did not satisfy the contract:\n` +
        problems.map((p) => `  · ${p}`).join('\n'),
    );
    this.name = 'CaseFileInvalidError';
  }
}

/**
 * Validate a downloaded case file.
 *
 * Deliberately loud. A case file that fails here is a bug we can see; a case
 * file waved through is a wrong verdict posted under a maintainer's name.
 */
export function validateCaseFile(path: string, raw: string): CaseFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new CaseFileInvalidError(path, [`not valid JSON: ${(e as Error).message}`], raw);
  }

  try {
    return parseCaseFile(parsed);
  } catch (e) {
    if (e instanceof ZodError) {
      throw new CaseFileInvalidError(
        path,
        e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
        raw,
      );
    }
    throw e;
  }
}
