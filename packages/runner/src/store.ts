import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CaseFile } from '@confirm-deny/casefile';

export type CaseStatus = 'queued' | 'running' | 'awaiting_approval' | 'done' | 'failed';

export interface CaseRecord {
  id: string;
  issueUrl: string;
  status: CaseStatus;
  sessionId: string | null;
  turnId: string | null;
  casefile: CaseFile | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export class CaseStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  static default(): CaseStore {
    return new CaseStore(join(process.cwd(), 'store', 'cases.json'));
  }

  async all(): Promise<CaseRecord[]> {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as CaseRecord[]) : [];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      return [];
    }
  }

  async get(id: string): Promise<CaseRecord | null> {
    return (await this.all()).find((c) => c.id === id) ?? null;
  }

  async upsert(record: CaseRecord): Promise<CaseRecord> {
    const cases = await this.all();
    const next = { ...record, updatedAt: new Date().toISOString() };
    const at = cases.findIndex((c) => c.id === record.id);
    if (at >= 0) cases[at] = next;
    else cases.unshift(next);
    await this.write(cases);
    return next;
  }

  async patch(id: string, changes: Partial<CaseRecord>): Promise<CaseRecord | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    return this.upsert({ ...existing, ...changes });
  }

  private async write(cases: CaseRecord[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(cases, null, 2)}\n`, 'utf8');
    await rename(tmp, this.file);
  }
}

export function newCase(issueUrl: string): CaseRecord {
  const now = new Date().toISOString();
  return {
    id: `case_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    issueUrl,
    status: 'queued',
    sessionId: null,
    turnId: null,
    casefile: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
}
