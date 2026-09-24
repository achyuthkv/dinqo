import type { Db } from '../db/index.ts';
import { type Clock, iso, addMinutes } from '../util/clock.ts';
import { newId } from '../util/ids.ts';

export type JobHandler = (payload: any) => Promise<void> | void;

const MAX_ATTEMPTS = 6;

/**
 * Durable job queue on SQLite. Timers (hold expiry, waitlist offers, reminders)
 * and every external call (WhatsApp sends, payment links, refunds) run as jobs,
 * so a crash or provider outage never loses work — it is retried with backoff.
 */
export class Jobs {
  private handlers = new Map<string, JobHandler>();
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(private readonly db: Db, private readonly clock: Clock) {}

  on(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
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

  /** Runs every job that is due right now. Returns how many ran. */
  async tick(limit = 50): Promise<number> {
    const due = this.db.all(
      `SELECT * FROM jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at, created_at LIMIT ?`,
      iso(this.clock.now()), limit,
    );
    for (const job of due) {
      const claimed = this.db.run(
        `UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending'`,
        iso(this.clock.now()), job.id,
      );
      if (!claimed.changes) continue;
      const handler = this.handlers.get(job.type);
      try {
        if (!handler) throw Object.assign(new Error(`No handler for job type ${job.type}`), { permanent: true });
        await handler(JSON.parse(job.payload));
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
    return due.length;
  }

  /** Runs due jobs until none are left (jobs may enqueue more jobs). Used by tests and dev tools. */
  async drain(maxRounds = 100): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      if ((await this.tick()) === 0) return;
    }
  }

  start(intervalMs = 1000): void {
    this.timer = setInterval(async () => {
      if (this.busy) return;
      this.busy = true;
      try { await this.tick(); } catch (e) { console.error('[jobs] tick error', e); } finally { this.busy = false; }
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
