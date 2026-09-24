import type { Db } from '../db/index.ts';
import { day, rupees, time, when } from '../util/format.ts';
import type { Outbox, SendDecision } from './outbox.ts';

/** Button / list-row ids. The bot router parses these back into actions. */
export const Actions = {
  rsvpYes: (eventId: string) => `rsvp:yes:${eventId}`,
  rsvpNo: (eventId: string) => `rsvp:no:${eventId}`,
  waitlistJoin: (eventId: string) => `wl:join:${eventId}`,
  waitlistSkip: (eventId: string) => `wl:skip:${eventId}`,
  offerYes: (eventId: string) => `offer:yes:${eventId}`,
  offerNo: (eventId: string) => `offer:no:${eventId}`,
  cancelAsk: (eventId: string) => `cancel:ask:${eventId}`,
  cancelConfirm: (eventId: string) => `cancel:yes:${eventId}`,
  cancelKeep: (eventId: string) => `cancel:keep:${eventId}`,
  payLink: (eventId: string) => `pay:link:${eventId}`,
};

export interface EventView {
  id: string;
  title: string;
  community: string;
  venue: string;
  starts_at: string;
  ends_at: string;
  skill_level: string | null;
  price_paise: number;
}

export function loadEventView(db: Db, eventId: string): EventView {
  const e = db.get(
    `SELECT e.*, c.name AS community, v.name AS venue_name, v.area AS venue_area
     FROM events e JOIN communities c ON c.id = e.community_id LEFT JOIN venues v ON v.id = e.venue_id WHERE e.id = ?`,
    eventId,
  );
  if (!e) throw new Error(`event ${eventId} not found`);
  return {
    id: e.id,
    title: e.title,
    community: e.community,
    venue: [e.venue_name, e.venue_area].filter(Boolean).join(', ') || 'Venue TBA',
    starts_at: e.starts_at,
    ends_at: e.ends_at,
    skill_level: e.skill_level,
    price_paise: e.price_paise,
  };
}

const slotText = (e: EventView) => `${day(e.starts_at)}, ${time(e.starts_at)}–${time(e.ends_at)}`;
const skillText = (e: EventView) => (e.skill_level ? cap(e.skill_level) : 'All levels');
const priceText = (e: EventView) => (e.price_paise ? rupees(e.price_paise) : 'Free');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function eventCard(e: EventView): string {
  return `*${e.title}*\n📍 ${e.venue}\n🗓 ${slotText(e)}\n🎾 ${skillText(e)}\n💰 ${priceText(e)}`;
}

/** Builds and queues every lifecycle message. Keys make each one idempotent. */
export class Notifier {
  constructor(private readonly db: Db, private readonly outbox: Outbox) {}

  invite(playerId: string, eventId: string): SendDecision {
    const e = loadEventView(this.db, eventId);
    return this.outbox.send({
      playerId, eventId, category: 'marketing', purpose: 'community_games',
      idempotencyKey: `invite:${eventId}:${playerId}`,
      envelope: {
        session: {
          kind: 'buttons',
          text: `🏓 ${e.community} has invited you to play\n\n${eventCard(e)}\n\nWant to play?`,
          buttons: [{ id: Actions.rsvpYes(eventId), title: "Yes, I'm in" }, { id: Actions.rsvpNo(eventId), title: 'Not this time' }],
        },
        template: {
          name: 'dinqo_game_invite',
          params: [e.community, e.title, e.venue, slotText(e), skillText(e), priceText(e)],
          buttonPayloads: [Actions.rsvpYes(eventId), Actions.rsvpNo(eventId)],
        },
      },
    });
  }

  paymentLink(playerId: string, eventId: string, url: string, heldUntil: string, amountPaise: number, key: string): void {
    const e = loadEventView(this.db, eventId);
    this.outbox.send({
      playerId, eventId, category: 'utility', idempotencyKey: key,
      envelope: {
        session: {
          kind: 'cta_url',
          text: `Great — we've held a spot for you 🙌\n\n${eventCard(e)}\n\nComplete payment by ${time(heldUntil)} to confirm your spot.`,
          label: `Pay ${rupees(amountPaise)}`,
          url,
          footer: 'Your spot is released if payment is not completed',
        },
        template: { name: 'dinqo_payment_pending', params: [e.title, day(e.starts_at), when(heldUntil), rupees(amountPaise), url] },
      },
    });
  }

  confirmed(playerId: string, eventId: string, key: string): void {
    const e = loadEventView(this.db, eventId);
    this.outbox.send({
      playerId, eventId, category: 'utility', idempotencyKey: key,
      envelope: {
        session: {
          kind: 'buttons',
          text: `You're confirmed ✅\n\n${eventCard(e)}\n\nWe'll send you a reminder before the game.`,
          buttons: [{ id: Actions.cancelAsk(eventId), title: "Can't make it" }],
        },
        template: { name: 'dinqo_booking_confirmed', params: [e.title, e.venue, slotText(e)] },
      },
    });
  }

  holdExpired(playerId: string, eventId: string, key: string): void {
    const e = loadEventView(this.db, eventId);
    this.outbox.send({
      playerId, eventId, category: 'utility', idempotencyKey: key,
      envelope: {
        session: {
          kind: 'buttons',
          text: `Your held spot for *${e.title}* (${day(e.starts_at)}) was released because payment wasn't completed.`,
          buttons: [{ id: Actions.rsvpYes(eventId), title: 'Try again' }],
        },
        template: { name: 'dinqo_hold_expired', params: [e.title, day(e.starts_at)], buttonPayloads: [Actions.rsvpYes(eventId)] },
      },
    });
  }

  waitlistOffer(playerId: string, eventId: string, until: string, key: string): void {
    const e = loadEventView(this.db, eventId);
    this.outbox.send({
      playerId, eventId, category: 'utility', idempotencyKey: key,
      envelope: {
        session: {
          kind: 'buttons',
          text: `A spot just opened up 🎉\n\n${eventCard(e)}\n\nIt's reserved for you until ${when(until)}. Want it?`,
          buttons: [{ id: Actions.offerYes(eventId), title: "Yes, I'm in" }, { id: Actions.offerNo(eventId), title: 'No, pass' }],
        },
        template: {
          name: 'dinqo_waitlist_offer',
          params: [e.title, slotText(e), when(until)],
          buttonPayloads: [Actions.offerYes(eventId), Actions.offerNo(eventId)],
        },
      },
    });
  }

  offerExpired(playerId: string, eventId: string, key: string): void {
    const e = loadEventView(this.db, eventId);
    this.outbox.send({
      playerId, eventId, category: 'utility', idempotencyKey: key,
      envelope: {
        session: { kind: 'text', text: `The spot we held for you for *${e.title}* has been passed to the next player on the waitlist.` },
        template: { name: 'dinqo_cancellation_update', params: [e.title, day(e.starts_at), 'The offered spot expired and was passed on.'] },
      },
    });
  }

  reminder(playerId: string, eventId: string): void {
    const e = loadEventView(this.db, eventId);
    this.outbox.send({
      playerId, eventId, category: 'utility', idempotencyKey: `reminder:${eventId}:${playerId}`,
      envelope: {
        session: {
          kind: 'buttons',
          text: `⏰ Reminder\n\n${eventCard(e)}\n\nSee you on court!`,
          buttons: [{ id: Actions.cancelAsk(eventId), title: "Can't make it" }],
        },
        template: {
          name: 'dinqo_event_reminder',
          params: [e.title, e.venue, slotText(e)],
          buttonPayloads: [Actions.cancelAsk(eventId)],
        },
      },
    });
  }

  paymentReminder(playerId: string, eventId: string, url: string, heldUntil: string, amountPaise: number, key: string): void {
    const e = loadEventView(this.db, eventId);
    this.outbox.send({
      playerId, eventId, category: 'utility', idempotencyKey: key,
      envelope: {
        session: {
          kind: 'cta_url',
          text: `Your spot for *${e.title}* is held until ${time(heldUntil)}. Complete payment to lock it in.`,
          label: `Pay ${rupees(amountPaise)}`,
          url,
        },
        template: { name: 'dinqo_payment_pending', params: [e.title, day(e.starts_at), when(heldUntil), rupees(amountPaise), url] },
      },
    });
  }

  cancelled(playerId: string, eventId: string, refundNote: string, key: string): void {
    const e = loadEventView(this.db, eventId);
    this.outbox.send({
      playerId, eventId, category: 'utility', idempotencyKey: key,
      envelope: {
        session: { kind: 'text', text: `Your registration for *${e.title}* (${day(e.starts_at)}) is cancelled. ${refundNote}`.trim() },
        template: { name: 'dinqo_cancellation_update', params: [e.title, day(e.starts_at), refundNote || 'No payment was taken.'] },
      },
    });
  }

  eventCancelled(playerId: string, eventId: string, refundNote: string): void {
    const e = loadEventView(this.db, eventId);
    this.outbox.send({
      playerId, eventId, category: 'utility', idempotencyKey: `event-cancelled:${eventId}:${playerId}`,
      envelope: {
        session: { kind: 'text', text: `Sorry — *${e.title}* on ${day(e.starts_at)} has been cancelled by the organiser. ${refundNote}`.trim() },
        template: { name: 'dinqo_event_cancelled', params: [e.title, day(e.starts_at), refundNote || 'No payment was taken.'] },
      },
    });
  }

  refundUpdate(playerId: string, eventId: string, text: string, key: string): void {
    const e = loadEventView(this.db, eventId);
    this.outbox.send({
      playerId, eventId, category: 'utility', idempotencyKey: key,
      envelope: {
        session: { kind: 'text', text: `💸 Refund update for *${e.title}*: ${text}` },
        template: { name: 'dinqo_refund_update', params: [e.title, text] },
      },
    });
  }
}

