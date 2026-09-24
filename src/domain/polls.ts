import { json, type Db, type Row } from '../db/index.ts';
import type { Jobs } from '../jobs/queue.ts';
import type { Outbox } from '../messaging/outbox.ts';
import type { ListRow } from '../messaging/types.ts';
import { type Clock, addMinutes, iso } from '../util/clock.ts';
import { day, rupees, time } from '../util/format.ts';
import { newId } from '../util/ids.ts';
import { nextOccurrence } from '../util/zoned.ts';
import type { Booking } from './booking.ts';
import type { Events } from './events.ts';

export const PollActions = {
  open: (pollId: string) => `poll:open:${pollId}`,
  none: (pollId: string) => `poll:none:${pollId}`,
  pick: (eventId: string) => `avail:${eventId}`,
  noneThisWeek: 'avail:none',
};

/** Games need at least this much lead time to appear in a poll. */
const MIN_LEAD_MINUTES = 60;

/**
 * Monday/Wednesday availability rounds.
 *
 * Each round lists the community's open games for the coming week to every
 * regular member. Tapping a game is an RSVP (seat held + payment link, or the
 * waitlist if full). The organiser then fills whatever is left from guests and
 * non-responders via Events.fill(). Wednesday's round only goes to people who
 * still have unanswered games, so responders are not nagged.
 */
export class Polls {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly jobs: Jobs,
    private readonly outbox: Outbox,
    private readonly events: Events,
    private readonly booking: Booking,
  ) {
    jobs.on('availability_poll', async (p) => {
      try {
        await this.run(p.communityId);
      } finally {
        this.scheduleNext(p.communityId);
      }
    });
  }

  private now() { return this.clock.now(); }

  /** Schedules this community's next poll (idempotent; replaces the pending one). */
  scheduleNext(communityId: string): Date | null {
    const c = this.db.get('SELECT * FROM communities WHERE id = ?', communityId);
    if (!c || !c.poll_enabled) {
      this.jobs.cancel(`poll:${communityId}`);
      return null;
    }
    const at = nextOccurrence(this.now(), json.parse<string[]>(c.poll_days, []), c.poll_time, c.timezone);
    if (at) this.jobs.schedule('availability_poll', { communityId }, at, `poll:${communityId}`);
    return at;
  }

  updateSettings(communityId: string, s: Partial<{ poll_enabled: boolean; poll_days: string[]; poll_time: string; poll_horizon_days: number }>): Row {
    if (s.poll_enabled !== undefined) this.db.run('UPDATE communities SET poll_enabled = ? WHERE id = ?', s.poll_enabled ? 1 : 0, communityId);
    if (s.poll_days) this.db.run('UPDATE communities SET poll_days = ? WHERE id = ?', JSON.stringify(s.poll_days), communityId);
    if (s.poll_time) this.db.run('UPDATE communities SET poll_time = ? WHERE id = ?', s.poll_time, communityId);
    if (s.poll_horizon_days) this.db.run('UPDATE communities SET poll_horizon_days = ? WHERE id = ?', s.poll_horizon_days, communityId);
    this.scheduleNext(communityId);
    return this.db.get('SELECT * FROM communities WHERE id = ?', communityId)!;
  }

  /** Open games inside the poll horizon. */
  pollableEvents(communityId: string): Row[] {
    const c = this.db.get('SELECT poll_horizon_days FROM communities WHERE id = ?', communityId)!;
    return this.db.all(
      `SELECT * FROM events WHERE community_id = ? AND status = 'open' AND starts_at > ? AND starts_at <= ? ORDER BY starts_at`,
      communityId, iso(addMinutes(this.now(), MIN_LEAD_MINUTES)), iso(addMinutes(this.now(), c.poll_horizon_days * 24 * 60)),
    );
  }

  /** Games in the horizon this player hasn't answered yet. */
  pendingFor(playerId: string, communityId: string): Row[] {
    const events = this.pollableEvents(communityId);
    const answered = this.answeredMap(events, playerId);
    return events.filter((e) => !answered.get(playerId)?.has(e.id));
  }

  /** player → event ids they've answered (registered, cancelled, or declined), in two queries. */
  private answeredMap(events: Row[], playerId?: string): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    if (!events.length) return out;
    const ids = events.map((e) => e.id);
    const marks = ids.map(() => '?').join(',');
    const only = playerId ? 'AND player_id = ?' : '';
    const extra = playerId ? [playerId] : [];
    const rows = [
      ...this.db.all(
        `SELECT player_id, event_id FROM registrations WHERE event_id IN (${marks}) ${only}
         AND status IN ('waitlisted','offered','held','confirmed','cancelled')`, ...ids, ...extra),
      ...this.db.all(`SELECT player_id, event_id FROM invitations WHERE event_id IN (${marks}) ${only} AND status = 'declined'`, ...ids, ...extra),
    ];
    for (const r of rows) {
      if (!out.has(r.player_id)) out.set(r.player_id, new Set());
      out.get(r.player_id)!.add(r.event_id);
    }
    return out;
  }

  /**
   * Sends one availability round now. Returns the poll id and who it went to.
   * Recipients are processed in chunks, each in one transaction, yielding to the
   * event loop between chunks so webhooks keep being answered during big rounds.
   */
  async run(communityId: string): Promise<{ poll_id: string | null; events: number; sent: number; skipped: number }> {
    const c = this.db.get('SELECT * FROM communities WHERE id = ?', communityId);
    if (!c) throw new Error('community not found');
    if (c.status !== 'active') return { poll_id: null, events: 0, sent: 0, skipped: 0 };
    this.events.generateFromSeries(communityId, c.poll_horizon_days);
    const events = this.pollableEvents(communityId);
    if (!events.length) return { poll_id: null, events: 0, sent: 0, skipped: 0 };

    const pollId = newId('poll');
    const horizonEnd = iso(addMinutes(this.now(), c.poll_horizon_days * 24 * 60));
    this.db.run(
      `INSERT INTO availability_polls (id, community_id, event_ids, sent_at, horizon_end) VALUES (?, ?, ?, ?, ?)`,
      pollId, communityId, JSON.stringify(events.map((e) => e.id)), iso(this.now()), horizonEnd,
    );
    const regulars = this.db.all(
      `SELECT p.id, p.name FROM memberships m JOIN players p ON p.id = m.player_id
       WHERE m.community_id = ? AND m.status = 'active' AND m.tier = 'regular' AND p.blocked = 0`, communityId,
    );
    let sent = 0;
    let skipped = 0;
    const answered = this.answeredMap(events);
    const CHUNK = 200;
    const seatsLeft = new Map(events.map((e) => [e.id, e.capacity - this.booking.seatsTaken(e.id)]));
    for (let i = 0; i < regulars.length; i += CHUNK) {
      if (i) await new Promise((r) => setImmediate(r)); // let webhooks in between chunks
      this.db.tx(() => {
        for (const p of regulars.slice(i, i + CHUNK)) {
          const pending = events.filter((e) => !answered.get(p.id)?.has(e.id));
          const record = (status: string, reason?: string) => this.db.run(
            `INSERT OR REPLACE INTO poll_recipients (poll_id, player_id, status, skip_reason) VALUES (?, ?, ?, ?)`,
            pollId, p.id, status, reason ?? null,
          );
          if (!pending.length) { record('skipped', 'nothing_pending'); skipped++; continue; }
          // Polled games count as invitations, which is what makes invite-only games bookable.
          for (const e of pending) {
            this.db.run(
              `INSERT INTO invitations (id, event_id, player_id, source, status, created_at) VALUES (?, ?, ?, 'poll', 'sent', ?)
               ON CONFLICT (event_id, player_id) DO NOTHING`,
              newId('inv'), e.id, p.id, iso(this.now()),
            );
          }
          const d = this.outbox.send({
            playerId: p.id, communityId, category: 'marketing', purpose: 'community_games', idempotencyKey: `poll:${pollId}:${p.id}`,
            envelope: {
              session: this.listMessage(pending, c.name, p.name, false, seatsLeft),
              template: {
                name: 'dinqo_availability_poll',
                params: [p.name ?? 'there', c.name, pending.map((e) => `${day(e.starts_at)} ${time(e.starts_at)} ${e.title}`).join('; ')],
                buttonPayloads: [PollActions.open(pollId), PollActions.none(pollId)],
              },
            },
          });
          if (d.ok) { record('sent'); sent++; } else { record('skipped', d.reason); skipped++; }
        }
      });
    }
    return { poll_id: pollId, events: events.length, sent, skipped };
  }

  /** The interactive list of a player's unanswered games (sent inside the 24h window). */
  listMessage(pending: Row[], communityName: string, playerName?: string | null, followUp = false, seatsLeft?: Map<string, number>) {
    const rows: ListRow[] = pending.slice(0, 9).map((e) => {
      const left = seatsLeft?.get(e.id) ?? e.capacity - this.booking.seatsTaken(e.id);
      return {
        id: PollActions.pick(e.id),
        title: `${day(e.starts_at)} ${time(e.starts_at)}`,
        description: [e.title, e.price_paise ? rupees(e.price_paise) : 'Free', left > 0 ? `${left} spots left` : 'full – waitlist'].join(' · '),
      };
    });
    rows.push({ id: PollActions.noneThisWeek, title: "Can't make any", description: 'Skip the rest of this week' });
    return {
      kind: 'list' as const,
      text: followUp
        ? 'Can you make any of the other games this week?'
        : `Hi ${playerName ?? 'there'} 👋 Here's what ${communityName} has on this week. Tap a game you can make — you can pick more than one, one at a time.`,
      buttonLabel: 'Pick a game',
      rows,
    };
  }

  /** Player tapped "Mark availability" (or typed "availability"). */
  sendList(playerId: string, communityId: string, followUp = false): boolean {
    const c = this.db.get('SELECT name FROM communities WHERE id = ?', communityId)!;
    const p = this.db.get('SELECT name FROM players WHERE id = ?', playerId)!;
    const pending = this.pendingFor(playerId, communityId);
    if (!pending.length) return false;
    for (const e of pending) {
      const eligible = this.booking.isEligible(e, playerId);
      const member = this.db.get(
        `SELECT tier FROM memberships WHERE community_id = ? AND player_id = ? AND status = 'active'`, communityId, playerId,
      );
      // Regulars asking on their own get invited on the spot; guests only see games they were invited to.
      if (!eligible && member?.tier === 'regular') {
        this.db.run(
          `INSERT INTO invitations (id, event_id, player_id, source, status, created_at) VALUES (?, ?, ?, 'poll', 'sent', ?)
           ON CONFLICT (event_id, player_id) DO NOTHING`,
          newId('inv'), e.id, playerId, iso(this.now()),
        );
      }
    }
    const visible = pending.filter((e) => this.booking.isEligible(e, playerId));
    if (!visible.length) return false;
    this.outbox.reply(playerId, this.listMessage(visible, c.name, p.name, followUp), communityId);
    return true;
  }

  markResponded(playerId: string, communityId: string, status: 'responded' | 'not_this_week' = 'responded'): void {
    this.db.run(
      `UPDATE poll_recipients SET status = ?, responded_at = ?
       WHERE player_id = ? AND poll_id IN (SELECT id FROM availability_polls WHERE community_id = ? AND horizon_end > ?)
         AND status IN ('sent','responded')`,
      status, iso(this.now()), playerId, communityId, iso(this.now()),
    );
  }

  /** "Can't make any this week": declines every unanswered polled game. */
  notThisWeek(playerId: string, communityId: string): number {
    const pending = this.pendingFor(playerId, communityId);
    for (const e of pending) {
      this.db.run(
        `INSERT INTO invitations (id, event_id, player_id, source, status, created_at, responded_at) VALUES (?, ?, ?, 'poll', 'declined', ?, ?)
         ON CONFLICT (event_id, player_id) DO UPDATE SET status = 'declined', responded_at = excluded.responded_at`,
        newId('inv'), e.id, playerId, iso(this.now()), iso(this.now()),
      );
    }
    this.markResponded(playerId, communityId, 'not_this_week');
    return pending.length;
  }

  /** Organiser view: response rates per round. */
  list(communityId: string, limit = 10): Row[] {
    return this.db.all(
      `SELECT ap.*, SUM(pr.status = 'sent') AS awaiting, SUM(pr.status = 'responded') AS responded,
         SUM(pr.status = 'not_this_week') AS not_this_week, SUM(pr.status = 'skipped') AS skipped
       FROM availability_polls ap LEFT JOIN poll_recipients pr ON pr.poll_id = ap.id
       WHERE ap.community_id = ? GROUP BY ap.id ORDER BY ap.sent_at DESC LIMIT ?`,
      communityId, limit,
    ).map((p) => ({ ...p, event_ids: json.parse(p.event_ids, []) }));
  }
}
