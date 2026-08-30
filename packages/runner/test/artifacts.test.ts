import { describe, expect, it } from 'vitest';
import {
  CaseFileInvalidError,
  findCaseFilePath,
  parseSandboxArtifacts,
  validateCaseFile,
} from '../src/artifacts.ts';

const announcement = [
  'Here is what I produced.',
  '',
  '```sandbox_artifacts',
  '[Case file](/work/case/casefile.json)',
  '[Repro script](/work/case/repro.py)',
  '```',
  '',
  'The verdict is REPRODUCED.',
].join('\n');

describe('sandbox_artifacts parsing', () => {
  it('reads every announced artifact', () => {
    expect(parseSandboxArtifacts(announcement)).toEqual([
      { label: 'Case file', path: '/work/case/casefile.json' },
      { label: 'Repro script', path: '/work/case/repro.py' },
    ]);
  });

  it('ignores links outside the fence', () => {
    const noisy = 'See [the docs](https://example.test) first.\n' + announcement;
    const paths = parseSandboxArtifacts(noisy).map((a) => a.path);
    expect(paths).not.toContain('https://example.test');
    expect(paths).toHaveLength(2);
  });

  it('de-duplicates a path announced twice across blocks', () => {
    const twice = announcement + '\n' + announcement;
    expect(parseSandboxArtifacts(twice)).toHaveLength(2);
  });

  it('returns nothing when the agent announced nothing', () => {
    expect(parseSandboxArtifacts('No artifacts this turn.')).toEqual([]);
  });

  it('finds the case file by filename, then by label', () => {
    expect(findCaseFilePath(parseSandboxArtifacts(announcement))).toBe('/work/case/casefile.json');
    expect(findCaseFilePath([{ label: 'The Case File', path: '/work/out.json' }])).toBe('/work/out.json');
    expect(findCaseFilePath([{ label: 'Repro', path: '/work/repro.py' }])).toBeNull();
  });
});

describe('the boundary reports why, not just that', () => {
  it('names the JSON syntax error', () => {
    expect(() => validateCaseFile('/work/case/casefile.json', '{ nope')).toThrow(CaseFileInvalidError);
  });

  it('lists each contract violation with its field path', () => {
    try {
      validateCaseFile('/work/case/casefile.json', JSON.stringify({ verdict: 'REPRODUCED' }));
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(CaseFileInvalidError);
      const problems = (e as CaseFileInvalidError).problems;
      expect(problems.length).toBeGreaterThan(1);
      expect(problems.join('\n')).toMatch(/issue/);
    }
  });

  it('keeps the raw text so a human can see what the agent actually wrote', () => {
    const raw = '{ "verdict": "REPRODUCED" }';
    try {
      validateCaseFile('/work/case/casefile.json', raw);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as CaseFileInvalidError).raw).toBe(raw);
    }
  });
});
