import type { Db, Row } from '../db/index.ts';
import type { Jobs } from '../jobs/queue.ts';
import type { Notifier } from '../messaging/notify.ts';
import type { PaymentEvent, PaymentProvider } from '../payments/types.ts';
import { type Clock, addMinutes, iso } from '../util/clock.ts';
import { rupees } from '../util/format.ts';
import { newId } from '../util/ids.ts';

/** Statuses that occupy a seat. */
export const SEATED = ['offered', 'held', 'confirmed'] as const;
const SEATED_SQL = `('offered','held','confirmed')`;

/** Waitlist offers are not made when the game is about to start. */
const OFFER_CUTOFF_MINUTES = 30;

export type Actor = 'player' | 'organiser' | 'system';

export type RsvpResult =
  | { kind: 'confirmed' }
  | { kind: 'held'; expiresAt: string }
  | { kind: 'already_confirmed' }
  | { kind: 'already_held'; expiresAt: string }
  | { kind: 'waitlisted'; position: number }
  | { kind: 'full' }
  | { kind: 'not_eligible' }
  | { kind: 'closed'; reason: 'not_open' | 'started' | 'not_found' };

export type CancelResult =
  | { kind: 'cancelled'; refundPaise: number; previous: string }
  | { kind: 'not_registered' }
  | { kind: 'too_late' };

export interface RefundQuote {
  paidPaise: number;
  refundPaise: number;
  fullRefund: boolean;
  deadline: string;
}

export class BookingError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/**
 * The booking engine: slot holds, payments, waitlist offers, cancellations,
 * refunds and attendance. Every state change is a conditional UPDATE inside a
 * transaction, so duplicate or late webhooks and double taps cannot move a
 * registration backwards or oversell a game.
 */
export class Booking {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly jobs: Jobs,
    private readonly notify: Notifier,
    private readonly payments: PaymentProvider,
  ) {
    jobs.on('create_payment_link', (p) => this.createPaymentLink(p.registrationId));
    jobs.on('cancel_payment_link', (p) => this.payments.cancelLink(p.linkId));
    jobs.on('expire_hold', (p) => this.expireHold(p.registrationId));
    jobs.on('payment_reminder', (p) => this.paymentReminder(p.registrationId));
    jobs.on('expire_offer', (p) => this.expireOffer(p.registrationId));
    jobs.on('issue_refund', (p) => this.issueRefund(p.refundId));
    jobs.on('event_reminder', (p) => this.sendReminders(p.eventId));
    jobs.on('complete_event', (p) => this.completeEvent(p.eventId));
  }

  private now(): Date { return this.clock.now(); }

  // ---------------------------------------------------------------- queries

  event(eventId: string): Row | undefined {
    return this.db.get('SELECT * FROM events WHERE id = ?', eventId);
  }

  registration(eventId: string, playerId: string): Row | undefined {
    return this.db.get('SELECT * FROM registrations WHERE event_id = ? AND player_id = ?', eventId, playerId);
  }

  seatsTaken(eventId: string): number {
    return this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM registrations WHERE event_id = ? AND status IN ${SEATED_SQL}`, eventId,
    )!.n;
  }

  waitlistPosition(eventId: string, playerId: string): number {
    const reg = this.registration(eventId, playerId);
    if (reg?.status !== 'waitlisted') return 0;
    return this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM registrations WHERE event_id = ? AND status = 'waitlisted' AND waitlisted_at <= ?`,
      eventId, reg.waitlisted_at,
    )!.n;
  }

  isEligible(event: Row, playerId: string): boolean {
    const member = this.db.get(
      `SELECT 1 FROM memberships WHERE community_id = ? AND player_id = ? AND status = 'active'`, event.community_id, playerId,
    );
    if (!member) return false;
    if (event.visibility === 'members') return true;
    return !!this.db.get('SELECT 1 FROM invitations WHERE event_id = ? AND player_id = ?', event.id, playerId);
  }

  // ------------------------------------------------------------ transitions

  private transition(reg: Row, to: string, actor: Actor, note: string | null, fields: Record<string, any> = {}): void {
    const sets = ['status = ?', 'updated_at = ?', ...Object.keys(fields).map((k) => `${k} = ?`)];
    const r = this.db.run(
      `UPDATE registrations SET ${sets.join(', ')} WHERE id = ? AND status = ?`,
      to, iso(this.now()), ...Object.values(fields), reg.id, reg.status,
    );
    if (!r.changes) throw new BookingError(`registration ${reg.id} changed concurrently`, 409);
    this.db.run(
      `INSERT INTO registration_log (registration_id, from_status, to_status, actor, note, at) VALUES (?, ?, ?, ?, ?, ?)`,
      reg.id, reg.status, to, actor, note, iso(this.now()),
    );
    reg.status = to;
    Object.assign(reg, fields);
  }

  private ensureRegistration(event: Row, playerId: string): Row {
    let reg = this.registration(event.id, playerId);
    if (!reg) {
      const id = newId('reg');
      const now = iso(this.now());
      this.db.run(
        `INSERT INTO registrations (id, event_id, player_id, status, amount_paise, created_at, updated_at)
         VALUES (?, ?, ?, 'declined', ?, ?, ?)`,
        id, event.id, playerId, event.price_paise, now, now,
      );
      reg = this.registration(event.id, playerId)!;
    }
    return reg;
  }

  // ------------------------------------------------------------------- RSVP

  /** Player says "I'm in" (to an invite, a waitlist offer, or a retry). */
  rsvp(eventId: string, playerId: string, actor: Actor = 'player'): RsvpResult {
    return this.db.tx(() => {
      const event = this.event(eventId);
      if (!event) return { kind: 'closed', reason: 'not_found' } as const;
      if (event.status !== 'open') return { kind: 'closed', reason: 'not_open' } as const;
      if (new Date(event.starts_at) <= this.now()) return { kind: 'closed', reason: 'started' } as const;
      if (actor === 'player' && !this.isEligible(event, playerId)) return { kind: 'not_eligible' } as const;

      this.db.run(
        `UPDATE invitations SET status = 'accepted', responded_at = ? WHERE event_id = ? AND player_id = ?`,
        iso(this.now()), eventId, playerId,
      );

      const reg = this.registration(eventId, playerId);
      if (reg?.status === 'confirmed') return { kind: 'already_confirmed' } as const;
      if (reg?.status === 'held') {
        this.resendPaymentLink(reg);
        return { kind: 'already_held', expiresAt: reg.expires_at } as const;
      }
      if (reg?.status === 'offered' && new Date(reg.expires_at) > this.now()) {
        return this.allocate(event, reg, actor, 'accepted waitlist offer');
      }
      if (reg?.status === 'waitlisted') {
        return { kind: 'waitlisted', position: this.waitlistPosition(eventId, playerId) } as const;
      }
      const waiting = this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM registrations WHERE event_id = ? AND status = 'waitlisted'`, eventId,
      )!.n;
      if (this.seatsTaken(eventId) < event.capacity && waiting === 0) {
        return this.allocate(event, this.ensureRegistration(event, playerId), actor, 'rsvp');
      }
      return { kind: 'full' } as const;
    });
  }

  decline(eventId: string, playerId: string): void {
    this.db.run(
      `UPDATE invitations SET status = 'declined', responded_at = ? WHERE event_id = ? AND player_id = ? AND status IN ('queued','sent')`,
      iso(this.now()), eventId, playerId,
    );
  }

  /** Puts the player in a seat: confirmed for free games, otherwise held pending payment. */
  private allocate(event: Row, reg: Row, actor: Actor, note: string): RsvpResult {
    if (event.price_paise === 0) {
      this.transition(reg, 'confirmed', actor, note, { confirmed_at: iso(this.now()), expires_at: null, amount_paise: 0 });
      this.notify.confirmed(reg.player_id, event.id, `confirmed:${reg.id}:${reg.confirmed_at}`);
      return { kind: 'confirmed' };
    }
    const cap = addMinutes(new Date(event.starts_at), -5);
    const holdUntil = new Date(Math.min(addMinutes(this.now(), event.hold_minutes).getTime(), cap.getTime()));
    this.transition(reg, 'held', actor, note, { expires_at: iso(holdUntil), amount_paise: event.price_paise });
    this.jobs.schedule('create_payment_link', { registrationId: reg.id }, this.now(), `plink:${reg.id}`);
    this.jobs.schedule('expire_hold', { registrationId: reg.id }, holdUntil, `hold:${reg.id}`);
    const holdMinutes = (holdUntil.getTime() - this.now().getTime()) / 60_000;
    if (holdMinutes >= 20) {
      this.jobs.schedule('payment_reminder', { registrationId: reg.id }, addMinutes(this.now(), holdMinutes / 2), `payrem:${reg.id}`);
    }
    return { kind: 'held', expiresAt: iso(holdUntil) };
  }

  // --------------------------------------------------------------- payments

  private openPayment(regId: string): Row | undefined {
    return this.db.get(
      `SELECT * FROM payments WHERE registration_id = ? AND status = 'created' ORDER BY created_at DESC LIMIT 1`, regId,
    );
  }

  private async createPaymentLink(registrationId: string): Promise<void> {
    const reg = this.db.get(
      `SELECT r.*, p.name, p.phone, e.title FROM registrations r JOIN players p ON p.id = r.player_id
       JOIN events e ON e.id = r.event_id WHERE r.id = ?`, registrationId,
    );
    if (!reg || reg.status !== 'held' || this.openPayment(reg.id)) return;
    const paymentId = newId('pay');
    const link = await this.payments.createLink({
      referenceId: paymentId,
      amountPaise: reg.amount_paise,
      description: `${reg.title} — Dinqo`,
      customer: { name: reg.name ?? undefined, phone: reg.phone },
      expireBy: new Date(reg.expires_at),
    });
    const stillHeld = this.db.tx(() => {
      const current = this.db.get('SELECT status, expires_at FROM registrations WHERE id = ?', reg.id)!;
      this.db.run(
        `INSERT INTO payments (id, registration_id, provider, provider_link_id, link_url, amount_paise, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        paymentId, reg.id, this.payments.name, link.linkId, link.url, reg.amount_paise,
        current.status === 'held' ? 'created' : 'cancelled', iso(this.now()),
      );
      if (current.status !== 'held') return false;
      this.notify.paymentLink(reg.player_id, reg.event_id, link.url, current.expires_at, reg.amount_paise, `paylink:${paymentId}`);
      return true;
    });
    if (!stillHeld) this.jobs.schedule('cancel_payment_link', { linkId: link.linkId });
  }

  private resendPaymentLink(reg: Row): void {
    const pay = this.openPayment(reg.id);
    if (!pay) return; // link job still pending; it will send the link
    this.notify.paymentLink(reg.player_id, reg.event_id, pay.link_url, reg.expires_at, pay.amount_paise, `paylink:${pay.id}:${iso(this.now())}`);
  }

  private cancelOpenPayments(regId: string): void {
    for (const p of this.db.all(`SELECT * FROM payments WHERE registration_id = ? AND status = 'created'`, regId)) {
      this.db.run(`UPDATE payments SET status = 'cancelled' WHERE id = ? AND status = 'created'`, p.id);
      this.jobs.schedule('cancel_payment_link', { linkId: p.provider_link_id });
    }
  }

  /** Normalised payment-provider webhook. Safe to call more than once per event. */
  handlePaymentEvent(ev: PaymentEvent): void {
    if (ev.type === 'link_paid') return this.confirmPayment(ev.linkId, ev.paymentId, ev.amountPaise);
    if (ev.type === 'link_expired') {
      this.db.run(`UPDATE payments SET status = 'expired' WHERE provider_link_id = ? AND status = 'created'`, ev.linkId);
      return;
    }
    this.refundSettled(ev.refundId, ev.type === 'refund_processed');
  }

  private confirmPayment(linkId: string, providerPaymentId: string, amountPaise: number): void {
    this.db.tx(() => {
      const pay = this.db.get('SELECT * FROM payments WHERE provider_link_id = ?', linkId);
      if (!pay) throw new BookingError(`unknown payment link ${linkId}`, 404);
      if (pay.status === 'paid') return; // duplicate webhook
      this.db.run(
        `UPDATE payments SET status = 'paid', provider_payment_id = ?, paid_at = ?, amount_paise = ? WHERE id = ?`,
        providerPaymentId, iso(this.now()), amountPaise, pay.id,
      );
      pay.amount_paise = amountPaise;
      const reg = this.db.get('SELECT * FROM registrations WHERE id = ?', pay.registration_id)!;
      const event = this.event(reg.event_id)!;

      if (reg.status === 'held' || reg.status === 'offered') {
        this.confirmSeat(reg, 'payment received');
        return;
      }
      if (reg.status === 'confirmed') {
        this.createRefund(pay, pay.amount_paise, 'duplicate_payment', reg);
        return;
      }
      // Late payment: the hold already lapsed. Honour it if a seat is still free.
      const seatFree = event.status === 'open' && new Date(event.starts_at) > this.now()
        && this.seatsTaken(event.id) < event.capacity;
      if (seatFree) {
        this.confirmSeat(reg, 'late payment accepted');
      } else {
        this.createRefund(pay, pay.amount_paise, 'late_payment', reg);
        this.notify.refundUpdate(
          reg.player_id, reg.event_id,
          `your payment of ${rupees(pay.amount_paise)} arrived after your hold expired and the game is now full, so we're refunding it in full.`,
          `late-refund:${pay.id}`,
        );
      }
    });
  }

  private confirmSeat(reg: Row, note: string): void {
    this.transition(reg, 'confirmed', 'system', note, { confirmed_at: iso(this.now()), expires_at: null, waitlisted_at: null });
    this.jobs.cancel(`hold:${reg.id}`);
    this.jobs.cancel(`payrem:${reg.id}`);
    this.jobs.cancel(`offer:${reg.id}`);
    this.cancelOpenPayments(reg.id);
    this.notify.confirmed(reg.player_id, reg.event_id, `confirmed:${reg.id}:${reg.confirmed_at}`);
  }

  private expireHold(registrationId: string): void {
    this.db.tx(() => {
      const reg = this.db.get('SELECT * FROM registrations WHERE id = ?', registrationId);
      if (!reg || reg.status !== 'held' || new Date(reg.expires_at) > this.now()) return;
      this.transition(reg, 'expired', 'system', 'payment not completed in time', { expires_at: null });
      this.cancelOpenPayments(reg.id);
      this.jobs.cancel(`payrem:${reg.id}`);
      this.notify.holdExpired(reg.player_id, reg.event_id, `hold-expired:${reg.id}:${iso(this.now())}`);
      this.promoteWaitlist(reg.event_id);
    });
  }

  private paymentReminder(registrationId: string): void {
    const reg = this.db.get('SELECT * FROM registrations WHERE id = ?', registrationId);
    if (reg?.status !== 'held') return;
    const pay = this.openPayment(reg.id);
    if (!pay) return;
    this.notify.paymentReminder(reg.player_id, reg.event_id, pay.link_url, reg.expires_at, pay.amount_paise, `payrem:${pay.id}`);
  }

  // --------------------------------------------------------------- waitlist

  joinWaitlist(eventId: string, playerId: string): RsvpResult {
    return this.db.tx(() => {
      const event = this.event(eventId);
      if (!event) return { kind: 'closed', reason: 'not_found' } as const;
      if (event.status !== 'open') return { kind: 'closed', reason: 'not_open' } as const;
      if (new Date(event.starts_at) <= this.now()) return { kind: 'closed', reason: 'started' } as const;
      if (!this.isEligible(event, playerId)) return { kind: 'not_eligible' } as const;
      const reg = this.ensureRegistration(event, playerId);
      if (reg.status === 'confirmed') return { kind: 'already_confirmed' } as const;
      if (reg.status === 'held') return { kind: 'already_held', expiresAt: reg.expires_at } as const;
      if (reg.status === 'offered') return this.allocate(event, reg, 'player', 'accepted waitlist offer');
      if (reg.status !== 'waitlisted') {
        const waiting = this.db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM registrations WHERE event_id = ? AND status = 'waitlisted'`, eventId,
        )!.n;
        // A seat may have freed up between "it's full" and tapping "join waitlist".
        if (waiting === 0 && this.seatsTaken(eventId) < event.capacity) {
          return this.allocate(event, reg, 'player', 'seat available on waitlist join');
        }
        this.transition(reg, 'waitlisted', 'player', 'joined waitlist', { waitlisted_at: iso(this.now()), expires_at: null });
      }
      return { kind: 'waitlisted', position: this.waitlistPosition(eventId, playerId) } as const;
    });
  }

  /** Offers every free seat to the longest-waiting players. Call inside a transaction. */
  promoteWaitlist(eventId: string): void {
    const event = this.event(eventId);
    if (!event || event.status !== 'open') return;
    const startsAt = new Date(event.starts_at);
    if (startsAt.getTime() - this.now().getTime() < OFFER_CUTOFF_MINUTES * 60_000) return;
    let free = event.capacity - this.seatsTaken(eventId);
    while (free-- > 0) {
      const next = this.db.get(
        `SELECT * FROM registrations WHERE event_id = ? AND status = 'waitlisted' ORDER BY waitlisted_at, created_at LIMIT 1`, eventId,
      );
      if (!next) return;
      const until = new Date(Math.min(addMinutes(this.now(), event.offer_minutes).getTime(), addMinutes(startsAt, -15).getTime()));
      this.transition(next, 'offered', 'system', 'seat opened', { expires_at: iso(until) });
      this.jobs.schedule('expire_offer', { registrationId: next.id }, until, `offer:${next.id}`);
      this.notify.waitlistOffer(next.player_id, eventId, iso(until), `offer:${next.id}:${iso(this.now())}`);
    }
  }

  declineOffer(eventId: string, playerId: string): boolean {
    return this.db.tx(() => {
      const reg = this.registration(eventId, playerId);
      if (reg?.status !== 'offered') return false;
      this.transition(reg, 'declined', 'player', 'declined waitlist offer', { expires_at: null });
      this.jobs.cancel(`offer:${reg.id}`);
      this.promoteWaitlist(eventId);
      return true;
    });
  }

  private expireOffer(registrationId: string): void {
    this.db.tx(() => {
      const reg = this.db.get('SELECT * FROM registrations WHERE id = ?', registrationId);
      if (!reg || reg.status !== 'offered' || new Date(reg.expires_at) > this.now()) return;
      this.transition(reg, 'expired', 'system', 'waitlist offer not taken', { expires_at: null });
      this.notify.offerExpired(reg.player_id, reg.event_id, `offer-expired:${reg.id}:${iso(this.now())}`);
      this.promoteWaitlist(reg.event_id);
    });
  }

  // ---------------------------------------------------- cancellation/refund

  private paidRemaining(regId: string): { payments: Row[]; total: number } {
    const payments = this.db.all(
      `SELECT * FROM payments WHERE registration_id = ? AND status = 'paid' AND amount_paise > refunded_paise ORDER BY paid_at`, regId,
    );
    return { payments, total: payments.reduce((s, p) => s + p.amount_paise - p.refunded_paise, 0) };
  }

  refundQuote(event: Row, reg: Row, forceFull = false): RefundQuote {
    const deadline = event.cancellation_deadline ?? event.starts_at;
    const { total } = this.paidRemaining(reg.id);
    const fullRefund = forceFull || this.now() <= new Date(deadline);
    const refundPaise = fullRefund ? total : Math.floor((total * event.late_refund_percent) / 100);
    return { paidPaise: total, refundPaise, fullRefund, deadline };
  }

  /**
   * Cancels a registration and releases the seat. Refunds follow the event's
   * policy; organiser-initiated cancellations (`fullRefund`) always refund in full.
   */
  cancel(
    eventId: string, playerId: string, actor: Actor,
    opts: { eventCancelled?: boolean; fullRefund?: boolean; reason?: string } = {},
  ): CancelResult {
    return this.db.tx(() => {
      const event = this.event(eventId);
      const reg = this.registration(eventId, playerId);
      if (!event || !reg || !['waitlisted', 'offered', 'held', 'confirmed'].includes(reg.status)) {
        return { kind: 'not_registered' } as const;
      }
      if (actor === 'player' && new Date(event.starts_at) <= this.now()) return { kind: 'too_late' } as const;

      const previous = reg.status;
      const quote = this.refundQuote(event, reg, opts.eventCancelled || opts.fullRefund);
      this.transition(reg, 'cancelled', actor, opts.reason ?? null, {
        cancelled_at: iso(this.now()), cancel_reason: opts.reason ?? `${actor} cancelled`, expires_at: null,
      });
      for (const key of ['hold', 'payrem', 'offer']) this.jobs.cancel(`${key}:${reg.id}`);
      this.cancelOpenPayments(reg.id);

      if (quote.refundPaise > 0) {
        let left = quote.refundPaise;
        for (const pay of this.paidRemaining(reg.id).payments) {
          const amount = Math.min(left, pay.amount_paise - pay.refunded_paise);
          if (amount > 0) this.createRefund(pay, amount, opts.eventCancelled ? 'event_cancelled' : `${actor}_cancelled`, reg);
          left -= amount;
          if (left <= 0) break;
        }
      }
      const note = quote.refundPaise > 0
        ? `A refund of ${rupees(quote.refundPaise)} has been initiated to your original payment method.`
        : quote.paidPaise > 0 ? 'This was after the cancellation deadline, so no refund applies.' : '';
      if (opts.eventCancelled) this.notify.eventCancelled(playerId, eventId, note);
      else this.notify.cancelled(playerId, eventId, note, `cancelled:${reg.id}:${reg.cancelled_at}`);

      if (previous !== 'waitlisted') this.promoteWaitlist(eventId);
      return { kind: 'cancelled', refundPaise: quote.refundPaise, previous } as const;
    });
  }

  private createRefund(pay: Row, amountPaise: number, reason: string, reg: Row): void {
    const remaining = pay.amount_paise - pay.refunded_paise;
    const amount = Math.min(amountPaise, remaining);
    if (amount <= 0) return;
    const id = newId('rfd');
    this.db.run(`UPDATE payments SET refunded_paise = refunded_paise + ? WHERE id = ?`, amount, pay.id);
    pay.refunded_paise += amount;
    this.db.run(
      `INSERT INTO refunds (id, payment_id, amount_paise, status, reason, created_at) VALUES (?, ?, ?, 'pending', ?, ?)`,
      id, pay.id, amount, reason, iso(this.now()),
    );
    this.db.run(
      `INSERT INTO registration_log (registration_id, from_status, to_status, actor, note, at) VALUES (?, ?, ?, 'system', ?, ?)`,
      reg.id, reg.status, reg.status, `refund ${rupees(amount)} (${reason})`, iso(this.now()),
    );
    this.jobs.schedule('issue_refund', { refundId: id }, this.now(), `refund:${id}`);
  }

  private async issueRefund(refundId: string): Promise<void> {
    const r = this.db.get(
      `SELECT rf.*, p.provider_payment_id FROM refunds rf JOIN payments p ON p.id = rf.payment_id WHERE rf.id = ?`, refundId,
    );
    if (!r || r.status !== 'pending' || r.provider_refund_id) return;
    const out = await this.payments.refund({ paymentId: r.provider_payment_id, amountPaise: r.amount_paise, referenceId: r.id });
    this.db.run(`UPDATE refunds SET provider_refund_id = ? WHERE id = ?`, out.refundId, r.id);
    if (out.status === 'processed') this.refundSettled(out.refundId, true);
  }

  private refundSettled(providerRefundId: string, ok: boolean): void {
    this.db.tx(() => {
      const r = this.db.get(
        `SELECT rf.*, reg.player_id, reg.event_id FROM refunds rf JOIN payments p ON p.id = rf.payment_id
         JOIN registrations reg ON reg.id = p.registration_id WHERE rf.provider_refund_id = ?`, providerRefundId,
      );
      if (!r || r.status !== 'pending') return;
      this.db.run(`UPDATE refunds SET status = ?, processed_at = ? WHERE id = ?`, ok ? 'processed' : 'failed', iso(this.now()), r.id);
      if (ok) {
        this.notify.refundUpdate(r.player_id, r.event_id,
          `${rupees(r.amount_paise)} has been refunded. It can take 5–7 working days to reflect in your account.`,
          `refund-done:${r.id}`);
      }
    });
  }

  // ------------------------------------------------------------- attendance

  markAttendance(eventId: string, playerId: string, attendance: 'attended' | 'no_show' | null): Row {
    return this.db.tx(() => {
      const reg = this.registration(eventId, playerId);
      if (!reg || reg.status !== 'confirmed') throw new BookingError('only confirmed players can be marked', 409);
      this.db.run(
        `UPDATE registrations SET attendance = ?, attendance_at = ?, updated_at = ? WHERE id = ?`,
        attendance, attendance ? iso(this.now()) : null, iso(this.now()), reg.id,
      );
      this.db.run(
        `INSERT INTO registration_log (registration_id, from_status, to_status, actor, note, at) VALUES (?, 'confirmed', 'confirmed', 'organiser', ?, ?)`,
        reg.id, `attendance: ${attendance ?? 'cleared'}`, iso(this.now()),
      );
      return this.registration(eventId, playerId)!;
    });
  }

  // ------------------------------------------------------ event lifecycle

  cancelEvent(eventId: string, reason = 'cancelled by organiser'): number {
    return this.db.tx(() => {
      const event = this.event(eventId);
      if (!event) throw new BookingError('event not found', 404);
      if (event.status === 'cancelled' || event.status === 'completed') throw new BookingError(`event is ${event.status}`, 409);
      this.db.run(`UPDATE events SET status = 'cancelled' WHERE id = ?`, eventId);
      this.jobs.cancel(`evrem:${eventId}`);
      this.jobs.cancel(`evdone:${eventId}`);
      const active = this.db.all(
        `SELECT player_id FROM registrations WHERE event_id = ? AND status IN ('waitlisted','offered','held','confirmed')`, eventId,
      );
      for (const r of active) this.cancel(eventId, r.player_id, 'organiser', { eventCancelled: true, reason });
      return active.length;
    });
  }

  private sendReminders(eventId: string): void {
    const event = this.event(eventId);
    if (!event || event.status !== 'open' || new Date(event.starts_at) <= this.now()) return;
    for (const r of this.db.all(`SELECT player_id FROM registrations WHERE event_id = ? AND status = 'confirmed'`, eventId)) {
      this.notify.reminder(r.player_id, eventId);
    }
  }

  private completeEvent(eventId: string): void {
    this.db.run(`UPDATE events SET status = 'completed' WHERE id = ? AND status IN ('open','closed')`, eventId);
  }
}
