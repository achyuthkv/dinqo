import type { Db } from '../db/index.ts';
import type { Jobs } from '../jobs/queue.ts';
import { type Clock, iso, addMinutes } from '../util/clock.ts';
import { newId } from '../util/ids.ts';
import { TEMPLATES } from './templates.ts';
import type { Category, MessagingProvider, OutboundEnvelope } from './types.ts';

export type Purpose = 'community_games' | 'tournaments' | 'venue_events' | 'coaching' | 'brands';

export interface SendOptions {
  playerId: string;
  /** Tenant the message is sent on behalf of. Required for marketing (consent is per community). */
  communityId?: string | null;
  envelope: OutboundEnvelope;
  /** Marketing sends need purpose consent and count toward the weekly cap. */
  category: Category;
  purpose?: Purpose;
  /** Same key → same message. Protects against double sends on webhook retries. */
  idempotencyKey?: string;
  eventId?: string;
}

export type SendDecision =
  | { ok: true; messageId: string; duplicate?: boolean }
  | { ok: false; reason: 'blocked' | 'no_consent' | 'frequency_cap' | 'no_template' | 'community_inactive' };

/** Spaces calls evenly to stay under the provider's per-number throughput. */
export class RateLimiter {
  private next = 0;
  constructor(private readonly perSecond: number) {}
  async take(): Promise<void> {
    if (!(this.perSecond > 0)) return;
    const now = Date.now();
    const slot = Math.max(now, this.next);
    this.next = slot + 1000 / this.perSecond;
    if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
  }
}

// Meta's window is 24h from the player's last message; keep a safety margin.
const WINDOW_MINUTES = 24 * 60 - 10;

/**
 * Every outbound message goes through here. It applies the communication
 * policy (block list, purpose consent, frequency cap), records the message in
 * the ledger, and queues the actual send. The send job decides between a
 * free-form session message and an approved template based on the 24h window
 * at the moment of sending.
 */
export class Outbox {
  constructor(
    private readonly db: Db,
    private readonly jobs: Jobs,
    private readonly clock: Clock,
    private readonly provider: MessagingProvider,
    private readonly opts: { weeklyInviteCap: number; templateLanguage: string; maxPerSecond?: number; sendConcurrency?: number },
  ) {
    this.limiter = new RateLimiter(opts.maxPerSecond ?? 60);
    jobs.on('send_message', (p) => this.deliver(p.messageId), { concurrency: opts.sendConcurrency ?? 32 });
  }

  private readonly limiter: RateLimiter;

  send(o: SendOptions): SendDecision {
    if (o.idempotencyKey) {
      const dup = this.db.get('SELECT id FROM messages WHERE idempotency_key = ?', o.idempotencyKey);
      if (dup) return { ok: true, messageId: dup.id, duplicate: true };
    }
    const player = this.db.get('SELECT id, blocked FROM players WHERE id = ?', o.playerId);
    if (!player || (player.blocked && o.category !== 'authentication')) return { ok: false, reason: 'blocked' };

    if (o.category === 'marketing') {
      // The shared number's quality rating is everyone's, so only approved communities may promote.
      const community = o.communityId ? this.db.get('SELECT status FROM communities WHERE id = ?', o.communityId) : null;
      if (!community || community.status !== 'active') return { ok: false, reason: 'community_inactive' };
      const consent = this.db.get(
        'SELECT granted FROM consents WHERE player_id = ? AND community_id = ? AND purpose = ?',
        o.playerId, o.communityId!, o.purpose ?? 'community_games',
      );
      if (!consent?.granted) return { ok: false, reason: 'no_consent' };
      // The weekly cap is across all communities: it protects the player and the shared number.
      const since = iso(addMinutes(this.clock.now(), -7 * 24 * 60));
      const recent = this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM messages WHERE player_id = ? AND direction = 'out' AND category = 'marketing'
         AND status NOT IN ('failed','blocked') AND created_at >= ?`,
        o.playerId, since,
      )!;
      if (recent.n >= this.opts.weeklyInviteCap) return { ok: false, reason: 'frequency_cap' };
    }
    if (o.envelope.template && !TEMPLATES[o.envelope.template.name]) return { ok: false, reason: 'no_template' };

    const id = newId('msg');
    const now = iso(this.clock.now());
    this.db.run(
      `INSERT INTO messages (id, player_id, community_id, direction, kind, template_name, category, body, status, idempotency_key, event_id, created_at, updated_at)
       VALUES (?, ?, ?, 'out', ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
      id, o.playerId, o.communityId ?? null, o.envelope.session.kind, o.envelope.template?.name ?? null, o.category,
      JSON.stringify(o.envelope), o.idempotencyKey ?? null, o.eventId ?? null, now, now,
    );
    this.jobs.schedule('send_message', { messageId: id });
    return { ok: true, messageId: id };
  }

  /** Free-form reply to something the player just sent (window is open by definition). */
  reply(playerId: string, session: OutboundEnvelope['session'], communityId?: string | null): void {
    this.send({ playerId, communityId, envelope: { session }, category: 'service' });
  }

  windowOpen(playerId: string): boolean {
    const p = this.db.get('SELECT last_inbound_at FROM players WHERE id = ?', playerId);
    if (!p?.last_inbound_at) return false;
    return new Date(p.last_inbound_at).getTime() > addMinutes(this.clock.now(), -WINDOW_MINUTES).getTime();
  }

  private async deliver(messageId: string): Promise<void> {
    const m = this.db.get(
      'SELECT m.*, p.phone, p.blocked FROM messages m JOIN players p ON p.id = m.player_id WHERE m.id = ?', messageId,
    );
    if (!m || m.status !== 'queued') return;
    const setStatus = (status: string, extra: { error?: string; providerId?: string; kind?: string } = {}) =>
      this.db.run(
        `UPDATE messages SET status = ?, error = COALESCE(?, error), provider_message_id = COALESCE(?, provider_message_id),
         kind = COALESCE(?, kind), updated_at = ? WHERE id = ?`,
        status, extra.error ?? null, extra.providerId ?? null, extra.kind ?? null, iso(this.clock.now()), messageId,
      );
    if (m.blocked && m.category !== 'authentication') return void setStatus('blocked', { error: 'player blocked' });

    const env = JSON.parse(m.body) as OutboundEnvelope;
    let form;
    if (this.windowOpen(m.player_id)) form = { type: 'session' as const, message: env.session };
    else if (env.template) form = { type: 'template' as const, message: env.template, language: this.opts.templateLanguage };
    else return void setStatus('failed', { error: 'window closed and no template for this message' });

    try {
      await this.limiter.take();
      const { providerMessageId } = await this.provider.send({ to: m.phone, form });
      setStatus('sent', { providerId: providerMessageId, kind: form.type === 'template' ? 'template' : env.session.kind });
    } catch (e: any) {
      if (e?.permanent) {
        setStatus('failed', { error: e.message });
        return;
      }
      throw e; // transient: the job queue retries with backoff
    }
  }
}
