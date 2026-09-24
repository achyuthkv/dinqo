import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Actions } from '../src/messaging/notify.ts';
import { harness, reg } from './helpers.ts';

const A = '919800000001', B = '919800000002', C = '919800000003';

test('invite-only: uninvited members cannot book; invited ones hold, pay and confirm', async () => {
  const h = await harness();
  const a = h.member(A, 'Asha', { tier: 'guest' });
  const e = h.event();

  await h.say(A, 'hi'); // opens the 24h window
  await h.tap(A, Actions.rsvpYes(e.id));
  assert.match(h.last(A).text, /invite-only/);
  assert.equal(reg(h, e.id, a), undefined);

  const out = h.app.events.invite(e.id, [a]);
  assert.equal(out[0].status, 'sent');
  await h.app.jobs.drain();
  assert.equal(h.last(A).kind, 'buttons');
  assert.match(h.last(A).text, /invited you to play/);

  await h.tap(A, Actions.rsvpYes(e.id));
  assert.equal(reg(h, e.id, a).status, 'held');
  const link = h.last(A);
  assert.equal(link.kind, 'cta_url');
  assert.match(link.label, /Pay ₹350/);

  await h.payLatestLink(A);
  assert.equal(reg(h, e.id, a).status, 'confirmed');
  assert.match(h.last(A).text, /You're confirmed ✅/);

  // Replayed payment webhook with the same event id is ignored.
  const before = h.sent(A).length;
  const dup = h.app.db.get(`SELECT payload FROM webhook_events WHERE provider = 'fake'`)!;
  const parsed = JSON.parse(dup.payload);
  h.app.booking.handlePaymentEvent(parsed);
  await h.app.jobs.drain();
  assert.equal(h.sent(A).length, before);
  assert.equal(h.app.db.get('SELECT COUNT(*) AS n FROM refunds')!.n, 0);
});

test('outside the 24h window lifecycle messages go out as approved templates', async () => {
  const h = await harness();
  const a = h.member(A, 'Asha');
  const e = h.event();
  h.app.events.invite(e.id, [a]);
  await h.app.jobs.drain();
  const m = h.last(A);
  assert.equal(m.type, 'template');
  assert.equal(m.name, 'dinqo_game_invite');
  assert.deepEqual(m.buttonPayloads, [Actions.rsvpYes(e.id), Actions.rsvpNo(e.id)]);
});

test('free games confirm immediately', async () => {
  const h = await harness();
  const a = h.member(A, 'Asha');
  const e = h.event({ price_paise: 0, visibility: 'members' });
  await h.tap(A, Actions.rsvpYes(e.id));
  assert.equal(reg(h, e.id, a).status, 'confirmed');
});

test('an unpaid hold expires, the seat goes to the waitlist, and a late payment is refunded', async () => {
  const h = await harness();
  const a = h.member(A, 'Asha');
  const b = h.member(B, 'Bala');
  const e = h.event({ capacity: 1, visibility: 'members', hold_minutes: 30 });

  await h.tap(A, Actions.rsvpYes(e.id));
  assert.equal(reg(h, e.id, a).status, 'held');
  await h.tap(B, Actions.rsvpYes(e.id));
  assert.match(h.last(B).text, /is full right now/);
  await h.tap(B, Actions.waitlistJoin(e.id));
  assert.equal(reg(h, e.id, b).status, 'waitlisted');
  assert.match(h.last(B).text, /#1\* on the waitlist/);

  await h.advance(15);
  assert.match(h.last(A).text, /is held until/, 'payment reminder at the hold midpoint');

  await h.advance(16);
  assert.equal(reg(h, e.id, a).status, 'expired');
  assert.match(h.last(A).text, /was released/);
  assert.equal(reg(h, e.id, b).status, 'offered');
  assert.match(h.last(B).text, /A spot just opened up/);

  await h.tap(B, Actions.offerYes(e.id));
  assert.equal(reg(h, e.id, b).status, 'held');
  await h.payLatestLink(B);
  assert.equal(reg(h, e.id, b).status, 'confirmed');

  // Asha pays her old link after all: game is full, so she is refunded in full.
  await h.payLatestLink(A);
  assert.equal(reg(h, e.id, a).status, 'expired');
  const refund = h.app.db.get('SELECT * FROM refunds')!;
  assert.equal(refund.amount_paise, 35000);
  assert.equal(refund.reason, 'late_payment');
  assert.equal(refund.status, 'processed');
  assert.equal(h.pay.refunds.length, 1);
});

test('a late payment is honoured when a seat is still free', async () => {
  const h = await harness();
  const a = h.member(A, 'Asha');
  const e = h.event({ capacity: 2, visibility: 'members' });
  await h.tap(A, Actions.rsvpYes(e.id));
  await h.advance(31);
  assert.equal(reg(h, e.id, a).status, 'expired');
  await h.payLatestLink(A);
  assert.equal(reg(h, e.id, a).status, 'confirmed');
  assert.equal(h.app.db.get('SELECT COUNT(*) AS n FROM refunds')!.n, 0);
});

test('waitlist offers expire and pass to the next person', async () => {
  const h = await harness();
  const a = h.member(A, 'Asha'), b = h.member(B, 'Bala'), c = h.member(C, 'Chitra');
  const e = h.event({ capacity: 1, visibility: 'members', price_paise: 0, offer_minutes: 60 });
  await h.tap(A, Actions.rsvpYes(e.id));
  await h.tap(B, Actions.waitlistJoin(e.id));
  await h.tap(C, Actions.waitlistJoin(e.id));
  assert.equal(h.app.booking.waitlistPosition(e.id, c), 2);

  await h.tap(A, Actions.cancelConfirm(e.id));
  assert.equal(reg(h, e.id, a).status, 'cancelled');
  assert.equal(reg(h, e.id, b).status, 'offered');

  await h.advance(61);
  assert.equal(reg(h, e.id, b).status, 'expired');
  assert.equal(reg(h, e.id, c).status, 'offered');
  await h.tap(C, Actions.offerYes(e.id));
  assert.equal(reg(h, e.id, c).status, 'confirmed');
});

test('cancellation refunds follow the policy: full before the deadline, partial after', async () => {
  const h = await harness();
  const a = h.member(A, 'Asha'), b = h.member(B, 'Bala');
  const e = h.event({ visibility: 'members', late_refund_percent: 50 });
  for (const p of [A, B]) { await h.tap(p, Actions.rsvpYes(e.id)); await h.payLatestLink(p); }

  await h.tap(A, Actions.cancelAsk(e.id));
  assert.match(h.last(A).text, /full refund of ₹350/);
  await h.tap(A, Actions.cancelConfirm(e.id));
  assert.equal(reg(h, e.id, a).status, 'cancelled');

  h.clock.set(new Date(new Date(e.cancellation_deadline).getTime() + 60_000));
  await h.tap(B, Actions.cancelAsk(e.id));
  assert.match(h.last(B).text, /₹175 back of ₹350/);
  await h.tap(B, Actions.cancelConfirm(e.id));

  const refunds = h.app.db.all('SELECT rf.amount_paise, rf.status, r.player_id FROM refunds rf JOIN payments p ON p.id = rf.payment_id JOIN registrations r ON r.id = p.registration_id ORDER BY rf.created_at');
  assert.deepEqual(refunds.map((r) => [r.player_id, r.amount_paise, r.status]), [[a, 35000, 'processed'], [b, 17500, 'processed']]);
  assert.ok(h.sent(B).some((m) => /₹175 has been refunded/.test(m.text ?? '')));
});

test('players cannot cancel after the game starts; organiser can', async () => {
  const h = await harness();
  const a = h.member(A, 'Asha');
  const e = h.event({ visibility: 'members', price_paise: 0 });
  await h.tap(A, Actions.rsvpYes(e.id));
  h.clock.set(new Date(new Date(e.starts_at).getTime() + 60_000));
  await h.tap(A, Actions.cancelConfirm(e.id));
  assert.match(h.last(A).text, /already started/);
  assert.equal(h.app.booking.cancel(e.id, a, 'organiser').kind, 'cancelled');
});

test('refund failures are retried by the job queue', async () => {
  const h = await harness();
  h.member(A, 'Asha');
  const e = h.event({ visibility: 'members' });
  await h.tap(A, Actions.rsvpYes(e.id));
  await h.payLatestLink(A);
  h.pay.failNextRefund = true;
  await h.tap(A, Actions.cancelConfirm(e.id));
  assert.equal(h.app.db.get('SELECT status FROM refunds')!.status, 'pending');
  await h.advance(3);
  assert.equal(h.app.db.get('SELECT status FROM refunds')!.status, 'processed');
});

test('cancelling an event refunds everyone in full and notifies them', async () => {
  const h = await harness();
  const a = h.member(A, 'Asha'), b = h.member(B, 'Bala');
  const e = h.event({ visibility: 'members', capacity: 1 });
  await h.tap(A, Actions.rsvpYes(e.id));
  await h.payLatestLink(A);
  await h.tap(B, Actions.waitlistJoin(e.id));
  h.clock.set(new Date(new Date(e.cancellation_deadline).getTime() + 60_000)); // even after the deadline
  assert.equal(h.app.booking.cancelEvent(e.id), 2);
  await h.app.jobs.drain();
  assert.equal(reg(h, e.id, a).status, 'cancelled');
  assert.equal(reg(h, e.id, b).status, 'cancelled');
  assert.equal(h.app.db.get('SELECT amount_paise FROM refunds')!.amount_paise, 35000);
  assert.ok(h.sent(A).some((m) => m.name === 'dinqo_event_cancelled' && /full refund|refund of ₹350/.test(m.params[2])));
});

test('a seat is never double-allocated', async () => {
  const h = await harness();
  const a = h.member(A, 'Asha'), b = h.member(B, 'Bala');
  const e = h.event({ visibility: 'members', capacity: 1 });
  const r1 = h.app.booking.rsvp(e.id, a);
  const r2 = h.app.booking.rsvp(e.id, b);
  assert.equal(r1.kind, 'held');
  assert.equal(r2.kind, 'full');
  assert.equal(h.app.booking.seatsTaken(e.id), 1);
});

test('reminders go to confirmed players before the game', async () => {
  const h = await harness();
  h.member(A, 'Asha');
  const e = h.event({ visibility: 'members', price_paise: 0, reminder_hours_before: 12 });
  await h.tap(A, Actions.rsvpYes(e.id));
  h.clock.set(new Date(new Date(e.starts_at).getTime() - 12 * 3600_000 + 1000));
  await h.app.jobs.drain();
  const m = h.last(A);
  assert.equal(m.type, 'template', 'window closed by now → template');
  assert.equal(m.name, 'dinqo_event_reminder');
});

test('attendance and member history', async () => {
  const h = await harness();
  const a = h.member(A, 'Asha');
  const e1 = h.event({ visibility: 'members' });
  const e2 = h.event({ visibility: 'members', starts_at: new Date(new Date(e1.starts_at).getTime() + 86400_000).toISOString(), ends_at: new Date(new Date(e1.ends_at).getTime() + 86400_000).toISOString() });
  for (const e of [e1, e2]) { await h.tap(A, Actions.rsvpYes(e.id)); await h.payLatestLink(A); }
  assert.throws(() => h.app.booking.markAttendance(e1.id, 'ply_nobody', 'attended'));
  h.app.booking.markAttendance(e1.id, a, 'attended');
  h.app.booking.markAttendance(e2.id, a, 'no_show');
  h.clock.set(new Date(new Date(e2.ends_at).getTime() + 1000));
  await h.app.jobs.drain();

  const { stats, events } = (await import('../src/domain/history.ts')).memberHistory(h.app.db, h.clock, a, h.community.id);
  assert.equal(stats.played, 1);
  assert.equal(stats.no_shows, 1);
  assert.equal(stats.attendance_rate, 0.5);
  assert.equal(stats.total_paid_paise, 70000);
  assert.equal(events.length, 2);
  assert.equal(h.app.booking.event(e1.id)!.status, 'completed');

  await h.say(A, 'history');
  assert.match(h.last(A).text, /Games played: \*1\*/);
  assert.match(h.last(A).text, /Attendance: 50%/);
});
