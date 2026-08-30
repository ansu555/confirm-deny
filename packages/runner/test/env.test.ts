import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findDotEnv, loadDotEnv, parseDotEnv } from '../src/env.ts';

const SAMPLE = `# a comment
TRUEFORGE_BASE_URL=http://localhost:8790

TRUEFORGE_TOKEN=
CONFIRM_DENY_MODEL="openrouter/glm-5-3-flash"
GITHUB_MCP_SERVER='github'
  INDENTED = spaced
TRUEFORGE_ALT=abc # a trailing note
QUOTED_HASH="pass#word"
URL=https://example.test/api#fragment
NOT_A_PAIR
=NO_KEY
`;

describe('parseDotEnv', () => {
  const parsed = parseDotEnv(SAMPLE);

  it('reads pairs, skipping comments and blank lines', () => {
    expect(parsed['TRUEFORGE_BASE_URL']).toBe('http://localhost:8790');
    expect(parsed['INDENTED']).toBe('spaced');
  });

  it('keeps an empty value rather than dropping the key', () => {
    expect(parsed['TRUEFORGE_TOKEN']).toBe('');
    expect('TRUEFORGE_TOKEN' in parsed).toBe(true);
  });

  it('strips matched quotes', () => {
    expect(parsed['CONFIRM_DENY_MODEL']).toBe('openrouter/glm-5-3-flash');
    expect(parsed['GITHUB_MCP_SERVER']).toBe('github');
  });

  it('drops an inline comment from an unquoted value', () => {
    expect(parsed['TRUEFORGE_ALT']).toBe('abc');
  });

  it('keeps a hash that is part of the value', () => {
    expect(parsed['QUOTED_HASH']).toBe('pass#word');
    expect(parsed['URL']).toBe('https://example.test/api#fragment');
  });

  it('ignores lines that are not a pair', () => {
    expect('NOT_A_PAIR' in parsed).toBe(false);
    expect(Object.keys(parsed)).not.toContain('');
  });
});

describe('loadDotEnv', () => {
  const added: string[] = [];

  afterEach(() => {
    for (const key of added.splice(0)) delete process.env[key];
  });

  const write = (body: string): string => {
    const path = join(mkdtempSync(join(tmpdir(), 'confirm-deny-env-')), '.env');
    writeFileSync(path, body);
    return path;
  };

  it('returns an empty list when there is no file, rather than throwing', () => {
    expect(loadDotEnv(join(tmpdir(), 'confirm-deny-absent', '.env'))).toEqual([]);
  });

  it('finds the file in a parent directory, not only the cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'confirm-deny-root-'));
    writeFileSync(join(root, '.env'), 'CD_TEST_ROOT=found\n');
    const nested = join(root, 'packages', 'runner');
    mkdirSync(nested, { recursive: true });
    expect(findDotEnv(nested)).toBe(join(root, '.env'));
  });

  it('returns null rather than walking past the filesystem root', () => {
    const empty = mkdtempSync(join(tmpdir(), 'confirm-deny-none-'));
    const found = findDotEnv(empty);
    expect(found === null || found.startsWith('/')).toBe(true);
  });

  it('applies keys that are not already set', () => {
    added.push('CD_TEST_FRESH');
    const applied = loadDotEnv(write('CD_TEST_FRESH=from-file\n'));
    expect(applied).toEqual(['CD_TEST_FRESH']);
    expect(process.env['CD_TEST_FRESH']).toBe('from-file');
  });

  it('never overrides a value already in the environment', () => {
    added.push('CD_TEST_INLINE');
    process.env['CD_TEST_INLINE'] = 'from-inline';
    const applied = loadDotEnv(write('CD_TEST_INLINE=from-file\n'));
    expect(applied).toEqual([]);
    expect(process.env['CD_TEST_INLINE']).toBe('from-inline');
  });
});
