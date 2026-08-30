import { parseCaseFile, type CaseFile } from '@confirm-deny/casefile';
import { ZodError } from 'zod';

export interface SandboxArtifact {
  label: string;
  path: string;
}

const FENCE = /```sandbox_artifacts\s*\n([\s\S]*?)```/g;
const LINK = /\[([^\]]+)\]\(([^)]+)\)/g;

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

export const DEFAULT_CASE_FILE_PATH = '/work/case/casefile.json';

export function findCaseFilePath(artifacts: readonly SandboxArtifact[]): string | null {
  const byName = artifacts.find((a) => a.path.endsWith('casefile.json'));
  if (byName) return byName.path;
  const byLabel = artifacts.find((a) => /case\s*file/i.test(a.label));
  return byLabel?.path ?? null;
}

export class MissingCaseFileError extends Error {
  readonly turnId: string;

  constructor(turnId: string) {
    super(
      `Refusing to open the approval gate: the agent asked to post without announcing a ` +
        `case file. The reply is only the case file's summary, so there would be nothing ` +
        `for a human to check the draft against.`,
    );
    this.name = 'MissingCaseFileError';
    this.turnId = turnId;
  }
}

export class CaseFileInvalidError extends Error {
  readonly path: string;
  readonly problems: string[];
  readonly raw: string;

  constructor(path: string, problems: string[], raw: string) {
    super(
      `The case file at ${path} did not satisfy the contract:\n` +
        problems.map((p) => `  · ${p}`).join('\n'),
    );
    this.name = 'CaseFileInvalidError';
    this.path = path;
    this.problems = problems;
    this.raw = raw;
  }
}

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
