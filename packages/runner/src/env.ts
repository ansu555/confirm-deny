import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const QUOTED = /^(["'])([^]*?)\1/;

const stripComment = (value: string): string => {
  const comment = /\s+#/.exec(value);
  return comment ? value.slice(0, comment.index).trimEnd() : value;
};

const readValue = (raw: string): string => {
  const quoted = QUOTED.exec(raw);
  return quoted ? (quoted[2] ?? '') : stripComment(raw);
};

export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const raw = trimmed.slice(eq + 1).trim();
    out[trimmed.slice(0, eq).trim()] = readValue(raw);
  }
  return out;
}

export function findDotEnv(from: string): string | null {
  let dir = from;
  for (;;) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadDotEnv(path?: string): string[] {
  const resolved =
    path ?? findDotEnv(process.cwd()) ?? findDotEnv(import.meta.dirname) ?? null;
  if (resolved === null) return [];

  let text: string;
  try {
    text = readFileSync(resolved, 'utf8');
  } catch {
    return [];
  }

  const applied: string[] = [];
  for (const [key, value] of Object.entries(parseDotEnv(text))) {
    if (process.env[key] !== undefined) continue;
    process.env[key] = value;
    applied.push(key);
  }
  return applied;
}
