import { json, type Db, type Row } from '../db/index.ts';
import type { Jobs } from '../jobs/queue.ts';
import type { Notifier } from '../messaging/notify.ts';
import { type Clock, addMinutes, iso } from '../util/clock.ts';
import { newId } from '../util/ids.ts';
import { localDays, parseHHMM, slotKey, WEEKDAYS, zonedToUtc } from '../util/zoned.ts';
import { type Booking, BookingError } from './booking.ts';
import { SKILLS } from './members.ts';

export interface EventInput {
  community_id: string;
  venue_id?: string | null;
  series_id?: string | null;
  title: string;
  starts_at: string;
  ends_at: string;
  capacity: number;
  skill_level?: string | null;
  price_paise?: number;
  visibility?: 'invite_only' | 'members';
  cancellation_deadline?: string | null;
  late_refund_percent?: number;
  hold_minutes?: number;
  offer_minutes?: number;
  reminder_hours_before?: number;
  notes?: string | null;
}

export interface SeriesInput {
  community_id: string;
  venue_id?: string | null;
  title: string;
  weekday: string;
  start_time: string;
  duration_minutes?: number;
  capacity: number;
  skill_level?: string | null;
  price_paise?: number;
  visibility?: 'invite_only' | 'members';
  cancel_hours_before?: number;
  late_refund_percent?: number;
}

export interface InviteOutcome { player_id: string; status: 'sent' | 'skipped' | 'already_invited'; reason?: string }

export interface Candidate {
  player_id: string;
  name: string | null;
  tier: string;
  score: number;
  reasons: string[];
}

const isoOrThrow = (v: unknown, field: string): string => {
  const d = new Date(String(v));
  if (!v || Number.isNaN(d.getTime())) throw new BookingError(`${field} must be an ISO date-time`);
  return d.toISOString();
};

export class Events {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly jobs: Jobs,
    private readonly booking: Booking,
    private readonly notify: Notifier,
  ) {}

  private now() { return this.clock.now(); }

  createVenue(input: { community_id: string; name: string; area?: string; maps_url?: string }): Row {
    const id = newId('ven');
    this.db.run(
      `INSERT INTO venues (id, community_id, name, area, maps_url, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      id, input.community_id, input.name, input.area ?? null, input.maps_url ?? null, iso(this.now()),
    );
    return this.db.get('SELECT * FROM venues WHERE id = ?', id)!;
  }

  venues(communityId: string): Row[] {
    return this.db.all('SELECT * FROM venues WHERE community_id = ? ORDER BY name', communityId);
  }

  create(input: EventInput): Row {
    const starts = isoOrThrow(input.starts_at, 'starts_at');
    const ends = isoOrThrow(input.ends_at, 'ends_at');
    if (ends <= starts) throw new BookingError('ends_at must be after starts_at');
    if (!input.title?.trim()) throw new BookingError('title is required');
    if (!Number.isInteger(input.capacity) || input.capacity < 1) throw new BookingError('capacity must be a positive integer');
    if (input.skill_level && !SKILLS.includes(input.skill_level as any)) throw new BookingError('invalid skill_level');
    const price = input.price_paise ?? 0;
    if (!Number.isInteger(price) || price < 0) throw new BookingError('price_paise must be a non-negative integer');
    const hold = input.hold_minutes ?? 30;
    if (price > 0 && hold < 15) throw new BookingError('hold_minutes must be at least 15 for paid games');
    const deadline = input.cancellation_deadline ? isoOrThrow(input.cancellation_deadline, 'cancellation_deadline') : null;

    const id = newId('evt');
    const r = this.db.run(
      `INSERT OR IGNORE INTO events (id, community_id, venue_id, series_id, title, starts_at, ends_at, capacity, skill_level, price_paise,
         visibility, status, cancellation_deadline, late_refund_percent, hold_minutes, offer_minutes, reminder_hours_before, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
      id, input.community_id, input.venue_id ?? null, input.series_id ?? null, input.title.trim(), starts, ends,
      input.capacity, input.skill_level ?? null, price, input.visibility ?? 'invite_only', deadline,
      input.late_refund_percent ?? 0, hold, input.offer_minutes ?? 60, input.reminder_hours_before ?? 12,
      input.notes ?? null, iso(this.now()),
    );
    if (!r.changes) return this.db.get('SELECT * FROM events WHERE series_id = ? AND starts_at = ?', input.series_id ?? null, starts)!;
    const event = this.db.get('SELECT * FROM events WHERE id = ?', id)!;
    const reminderAt = addMinutes(new Date(starts), -60 * event.reminder_hours_before);
    if (reminderAt > this.now()) this.jobs.schedule('event_reminder', { eventId: id }, reminderAt, `evrem:${id}`);
    this.jobs.schedule('complete_event', { eventId: id }, new Date(ends), `evdone:${id}`);
    return event;
  }

  /** Organiser edits. Raising capacity immediately offers the new seats to the waitlist. */
  update(eventId: string, patch: Partial<Pick<EventInput, 'title' | 'capacity' | 'notes' | 'skill_level' | 'venue_id'>>): Row {
    return this.db.tx(() => {
      const e = this.booking.event(eventId);
      if (!e) throw new BookingError('event not found', 404);
      if (patch.capacity !== undefined) {
        if (!Number.isInteger(patch.capacity) || patch.capacity < 1) throw new BookingError('capacity must be a positive integer');
        if (patch.capacity < this.booking.seatsTaken(eventId)) throw new BookingError('capacity is below current registrations', 409);
      }
      const allowed = ['title', 'capacity', 'notes', 'skill_level', 'venue_id'] as const;
      for (const k of allowed) {
        if (patch[k] !== undefined) this.db.run(`UPDATE events SET ${k} = ? WHERE id = ?`, patch[k] as any, eventId);
      }
      this.booking.promoteWaitlist(eventId);
      return this.booking.event(eventId)!;
    });
  }

  list(communityId: string, opts: { from?: string; to?: string; status?: string } = {}): Row[] {
    return this.db.all(
      `SELECT e.*, v.name AS venue_name, v.area AS venue_area,
         SUM(r.status = 'confirmed') AS confirmed, SUM(r.status IN ('held','offered')) AS pending,
         SUM(r.status = 'waitlisted') AS waitlisted, SUM(r.attendance = 'attended') AS attended,
         SUM(r.attendance = 'no_show') AS no_shows,
         (SELECT COUNT(*) FROM invitations i WHERE i.event_id = e.id) AS invited
       FROM events e LEFT JOIN venues v ON v.id = e.venue_id LEFT JOIN registrations r ON r.event_id = e.id
       WHERE e.community_id = ? AND (? IS NULL OR e.starts_at >= ?) AND (? IS NULL OR e.starts_at < ?) AND (? IS NULL OR e.status = ?)
       GROUP BY e.id ORDER BY e.starts_at`,
      communityId, opts.from ?? null, opts.from ?? null, opts.to ?? null, opts.to ?? null, opts.status ?? null, opts.status ?? null,
    ).map((e) => ({
      ...e, confirmed: e.confirmed ?? 0, pending: e.pending ?? 0, waitlisted: e.waitlisted ?? 0,
      attended: e.attended ?? 0, no_shows: e.no_shows ?? 0,
      open_slots: Math.max(0, e.capacity - (e.confirmed ?? 0) - (e.pending ?? 0)),
    }));
  }

  detail(eventId: string): Row {
    const e = this.db.get(
      `SELECT e.*, v.name AS venue_name, v.area AS venue_area FROM events e LEFT JOIN venues v ON v.id = e.venue_id WHERE e.id = ?`, eventId,
    );
    if (!e) throw new BookingError('event not found', 404);
    const registrations = this.db.all(
      `SELECT r.*, p.name, p.phone,
         (SELECT COALESCE(SUM(amount_paise), 0) FROM payments WHERE registration_id = r.id AND status = 'paid') AS paid_paise,
         (SELECT COALESCE(SUM(rf.amount_paise), 0) FROM refunds rf JOIN payments pa ON pa.id = rf.payment_id
            WHERE pa.registration_id = r.id AND rf.status != 'failed') AS refunded_paise,
         (SELECT group_concat(rf.status) FROM refunds rf JOIN payments pa ON pa.id = rf.payment_id WHERE pa.registration_id = r.id) AS refund_statuses
       FROM registrations r JOIN players p ON p.id = r.player_id WHERE r.event_id = ?
       ORDER BY CASE r.status WHEN 'confirmed' THEN 0 WHEN 'held' THEN 1 WHEN 'offered' THEN 2 WHEN 'waitlisted' THEN 3 ELSE 4 END,
                COALESCE(r.waitlisted_at, r.confirmed_at, r.created_at)`,
      eventId,
    );
    const invitations = this.db.all(
      `SELECT i.*, p.name, p.phone FROM invitations i JOIN players p ON p.id = i.player_id WHERE i.event_id = ? ORDER BY i.created_at`, eventId,
    );
    const seats = this.booking.seatsTaken(eventId);
    return {
      ...e,
      seats_taken: seats,
      open_slots: Math.max(0, e.capacity - seats),
      revenue_paise: registrations.reduce((s, r) => s + r.paid_paise - r.refunded_paise, 0),
      registrations,
      invitations,
    };
  }

  // ---------------------------------------------------------------- series

  createSeries(input: SeriesInput): Row {
    if (!WEEKDAYS.includes(input.weekday as any)) throw new BookingError('weekday must be one of ' + WEEKDAYS.join(', '));
    parseHHMM(input.start_time);
    if (!Number.isInteger(input.capacity) || input.capacity < 1) throw new BookingError('capacity must be a positive integer');
    const id = newId('ser');
    this.db.run(
      `INSERT INTO event_series (id, community_id, venue_id, title, weekday, start_time, duration_minutes, capacity, skill_level,
         price_paise, visibility, cancel_hours_before, late_refund_percent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, input.community_id, input.venue_id ?? null, input.title, input.weekday, input.start_time, input.duration_minutes ?? 120,
      input.capacity, input.skill_level ?? null, input.price_paise ?? 0, input.visibility ?? 'invite_only',
      input.cancel_hours_before ?? 12, input.late_refund_percent ?? 0, iso(this.now()),
    );
    return this.db.get('SELECT * FROM event_series WHERE id = ?', id)!;
  }

  series(communityId: string): Row[] {
    return this.db.all('SELECT * FROM event_series WHERE community_id = ? ORDER BY weekday, start_time', communityId);
  }

  setSeriesActive(seriesId: string, active: boolean): void {
    this.db.run('UPDATE event_series SET active = ? WHERE id = ?', active ? 1 : 0, seriesId);
  }

  /** Materialises weekly series into events for the next `days` days. Idempotent. */
  generateFromSeries(communityId: string, days: number): Row[] {
    const community = this.db.get('SELECT timezone FROM communities WHERE id = ?', communityId);
    if (!community) throw new BookingError('community not found', 404);
    const created: Row[] = [];
    for (const s of this.db.all('SELECT * FROM event_series WHERE community_id = ? AND active = 1', communityId)) {
      const { hour, minute } = parseHHMM(s.start_time);
      for (const d of localDays(this.now(), days + 1, community.timezone)) {
        if (d.weekday !== s.weekday) continue;
        const starts = zonedToUtc(d.year, d.month, d.day, hour, minute, community.timezone);
        if (starts <= this.now()) continue;
        const exists = this.db.get('SELECT id FROM events WHERE series_id = ? AND starts_at = ?', s.id, iso(starts));
        if (exists) continue;
        created.push(this.create({
          community_id: communityId, series_id: s.id, venue_id: s.venue_id, title: s.title,
          starts_at: iso(starts), ends_at: iso(addMinutes(starts, s.duration_minutes)),
          capacity: s.capacity, skill_level: s.skill_level, price_paise: s.price_paise, visibility: s.visibility,
          cancellation_deadline: iso(addMinutes(starts, -60 * s.cancel_hours_before)), late_refund_percent: s.late_refund_percent,
        }));
      }
    }
    return created;
  }

  // ------------------------------------------------------------ invitations

  /** Records invitations and sends them. Skips people without consent, over the cap, or not active members. */
  invite(eventId: string, playerIds: string[], source: 'direct' | 'fill' = 'direct'): InviteOutcome[] {
    const e = this.booking.event(eventId);
    if (!e) throw new BookingError('event not found', 404);
    if (e.status !== 'open' || new Date(e.starts_at) <= this.now()) throw new BookingError('event is not open for invitations', 409);
    return playerIds.map((playerId) => this.db.tx((): InviteOutcome => {
      const member = this.db.get(
        `SELECT 1 FROM memberships WHERE community_id = ? AND player_id = ? AND status = 'active'`, e.community_id, playerId,
      );
      if (!member) return { player_id: playerId, status: 'skipped', reason: 'not_member' };
      const existing = this.db.get('SELECT status, source FROM invitations WHERE event_id = ? AND player_id = ?', eventId, playerId);
      const unansweredPoll = existing?.source === 'poll' && existing.status === 'sent';
      if (existing && existing.status !== 'skipped' && !unansweredPoll) return { player_id: playerId, status: 'already_invited' };
      const now = iso(this.now());
      this.db.run(
        `INSERT INTO invitations (id, event_id, player_id, source, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)
         ON CONFLICT (event_id, player_id) DO UPDATE SET status = 'queued', source = excluded.source, skip_reason = NULL`,
        newId('inv'), eventId, playerId, source, now,
      );
      const d = this.notify.invite(playerId, eventId);
      if (d.ok) {
        this.db.run(`UPDATE invitations SET status = 'sent' WHERE event_id = ? AND player_id = ?`, eventId, playerId);
        return { player_id: playerId, status: 'sent' };
      }
      this.db.run(
        `UPDATE invitations SET status = 'skipped', skip_reason = ? WHERE event_id = ? AND player_id = ?`, d.reason, eventId, playerId,
      );
      return { player_id: playerId, status: 'skipped', reason: d.reason };
    }));
  }

  /**
   * Rule-based candidate ranking for filling open slots (PRD §11, simplified):
   * time-slot 35, location 25, skill 20, recent activity 10, reliability 10.
   * Excludes anyone already registered, invited-and-declined, or without consent.
   */
  candidates(eventId: string): Candidate[] {
    const e = this.db.get(
      `SELECT e.*, v.area AS venue_area, c.timezone FROM events e JOIN communities c ON c.id = e.community_id
       LEFT JOIN venues v ON v.id = e.venue_id WHERE e.id = ?`, eventId,
    );
    if (!e) throw new BookingError('event not found', 404);
    const slot = slotKey(new Date(e.starts_at), e.timezone);
    const since = iso(addMinutes(this.now(), -30 * 24 * 60));
    const rows = this.db.all(
      `SELECT p.id, p.name, p.skill_level, p.preferred_locations, p.preferred_slots, m.tier,
         (SELECT COUNT(*) FROM registrations r JOIN events x ON x.id = r.event_id
            WHERE r.player_id = p.id AND r.attendance = 'attended' AND x.starts_at >= ?) AS recent_games,
         (SELECT COUNT(*) FROM registrations r WHERE r.player_id = p.id AND r.attendance = 'attended') AS attended,
         (SELECT COUNT(*) FROM registrations r WHERE r.player_id = p.id AND r.attendance = 'no_show') AS no_shows
       FROM memberships m JOIN players p ON p.id = m.player_id
       JOIN consents c ON c.player_id = p.id AND c.community_id = m.community_id AND c.purpose = 'community_games' AND c.granted = 1
       WHERE m.community_id = ? AND m.status = 'active' AND p.blocked = 0
         AND NOT EXISTS (SELECT 1 FROM registrations r WHERE r.event_id = ? AND r.player_id = p.id
                         AND r.status IN ('waitlisted','offered','held','confirmed'))
         -- regulars who got the availability poll but didn't answer stay eligible for a direct nudge
         AND NOT EXISTS (SELECT 1 FROM invitations i WHERE i.event_id = ? AND i.player_id = p.id
                         AND (i.status IN ('declined','accepted') OR (i.status IN ('sent','queued') AND i.source != 'poll')))`,
      since, e.community_id, eventId, eventId,
    );
    const skillIdx = (s: string | null) => (s ? SKILLS.indexOf(s as any) : -1);
    return rows.map((p): Candidate => {
      let score = 0;
      const reasons: string[] = [];
      const slots: string[] = json.parse(p.preferred_slots, []);
      const locs: string[] = json.parse(p.preferred_locations, []);
      if (slots.includes(slot)) { score += 35; reasons.push('prefers this time'); }
      if (e.venue_area && locs.some((l) => l.toLowerCase() === String(e.venue_area).toLowerCase())) { score += 25; reasons.push('plays in this area'); }
      if (!e.skill_level) score += 20;
      else if (p.skill_level === e.skill_level) { score += 20; reasons.push('skill match'); }
      else if (Math.abs(skillIdx(p.skill_level) - skillIdx(e.skill_level)) === 1) score += 8;
      if (p.recent_games > 0) { score += 10; reasons.push(`${p.recent_games} games in last 30 days`); }
      const marked = p.attended + p.no_shows;
      score += marked ? Math.round(10 * (p.attended / marked)) : 5;
      return { player_id: p.id, name: p.name, tier: p.tier, score, reasons };
    }).sort((a, b) => b.score - a.score || (a.tier === 'regular' ? -1 : 1));
  }

  /**
   * Invites the best candidates to fill open slots. By default invites 1.5× the
   * open slots (not everyone says yes); the rest can go in a later wave.
   */
  fill(eventId: string, opts: { count?: number; playerIds?: string[] } = {}): { open_slots: number; invited: InviteOutcome[] } {
    const e = this.booking.event(eventId);
    if (!e) throw new BookingError('event not found', 404);
    const open = Math.max(0, e.capacity - this.booking.seatsTaken(eventId));
    const ids = opts.playerIds ?? this.candidates(eventId)
      .slice(0, opts.count ?? Math.ceil(open * 1.5))
      .map((c) => c.player_id);
    if (!ids.length) return { open_slots: open, invited: [] };
    return { open_slots: open, invited: this.invite(eventId, ids, 'fill') };
  }
}
