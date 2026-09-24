import { createApp, type App } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { ConsoleProvider } from '../src/messaging/console-provider.ts';
import { FakePaymentProvider } from '../src/payments/fake.ts';
import { ManualClock } from '../src/util/clock.ts';
import { newId } from '../src/util/ids.ts';

export interface Harness {
  app: App;
  clock: ManualClock;
  wa: ConsoleProvider;
  pay: FakePaymentProvider;
  /** Player sends a text or taps a button; all resulting jobs run. */
  say(phone: string, text: string, name?: string): Promise<void>;
  tap(phone: string, payload: string): Promise<void>;
  /** Advance the clock and run whatever became due. */
  advance(minutes: number): Promise<void>;
  /** Outbound messages the provider actually sent to this phone. */
  sent(phone: string): any[];
  last(phone: string): any;
  payLatestLink(phone: string, opts?: { amountPaise?: number }): Promise<string>;
  community: any;
  venue: any;
  member(phone: string, name: string, opts?: { tier?: 'regular' | 'guest'; skill?: string; optedIn?: boolean; slots?: string[] }): string;
  event(overrides?: Record<string, any>): any;
}

// Sunday 20 Sep 2026, 09:00 IST
export const START = '2026-09-20T03:30:00.000Z';

export async function harness(start = START): Promise<Harness> {
  const clock = new ManualClock(start);
  const wa = new ConsoleProvider();
  const pay = new FakePaymentProvider('http://test', 'whsec');
  const app = createApp(
    loadConfig({ databasePath: ':memory:', payments: { webhookSecret: 'whsec' } as any, weeklyInviteCap: 6 }),
    { clock, messaging: wa, payments: pay },
  );
  const community = app.members.createCommunity({ name: 'Dink Over Coffee', slug: 'doc', status: 'active', locations: ['Jayanagar', 'HSR Layout'] });
  const venue = app.events.createVenue({ community_id: community.id, name: 'Play Mania', area: 'Jayanagar' });

  const inbound = async (phone: string, m: { text?: string; payload?: string; name?: string }) => {
    app.webhooks.ingestInbound([{
      providerMessageId: newId('wamid'), from: phone, profileName: m.name, timestamp: clock.now().toISOString(),
      type: m.payload ? 'reply' : 'text', text: m.text, payload: m.payload,
    }]);
    await app.jobs.drain();
  };
  const sent = (phone: string) => wa.sent.filter((s) => s.to === phone).map((s) => ({ type: s.form.type, ...(s.form.message as any) }));

  const h: Harness = {
    app, clock, wa, pay, community, venue,
    say: (phone, text, name) => inbound(phone, { text, name }),
    tap: (phone, payload) => inbound(phone, { payload }),
    async advance(minutes) { clock.advanceMinutes(minutes); await app.jobs.drain(); },
    sent,
    last: (phone) => sent(phone).at(-1),
    async payLatestLink(phone, opts = {}) {
      const msg = [...sent(phone)].reverse().find((m) => m.kind === 'cta_url' || m.name === 'dinqo_payment_pending');
      if (!msg) throw new Error(`no payment link sent to ${phone}`);
      const url: string = msg.url ?? msg.params[4];
      const linkId = url.split('/').pop()!;
      const { body, headers } = pay.paidWebhook(linkId, opts.amountPaise);
      const r = app.webhooks.payment(body, headers);
      if (!r.ok) throw new Error('payment webhook rejected');
      await app.jobs.drain();
      return linkId;
    },
    member(phone, name, opts = {}) {
      app.members.importMembers(community.id, [{
        phone, name, tier: opts.tier ?? 'regular', skill_level: opts.skill ?? 'intermediate',
        opted_in: opts.optedIn ?? true, preferred_locations: ['Jayanagar'],
      }]);
      const p = app.members.playerByPhone(phone)!;
      if (opts.slots) app.members.updateProfile(p.id, { preferred_slots: opts.slots });
      return p.id;
    },
    event(overrides = {}) {
      const starts = new Date(clock.now().getTime() + 3 * 24 * 3600_000);
      return app.events.create({
        community_id: community.id, venue_id: venue.id, title: 'Sunday Community Play',
        starts_at: starts.toISOString(), ends_at: new Date(starts.getTime() + 2 * 3600_000).toISOString(),
        capacity: 4, skill_level: 'intermediate', price_paise: 35000,
        cancellation_deadline: new Date(starts.getTime() - 24 * 3600_000).toISOString(),
        ...overrides,
      });
    },
  };
  return h;
}

export const reg = (h: Harness, eventId: string, playerId: string): any =>
  h.app.db.get('SELECT * FROM registrations WHERE event_id = ? AND player_id = ?', eventId, playerId);
