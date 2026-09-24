import type { Db } from '../db/index.ts';
import { type Clock, iso, addMinutes } from '../util/clock.ts';
import { newId } from '../util/ids.ts';

export type JobHandler = (payload: any) => Promise<void> | void;

const MAX_ATTEMPTS = 6;
const BATCH = 500;

interface Registered { handler: JobHandler; concurrency: number }

/**
 * Durable job queue on SQLite. Timers (hold expiry, waitlist offers, reminders)
 * and every external call (WhatsApp sends, payment links, refunds) run as jobs,
 * so a crash or provider outage never loses work — it is retried with backoff.
 *
 * Most job types run one at a time, which keeps booking state changes simple.
 * Pure I/O jobs (message sends) declare a concurrency so a Monday poll to
 * thousands of players goes out in parallel instead of one API call at a time.
 */
export class Jobs {
  private handlers = new Map<string, Registered>();
  private timer?: NodeJS.Timeout;
  private busy = false;
  private stopped = false;

  constructor(private readonly db: Db, private readonly clock: Clock) {}

  on(type: string, handler: JobHandler, opts: { concurrency?: number } = {}): void {
    this.handlers.set(type, { handler, concurrency: Math.max(1, opts.concurrency ?? 1) });
  }

  /**
   * Schedule a job. With `uniqueKey`, an existing pending job with that key is
   * rescheduled instead of duplicated (and a finished one is replaced).
   */
  schedule(type: string, payload: object, runAt: Date = this.clock.now(), uniqueKey?: string): void {
    const now = iso(this.clock.now());
    if (uniqueKey) {
      const existing = this.db.get('SELECT id, status FROM jobs WHERE unique_key = ?', uniqueKey);
      if (existing) {
        this.db.run(
          `UPDATE jobs SET type = ?, payload = ?, run_at = ?, status = 'pending', attempts = 0, last_error = NULL, updated_at = ? WHERE id = ?`,
          type, JSON.stringify(payload), iso(runAt), now, existing.id,
        );
        return;
      }
    }
    this.db.run(
      `INSERT INTO jobs (id, type, payload, run_at, unique_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      newId('job'), type, JSON.stringify(payload), iso(runAt), uniqueKey ?? null, now, now,
    );
  }

  cancel(uniqueKey: string): void {
    this.db.run(
      `UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE unique_key = ? AND status = 'pending'`,
      iso(this.clock.now()), uniqueKey,
    );
  }

  /** Runs every job that is due right now (up to `limit`). Returns how many were picked up. */
  async tick(limit = BATCH): Promise<number> {
    const due = this.db.all(
      `SELECT * FROM jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at, created_at LIMIT ?`,
      iso(this.clock.now()), limit,
    );
    const serial: any[] = [];
    const parallel = new Map<string, any[]>();
    for (const job of due) {
      const reg = this.handlers.get(job.type);
      if (reg && reg.concurrency > 1) parallel.set(job.type, [...(parallel.get(job.type) ?? []), job]);
      else serial.push(job);
    }
    // Serial jobs first (in due order), then each parallel type through a bounded pool.
    for (const job of serial) await this.run(job);
    for (const [type, jobs] of parallel) {
      const width = this.handlers.get(type)!.concurrency;
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, async () => {
        while (next < jobs.length) await this.run(jobs[next++]);
      }));
    }
    return due.length;
  }

  private async run(job: any): Promise<void> {
    const claimed = this.db.run(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending'`,
      iso(this.clock.now()), job.id,
    );
    if (!claimed.changes) return;
    const reg = this.handlers.get(job.type);
    try {
      if (!reg) throw Object.assign(new Error(`No handler for job type ${job.type}`), { permanent: true });
      await reg.handler(JSON.parse(job.payload));
      this.db.run(`UPDATE jobs SET status = 'done', updated_at = ? WHERE id = ? AND status = 'running'`, iso(this.clock.now()), job.id);
    } catch (e: any) {
      const attempts = job.attempts + 1;
      const giveUp = e?.permanent || attempts >= MAX_ATTEMPTS;
      const backoff = Math.min(2 ** attempts, 60); // minutes
      this.db.run(
        `UPDATE jobs SET status = ?, run_at = ?, last_error = ?, updated_at = ? WHERE id = ?`,
        giveUp ? 'failed' : 'pending', iso(addMinutes(this.clock.now(), backoff)),
        String(e?.stack ?? e).slice(0, 2000), iso(this.clock.now()), job.id,
      );
      if (giveUp) console.error(`[jobs] ${job.type} ${job.id} failed permanently:`, e?.message ?? e);
    }
  }

  /** Runs due jobs until none are left (jobs may enqueue more jobs). Used by tests and dev tools. */
  async drain(maxRounds = 100): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      if ((await this.tick()) === 0) return;
    }
  }

  /** Polls for due jobs; keeps going without waiting while there is a backlog. */
  start(intervalMs = 1000): void {
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      let picked = 0;
      if (!this.busy) {
        this.busy = true;
        try { picked = await this.tick(); } catch (e) { console.error('[jobs] tick error', e); } finally { this.busy = false; }
      }
      this.timer = setTimeout(loop, picked >= BATCH ? 0 : intervalMs);
    };
    this.timer = setTimeout(loop, 0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
