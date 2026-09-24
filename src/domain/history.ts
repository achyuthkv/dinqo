import type { Db, Row } from '../db/index.ts';
import type { Clock } from '../util/clock.ts';

export interface MemberStats {
  invited: number;
  registered: number;          // ever held a seat (confirmed, or cancelled after confirming)
  confirmed_upcoming: number;
  played: number;              // attended
  no_shows: number;
  cancellations: number;
  waitlisted: number;
  total_paid_paise: number;
  total_refunded_paise: number;
  attendance_rate: number | null;   // attended / (attended + no_show)
  last_played_at: string | null;
}

/** Everything a member has done: stats plus a per-event timeline. Scoped to a community if given. */
export function memberHistory(db: Db, clock: Clock, playerId: string, communityId?: string): { stats: MemberStats; events: Row[] } {
  const scope = communityId ? 'AND e.community_id = ?' : '';
  const args = communityId ? [playerId, communityId] : [playerId];
  const now = clock.now().toISOString();

  const events = db.all(
    `SELECT e.id AS event_id, e.title, e.starts_at, e.status AS event_status, e.price_paise,
            v.name AS venue, c.name AS community,
            r.status, r.attendance, r.confirmed_at, r.cancelled_at, r.cancel_reason,
            i.status AS invitation_status,
            (SELECT COALESCE(SUM(p.amount_paise), 0) FROM payments p WHERE p.registration_id = r.id AND p.status = 'paid') AS paid_paise,
            (SELECT COALESCE(SUM(rf.amount_paise), 0) FROM refunds rf JOIN payments p ON p.id = rf.payment_id
               WHERE p.registration_id = r.id AND rf.status != 'failed') AS refunded_paise,
            (SELECT group_concat(rf.status) FROM refunds rf JOIN payments p ON p.id = rf.payment_id
               WHERE p.registration_id = r.id) AS refund_statuses
     FROM events e
     JOIN communities c ON c.id = e.community_id
     LEFT JOIN venues v ON v.id = e.venue_id
     LEFT JOIN registrations r ON r.event_id = e.id AND r.player_id = ?1
     LEFT JOIN invitations i ON i.event_id = e.id AND i.player_id = ?1
     WHERE (r.id IS NOT NULL OR i.id IS NOT NULL) ${scope.replace('?', '?2')}
     ORDER BY e.starts_at DESC`,
    ...args,
  );

  const confirmedEver = (r: Row) =>
    r.status === 'confirmed' || (r.status === 'cancelled' && r.confirmed_at);
  const played = events.filter((r) => r.attendance === 'attended');
  const noShows = events.filter((r) => r.attendance === 'no_show').length;
  const stats: MemberStats = {
    invited: events.filter((r) => r.invitation_status).length,
    registered: events.filter(confirmedEver).length,
    confirmed_upcoming: events.filter((r) => r.status === 'confirmed' && r.starts_at > now && r.event_status === 'open').length,
    played: played.length,
    no_shows: noShows,
    cancellations: events.filter((r) => r.status === 'cancelled' && r.confirmed_at).length,
    waitlisted: events.filter((r) => r.status === 'waitlisted').length,
    total_paid_paise: events.reduce((s, r) => s + (r.paid_paise ?? 0), 0),
    total_refunded_paise: events.reduce((s, r) => s + (r.refunded_paise ?? 0), 0),
    attendance_rate: played.length + noShows ? Math.round((played.length / (played.length + noShows)) * 100) / 100 : null,
    last_played_at: played[0]?.starts_at ?? null,
  };
  return { stats, events };
}

/** Upcoming games a player holds or is queued for — used by the WhatsApp "My games" menu. */
export function upcomingForPlayer(db: Db, clock: Clock, playerId: string): Row[] {
  return db.all(
    `SELECT e.id AS event_id, e.title, e.starts_at, e.ends_at, r.status, r.expires_at, v.name AS venue
     FROM registrations r JOIN events e ON e.id = r.event_id LEFT JOIN venues v ON v.id = e.venue_id
     WHERE r.player_id = ? AND r.status IN ('waitlisted','offered','held','confirmed')
       AND e.status = 'open' AND e.starts_at > ?
     ORDER BY e.starts_at`,
    playerId, clock.now().toISOString(),
  );
}
