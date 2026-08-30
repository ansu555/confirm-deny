import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCaseFile } from '../src/index.ts';

const examplePath = fileURLToPath(
  new URL('../../../skills/repro-playbook/references/casefile.example.json', import.meta.url),
);

const raw = JSON.parse(readFileSync(examplePath, 'utf8')) as Record<string, unknown>;

describe('the example case file the skill calls the authority on shape', () => {
  it('satisfies the schema it is supposed to demonstrate', () => {
    expect(() => parseCaseFile(raw)).not.toThrow();
  });

  it('demonstrates a revisions entry, since that is what the agent has to copy', () => {
    const revisions = raw['revisions'] as unknown[];
    expect(revisions.length).toBeGreaterThan(0);
    expect(revisions[0]).toMatchObject({
      deniedReason: expect.any(String),
      revisedAt: expect.any(String),
      previousDraft: expect.any(String),
    });
  });

  it('carries every top-level key the instructions promise', () => {
    expect(Object.keys(raw).sort()).toEqual(
      ['analysis', 'draftReply', 'evidence', 'issue', 'labels', 'revisions', 'verdict'].sort(),
    );
  });
});
