/**
 * Load test: 20 communities × 500 members, Monday polls to 6,000 regulars sent
 * through a provider with 150 ms latency, a burst of 3,000 taps, and a seat race.
 * Run: npm run bench
 */
import { mkdirSync, rmSync } from 'node:fs';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { RateLimiter } from '../src/messaging/outbox.ts';
import type { MessagingProvider, SendRequest } from '../src/messaging/types.ts';
import { FakePaymentProvider } from '../src/payments/fake.ts';
import { ManualClock } from '../src/util/clock.ts';
import { newId } from '../src/util/ids.ts';

/** Stand-in for Meta's Cloud API: ~150 ms per request, like a real HTTPS round trip from India. */
class SlowProvider implements MessagingProvider {
  readonly name = 'slow';
  sent = 0;
  constructor(public ms: number) {}
  async send(_r: SendRequest) {
    if (this.ms) await new Promise((r) => setTimeout(r, this.ms));
    this.sent++;
    return { providerMessageId: newId('wamid') };
  }
}

const DB = 'data/bench.db';
mkdirSync('data', { recursive: true });
for (const f of [DB, DB + '-wal', DB + '-shm']) rmSync(f, { force: true });
const clock = new ManualClock('2026-09-21T03:00:00.000Z'); // Mon 08:30 IST
const wa = new SlowProvider(150);
const app = createApp(loadConfig({ databasePath: DB, weeklyInviteCap: 6 }), { clock, messaging: wa, payments: new FakePaymentProvider('http://t', 's') });
const t = () => performance.now();
const ms = (a: number) => `${Math.round(t() - a)} ms`;
const out: Record<string, string> = {};

// 1. 20 communities × 500 members (10,000 players), 3 weekly games each
let a = t();
const communities = [];
for (let c = 0; c < 20; c++) {
  const owner = app.members.upsertPlayer(`9197${String(c).padStart(8, '0')}`, `Owner ${c}`);
  const com = app.members.createCommunity({ name: `Club ${c}`, slug: `club${c}`, status: 'active', ownerId: owner.id, locations: ['Jayanagar', 'HSR Layout'] });
  const v = app.events.createVenue({ community_id: com.id, name: 'Court', area: 'Jayanagar' });
  for (const [wd, hh] of [['wed', '19:00'], ['sat', '07:00'], ['sun', '07:00']]) {
    app.events.createSeries({ community_id: com.id, venue_id: v.id, title: `${wd} game`, weekday: wd, start_time: hh, capacity: 16, price_paise: 35000 });
  }
  app.members.importMembers(com.id, Array.from({ length: 500 }, (_, i) => ({
    phone: `919${String(c).padStart(2, '0')}${String(i).padStart(7, '0')}`, name: `P${c}-${i}`,
    skill_level: 'intermediate', tier: i < 300 ? 'regular' as const : 'guest' as const, opted_in: true, preferred_locations: ['Jayanagar'],
  })));
  communities.push(com);
}
out['Import 10,000 members into 20 communities'] = ms(a);

// 2. Monday 9am: every community's poll fires at once (6,000 regulars)
clock.set('2026-09-21T03:30:00.000Z');
a = t();
let queued = 0;
let lastTick = t(), maxLag = 0;
const lagTimer = setInterval(() => { maxLag = Math.max(maxLag, t() - lastTick - 10); lastTick = t(); }, 10);
for (const c of communities) queued += (await app.polls.run(c.id)).sent;
clearInterval(lagTimer);
out[`Build Monday polls for 20 communities (${queued} messages queued)`] = ms(a);
out['Longest time the server could not answer requests while building polls'] = `${Math.round(maxLag)} ms`;

// 3. Deliver them through the job runner at 150 ms per API call (20 s sample)
a = t();
const deadline = t() + 20_000;
while (t() < deadline && wa.sent < queued) await app.jobs.tick();
const secs = (t() - a) / 1000;
const rate = wa.sent / secs;
out['Send throughput (20s sample)'] = `${wa.sent} sent in ${secs.toFixed(1)}s → ${rate.toFixed(1)} msg/s`;
out[`Time to deliver all ${queued} poll messages at that rate`] = `${Math.round(queued / rate / 60)} min`;

// 4. Inbound burst: 3,000 regulars tap the same game in their community's list
const players = app.db.all(`SELECT p.id, p.phone, m.community_id FROM players p JOIN memberships m ON m.player_id = p.id AND m.tier = 'regular' LIMIT 3000`);
const events = new Map(communities.map((c) => [c.id, app.events.list(c.id)[1].id]));
app.db.run(`UPDATE jobs SET status = 'cancelled' WHERE type = 'send_message' AND status = 'pending'`); // isolate inbound cost
a = t();
app.webhooks.ingestInbound(players.map((p) => ({
  providerMessageId: newId('wamid'), from: p.phone, timestamp: clock.now().toISOString(), type: 'reply' as const,
  payload: `avail:${events.get(p.community_id)}`,
})));
out['Ingest 3,000 inbound taps (webhook → stored)'] = ms(a);
wa.ms = 0;
(app.outbox as any).limiter = new RateLimiter(0); // measure tap handling itself, not Meta's send rate
a = t();
await app.jobs.drain(1000);
out['Process 3,000 taps (RSVP, holds, waitlist, replies)'] = `${ms(a)} → ${(3000 / ((t() - a) / 1000)).toFixed(0)} taps/s`;

// 5. Correctness under contention: ~150 players raced for each 16-seat game
const ids = [...events.values()];
const seats = app.db.all(
  `SELECT e.id, e.capacity, SUM(r.status IN ('held','confirmed','offered')) AS taken FROM events e
   LEFT JOIN registrations r ON r.event_id = e.id WHERE e.id IN (${ids.map(() => '?').join(',')}) GROUP BY e.id`, ...ids);
out['Overbooked games after the burst'] = `${seats.filter((s) => s.taken > s.capacity).length} of ${seats.length} (each 16 seats, ~150 takers)`;

// 6. Organiser screens at this size
a = t(); app.events.candidates(ids[0]); out['Rank fill candidates (500-member community)'] = ms(a);
a = t(); app.members.listMembers(communities[0].id); out['Members list with stats (500 members)'] = ms(a);
a = t(); app.events.detail(ids[0]); out['Game detail'] = ms(a);

console.log(JSON.stringify(out, null, 2));
app.db.close();
