import { Bot } from './bot/router.ts';
import type { Config } from './config.ts';
import { Db } from './db/index.ts';
import { Booking } from './domain/booking.ts';
import { Events } from './domain/events.ts';
import { Members } from './domain/members.ts';
import { Polls } from './domain/polls.ts';
import { Jobs } from './jobs/queue.ts';
import { ConsoleProvider } from './messaging/console-provider.ts';
import { Notifier } from './messaging/notify.ts';
import { Outbox } from './messaging/outbox.ts';
import type { InboundMessage, MessagingProvider, StatusUpdate } from './messaging/types.ts';
import { parseCloudWebhook, verifyMetaSignature, WhatsAppCloudProvider } from './messaging/whatsapp-cloud.ts';
import { FakePaymentProvider } from './payments/fake.ts';
import { RazorpayProvider } from './payments/razorpay.ts';
import type { PaymentProvider } from './payments/types.ts';
import { type Clock, iso, systemClock } from './util/clock.ts';
import { newId } from './util/ids.ts';

export interface AppDeps {
  clock?: Clock;
  messaging?: MessagingProvider;
  payments?: PaymentProvider;
}

export type App = ReturnType<typeof createApp>;

const STATUS_RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3 };

export function createApp(config: Config, deps: AppDeps = {}) {
  const clock = deps.clock ?? systemClock;
  const db = new Db(config.databasePath);
  db.migrate();

  const messaging = deps.messaging ?? (config.whatsapp.provider === 'cloud'
    ? new WhatsAppCloudProvider(config.whatsapp)
    : new ConsoleProvider(true));
  const payments = deps.payments ?? (config.payments.provider === 'razorpay'
    ? new RazorpayProvider(config.payments)
    : new FakePaymentProvider(config.baseUrl, config.payments.webhookSecret));

  const jobs = new Jobs(db, clock);
  const outbox = new Outbox(db, jobs, clock, messaging, {
    weeklyInviteCap: config.weeklyInviteCap, templateLanguage: config.whatsapp.templateLanguage,
  });
  const notify = new Notifier(db, outbox);
  const members = new Members(db, clock, config.consentPolicyVersion);
  const booking = new Booking(db, clock, jobs, notify, payments);
  const events = new Events(db, clock, jobs, booking, notify);
  const polls = new Polls(db, clock, jobs, outbox, events, booking);
  const bot = new Bot(db, clock, members, booking, polls, outbox);

  /** Persist once per provider event id; returns false for duplicates. */
  function recordWebhook(provider: string, providerEventId: string, payload: unknown): string | null {
    const id = newId('whk');
    const r = db.run(
      `INSERT OR IGNORE INTO webhook_events (id, provider, provider_event_id, payload, received_at) VALUES (?, ?, ?, ?, ?)`,
      id, provider, providerEventId, JSON.stringify(payload), iso(clock.now()),
    );
    return r.changes ? id : null;
  }

  function markProcessed(webhookId: string, error?: unknown) {
    db.run(`UPDATE webhook_events SET processed_at = ?, error = ? WHERE id = ?`,
      iso(clock.now()), error ? String((error as Error).message ?? error) : null, webhookId);
  }

  jobs.on('process_inbound', (p) => {
    const row = db.get('SELECT payload FROM webhook_events WHERE id = ?', p.webhookId)!;
    try {
      bot.handle(JSON.parse(row.payload) as InboundMessage);
      markProcessed(p.webhookId);
    } catch (e) {
      markProcessed(p.webhookId, e);
      throw e;
    }
  });

  jobs.on('process_payment_event', (p) => {
    const row = db.get('SELECT payload FROM webhook_events WHERE id = ?', p.webhookId)!;
    try {
      booking.handlePaymentEvent(JSON.parse(row.payload));
      markProcessed(p.webhookId);
    } catch (e) {
      markProcessed(p.webhookId, e);
      throw e;
    }
  });

  function applyStatus(s: StatusUpdate) {
    const m = db.get('SELECT id, status FROM messages WHERE provider_message_id = ?', s.providerMessageId);
    if (!m) return;
    // Statuses can arrive out of order; never move backwards (failed always wins).
    if (s.status !== 'failed' && (STATUS_RANK[s.status] ?? 0) <= (STATUS_RANK[m.status] ?? 99)) return;
    db.run(`UPDATE messages SET status = ?, error = COALESCE(?, error), updated_at = ? WHERE id = ?`,
      s.status, s.error ?? null, iso(clock.now()), m.id);
  }

  const webhooks = {
    /** Queue inbound messages for async processing (Meta expects a fast 200). */
    ingestInbound(messages: InboundMessage[], statuses: StatusUpdate[] = []): number {
      let queued = 0;
      for (const m of messages) {
        const id = recordWebhook('whatsapp', m.providerMessageId, m);
        if (id) { jobs.schedule('process_inbound', { webhookId: id }); queued++; }
      }
      statuses.forEach(applyStatus);
      return queued;
    },

    whatsapp(rawBody: Buffer, signature: string | undefined): { ok: boolean; status: number } {
      if (config.whatsapp.appSecret && !verifyMetaSignature(rawBody, signature, config.whatsapp.appSecret)) {
        return { ok: false, status: 401 };
      }
      if (!config.whatsapp.appSecret && config.whatsapp.provider === 'cloud') return { ok: false, status: 500 };
      let body: unknown;
      try { body = JSON.parse(rawBody.toString('utf8')); } catch { return { ok: false, status: 400 }; }
      const { messages, statuses } = parseCloudWebhook(body);
      this.ingestInbound(messages, statuses);
      return { ok: true, status: 200 };
    },

    payment(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): { ok: boolean; status: number } {
      let evs;
      try { evs = payments.parseWebhook(rawBody, headers); } catch { return { ok: false, status: 401 }; }
      for (const ev of evs) {
        const id = recordWebhook(payments.name, ev.eventId, ev);
        if (id) jobs.schedule('process_payment_event', { webhookId: id });
      }
      return { ok: true, status: 200 };
    },
  };

  /** Keep every community's next availability poll scheduled, and refresh series daily. */
  jobs.on('daily_maintenance', () => {
    for (const c of members.communities()) {
      events.generateFromSeries(c.id, c.poll_horizon_days);
      polls.scheduleNext(c.id);
    }
    const next = new Date(clock.now().getTime() + 24 * 3600_000);
    jobs.schedule('daily_maintenance', {}, next, 'daily_maintenance');
  });

  function boot() {
    jobs.schedule('daily_maintenance', {}, clock.now(), 'daily_maintenance');
  }

  return { config, clock, db, jobs, outbox, notify, members, booking, events, polls, bot, webhooks, messaging, payments, boot };
}
