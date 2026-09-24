import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PollActions } from '../src/domain/polls.ts';
import { harness, reg } from './helpers.ts';

const R1 = '919811000001', R2 = '919811000002', R3 = '919811000003', G1 = '919822000001', G2 = '919822000002';

// Sunday 20 Sep 2026, 20:00 IST — the next poll is Monday 09:00 IST.
const SUNDAY_NIGHT = '2026-09-20T14:30:00.000Z';

async function setup() {
  const h = await harness(SUNDAY_NIGHT);
  const ids = {
    r1: h.member(R1, 'Rahul'), r2: h.member(R2, 'Priya'), r3: h.member(R3, 'Arjun', { optedIn: false }),
    g1: h.member(G1, 'Sneha', { tier: 'guest', slots: ['saturday_morning'] }),
    g2: h.member(G2, 'Karthik', { tier: 'guest', skill: 'beginner' }),
  };
  const series = h.app.events.createSeries({
    community_id: h.community.id, venue_id: h.venue.id, title: 'Saturday Morning Open', weekday: 'sat', start_time: '07:00',
    capacity: 4, skill_level: 'intermediate', price_paise: 30000,
  });
  h.app.events.createSeries({
    community_id: h.community.id, venue_id: h.venue.id, title: 'Wednesday Night', weekday: 'wed', start_time: '19:00',
    capacity: 4, price_paise: 0,
  });
  return { h, ids, series };
}

test('polls are scheduled for Monday and Wednesday 9am IST', async () => {
  const { h } = await setup();
  const at = h.app.polls.scheduleNext(h.community.id)!;
  assert.equal(at.toISOString(), '2026-09-21T03:30:00.000Z'); // Mon 09:00 IST
  h.clock.set(at);
  await h.app.jobs.drain();
  const next = h.app.db.get(`SELECT run_at FROM jobs WHERE unique_key = ? AND status = 'pending'`, `poll:${h.community.id}`)!;
  assert.equal(next.run_at, '2026-09-23T03:30:00.000Z'); // Wed 09:00 IST
});

test('Monday poll → members mark availability → organiser fills the rest', async () => {
  const { h, ids } = await setup();
  h.app.polls.scheduleNext(h.community.id);
  h.clock.set('2026-09-21T03:30:00.000Z');
  await h.app.jobs.drain();

  // Series generated this week's games.
  const games = h.app.events.list(h.community.id);
  assert.deepEqual(games.map((g) => g.title), ['Wednesday Night', 'Saturday Morning Open']);
  const [wed, sat] = games;

  // Regulars with consent got the poll as a template (their window is closed); guests and non-consenting did not.
  const poll = h.last(R1);
  assert.equal(poll.name, 'dinqo_availability_poll');
  assert.match(poll.params[2], /Wednesday Night; .*Saturday Morning Open/);
  assert.equal(h.sent(R3).length, 0, 'no consent → no poll');
  assert.equal(h.sent(G1).length, 0, 'guests are not polled');
  const [pollRow] = h.app.polls.list(h.community.id);
  assert.equal(pollRow.awaiting, 2);
  assert.equal(pollRow.skipped, 1);

  // Rahul opens the list and picks Saturday (paid) then Wednesday (free).
  await h.tap(R1, poll.buttonPayloads[0]);
  const list = h.last(R1);
  assert.equal(list.kind, 'list');
  assert.deepEqual(list.rows.map((r: any) => r.id), [PollActions.pick(wed.id), PollActions.pick(sat.id), PollActions.noneThisWeek]);
  await h.tap(R1, PollActions.pick(sat.id));
  assert.equal(reg(h, sat.id, ids.r1).status, 'held');
  await h.payLatestLink(R1);
  assert.equal(reg(h, sat.id, ids.r1).status, 'confirmed');
  await h.tap(R1, PollActions.pick(wed.id));
  assert.equal(reg(h, wed.id, ids.r1).status, 'confirmed');

  // Priya can't make it this week.
  await h.tap(R2, PollActions.none(pollRow.id));
  assert.match(h.last(R2).text, /Thanks for letting us know/);
  assert.equal(h.app.polls.pendingFor(ids.r2, h.community.id).length, 0);

  // Organiser fills Saturday's 3 open slots: guests ranked by fit (Sneha prefers Sat mornings).
  const cands = h.app.events.candidates(sat.id);
  assert.deepEqual(cands.map((c) => c.player_id), [ids.g1, ids.g2]);
  assert.ok(cands[0].score > cands[1].score);
  const filled = h.app.events.fill(sat.id);
  assert.equal(filled.open_slots, 3);
  assert.deepEqual(filled.invited.map((i) => i.status), ['sent', 'sent']);
  await h.app.jobs.drain();
  assert.equal(h.last(G1).name, 'dinqo_game_invite');

  // Guest accepts the invite and books the invite-only game.
  await h.tap(G1, h.last(G1).buttonPayloads[0]);
  assert.equal(reg(h, sat.id, ids.g1).status, 'held');

  // Wednesday's poll only nudges people with unanswered games: nobody here.
  h.clock.set('2026-09-23T03:30:00.000Z');
  await h.app.jobs.drain();
  const wedPoll = h.app.polls.list(h.community.id)[0];
  assert.notEqual(wedPoll.id, pollRow.id);
  assert.equal(wedPoll.awaiting, 0);
});

test('an unanswered regular can be nudged by fill; a guest cannot self-book an uninvited game', async () => {
  const { h, ids } = await setup();
  h.clock.set('2026-09-21T03:30:00.000Z');
  await h.app.polls.run(h.community.id);
  const sat = h.app.events.list(h.community.id).find((g) => g.title === 'Saturday Morning Open')!;

  await h.tap(G2, PollActions.pick(sat.id));
  assert.match(h.last(G2).text, /invite-only/);

  const cands = h.app.events.candidates(sat.id).map((c) => c.player_id);
  assert.ok(cands.includes(ids.r2), 'Priya never answered the poll');
  const out = h.app.events.invite(sat.id, [ids.r2]);
  assert.equal(out[0].status, 'sent');
});

test('the weekly marketing cap stops over-messaging', async () => {
  const { h, ids } = await setup();
  h.clock.set('2026-09-21T03:30:00.000Z');
  const events = Array.from({ length: 7 }, (_, i) => h.event({ title: `Game ${i}` }));
  const outcomes = events.map((e) => h.app.events.invite(e.id, [ids.g1])[0]);
  assert.equal(outcomes.filter((o) => o.status === 'sent').length, 6);
  assert.deepEqual(outcomes.at(-1), { player_id: ids.g1, status: 'skipped', reason: 'frequency_cap' });
});
