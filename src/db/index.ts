import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Row = Record<string, any>;
export type Params = SQLInputValue[];

/**
 * Thin wrapper over node:sqlite. SQLite serialises writers, and every
 * seat-allocating operation runs inside `tx()` (BEGIN IMMEDIATE), so two
 * players tapping "I'm in" at the same moment cannot both get the last slot.
 */
export class Db {
  readonly raw: DatabaseSync;
  private depth = 0;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  }

  /** Applies migrations/NNN_*.sql in order, tracking progress in PRAGMA user_version. */
  migrate(): void {
    const dir = new URL('./migrations/', import.meta.url);
    const files = readdirSync(dir).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
    let version = Number(this.get<{ user_version: number }>('PRAGMA user_version')!.user_version);
    for (const f of files) {
      const n = Number(f.slice(0, 3));
      if (n <= version) continue;
      this.tx(() => {
        this.raw.exec(readFileSync(new URL(f, dir), 'utf8'));
        this.raw.exec(`PRAGMA user_version = ${n}`);
      });
      version = n;
    }
  }

  get<T = Row>(sql: string, ...params: Params): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: Params): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  run(sql: string, ...params: Params): { changes: number } {
    const r = this.raw.prepare(sql).run(...params);
    return { changes: Number(r.changes) };
  }

  /** Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth--;
    }
  }

  close(): void {
    this.raw.close();
  }
}

export const json = {
  parse<T>(s: string | null | undefined, fallback: T): T {
    if (!s) return fallback;
    try { return JSON.parse(s) as T; } catch { return fallback; }
  },
};
