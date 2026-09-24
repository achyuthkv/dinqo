import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import type { App } from '../app.ts';
import { BookingError } from '../domain/booking.ts';
import { memberHistory } from '../domain/history.ts';
import { TIERS, type ImportRow } from '../domain/members.ts';
import { TEMPLATES } from '../messaging/templates.ts';
import { FakePaymentProvider } from '../payments/fake.ts';
import { iso } from '../util/clock.ts';
import { normalisePhone, rupees } from '../util/format.ts';
import { newId } from '../util/ids.ts';

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  raw: Buffer;
  body: any;
}
type Handler = (ctx: Ctx) => unknown | Promise<unknown>;
interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler; auth: boolean }

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const MAX_BODY = 2 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json') {
  if (res.headersSent) return;
  const payload = type === 'application/json' ? JSON.stringify(body) : String(body);
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
  res.end(payload);
}

/** Minimal CSV → rows (header row required: phone,name,skill_level,tier,opted_in,preferred_locations). */
export function parseCsv(text: string): ImportRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const split = (l: string) => {
    const out: string[] = []; let cur = ''; let q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const header = split(lines[0]).map((h) => h.toLowerCase());
  return lines.slice(1).map((l) => {
    const cells = split(l);
    const get = (k: string) => cells[header.indexOf(k)] ?? '';
    return {
      phone: get('phone'),
      name: get('name') || undefined,
      skill_level: get('skill_level').toLowerCase() || undefined,
      tier: (get('tier').toLowerCase() || undefined) as ImportRow['tier'],
      opted_in: ['yes', 'true', '1', 'y'].includes(get('opted_in').toLowerCase()),
      preferred_locations: get('preferred_locations') ? get('preferred_locations').split(/[;|]/).map((s) => s.trim()).filter(Boolean) : undefined,
    };
  });
}

export function buildServer(app: App) {
  const routes: Route[] = [];
  const add = (method: string, path: string, handler: Handler, auth = true) => {
    const keys: string[] = [];
    const pattern = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, pattern, keys, handler, auth });
  };
  const { config } = app;
  const need = <T>(v: T, what: string): NonNullable<T> => {
    if (v === undefined || v === null) throw new HttpError(404, `${what} not found`);
    return v;
  };
  const community = (id: string) => need(app.members.community(id), 'community');

  // ------------------------------------------------------------- public

  add('GET', '/health', () => ({ ok: true, time: iso(app.clock.now()) }), false);
  add('GET', '/', ({ res }) => { res.writeHead(302, { Location: '/admin' }); res.end(); }, false);
  add('GET', '/admin', ({ res }) => send(res, 200, readFileSync(new URL('../../public/admin.html', import.meta.url)), 'text/html'), false);

  // ----------------------------------------------------------- webhooks

  add('GET', '/webhooks/whatsapp', ({ query, res }) => {
    if (query.get('hub.mode') === 'subscribe' && query.get('hub.verify_token') === config.whatsapp.verifyToken) {
      return send(res, 200, query.get('hub.challenge') ?? '', 'text/plain');
    }
    send(res, 403, { error: 'verification failed' });
  }, false);

  add('POST', '/webhooks/whatsapp', ({ req, raw, res }) => {
    const r = app.webhooks.whatsapp(raw, req.headers['x-hub-signature-256'] as string | undefined);
    send(res, r.status, { ok: r.ok });
  }, false);

  add('POST', '/webhooks/payments', ({ req, raw, res }) => {
    const r = app.webhooks.payment(raw, req.headers);
    send(res, r.status, { ok: r.ok });
  }, false);

  // -------------------------------------------------------- communities

  add('GET', '/api/communities', () => app.members.communities());
  add('POST', '/api/communities', ({ body }) => {
    if (!body?.name || !body?.slug) throw new HttpError(400, 'name and slug are required');
    const c = app.members.createCommunity(body);
    app.polls.scheduleNext(c.id);
    return c;
  });
  add('GET', '/api/communities/:id', ({ params }) => community(params.id));

  add('GET', '/api/communities/:id/dashboard', ({ params }) => {
    community(params.id);
    const now = iso(app.clock.now());
    const upcoming = app.events.list(params.id, { from: now }).filter((e) => e.status === 'open');
    const members = app.members.listMembers(params.id);
    const monthAgo = iso(new Date(app.clock.now().getTime() - 30 * 86400_000));
    const past = app.events.list(params.id, { from: monthAgo, to: now });
    const marked = past.reduce((s, e) => s + e.attended + e.no_shows, 0);
    const revenue = app.db.get(
      `SELECT COALESCE(SUM(p.amount_paise - p.refunded_paise), 0) AS net FROM payments p
       JOIN registrations r ON r.id = p.registration_id JOIN events e ON e.id = r.event_id
       WHERE e.community_id = ? AND p.status = 'paid' AND p.paid_at >= ?`, params.id, monthAgo,
    )!;
    const pendingRefunds = app.db.get(
      `SELECT COUNT(*) AS n FROM refunds rf JOIN payments p ON p.id = rf.payment_id JOIN registrations r ON r.id = p.registration_id
       JOIN events e ON e.id = r.event_id WHERE e.community_id = ? AND rf.status != 'processed'`, params.id,
    )!;
    const nextPoll = app.db.get(`SELECT run_at FROM jobs WHERE unique_key = ? AND status = 'pending'`, `poll:${params.id}`);
    return {
      members: members.length,
      regulars: members.filter((m) => m.tier === 'regular').length,
      invites_ok: members.filter((m) => m.invites_ok).length,
      upcoming,
      games_last_30_days: past.length,
      attendance_rate_30d: marked ? Math.round((past.reduce((s, e) => s + e.attended, 0) / marked) * 100) : null,
      net_revenue_30d_paise: revenue.net,
      net_revenue_30d: rupees(revenue.net),
      refunds_needing_attention: pendingRefunds.n,
      next_poll_at: nextPoll?.run_at ?? null,
      latest_polls: app.polls.list(params.id, 3),
    };
  });

  // --------------------------------------------------------- availability polls

  add('PATCH', '/api/communities/:id/poll-settings', ({ params, body }) => {
    community(params.id);
    if (body.poll_days && (!Array.isArray(body.poll_days) || body.poll_days.some((d: string) => !['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].includes(d)))) {
      throw new HttpError(400, 'poll_days must be an array like ["mon","wed"]');
    }
    if (body.poll_time && !/^\d{1,2}:\d{2}$/.test(body.poll_time)) throw new HttpError(400, 'poll_time must be HH:MM');
    return app.polls.updateSettings(params.id, body);
  });
  add('GET', '/api/communities/:id/polls', ({ params }) => app.polls.list(community(params.id).id));
  add('POST', '/api/communities/:id/polls/run', ({ params }) => app.polls.run(community(params.id).id));

  // ------------------------------------------------------------- members

  add('GET', '/api/communities/:id/members', ({ params, query }) => app.members.listMembers(community(params.id).id, query.get('q') ?? undefined));
  add('POST', '/api/communities/:id/members/import', ({ params, body, req, raw }) => {
    community(params.id);
    const ct = String(req.headers['content-type'] ?? '');
    const rows: ImportRow[] = ct.includes('text/csv') ? parseCsv(raw.toString('utf8'))
      : typeof body?.csv === 'string' ? parseCsv(body.csv) : body?.rows;
    if (!Array.isArray(rows)) throw new HttpError(400, 'send {"rows": [...]}, {"csv": "..."} or text/csv');
    return app.members.importMembers(params.id, rows);
  });
  add('PATCH', '/api/communities/:id/members/:playerId', ({ params, body }) => {
    const m = need(app.members.membership(params.id, params.playerId), 'membership');
    if (body.tier) {
      if (!TIERS.includes(body.tier)) throw new HttpError(400, 'tier must be regular or guest');
      app.members.setTier(params.id, params.playerId, body.tier);
    }
    if (body.status) {
      if (!['active', 'removed'].includes(body.status)) throw new HttpError(400, 'status must be active or removed');
      app.members.setMembership(params.id, params.playerId, body.status, m.source);
    }
    const profile: any = {};
    for (const k of ['name', 'skill_level', 'preferred_locations', 'preferred_slots']) if (body[k] !== undefined) profile[k] = body[k];
    if (Object.keys(profile).length) app.members.updateProfile(params.playerId, profile);
    return app.members.listMembers(params.id).find((x) => x.id === params.playerId);
  });
  add('GET', '/api/communities/:id/members/:playerId/history', ({ params }) => {
    const player = need(app.members.player(params.playerId), 'player');
    return {
      player: { id: player.id, name: player.name, phone: player.phone, skill_level: player.skill_level },
      consents: app.members.consents(player.id),
      ...memberHistory(app.db, app.clock, player.id, params.id),
    };
  });

  // -------------------------------------------------------- venues & series

  add('GET', '/api/communities/:id/venues', ({ params }) => app.events.venues(community(params.id).id));
  add('POST', '/api/communities/:id/venues', ({ params, body }) => {
    if (!body?.name) throw new HttpError(400, 'name is required');
    return app.events.createVenue({ ...body, community_id: community(params.id).id });
  });
  add('GET', '/api/communities/:id/series', ({ params }) => app.events.series(community(params.id).id));
  add('POST', '/api/communities/:id/series', ({ params, body }) => app.events.createSeries({ ...body, community_id: community(params.id).id }));
  add('PATCH', '/api/series/:id', ({ params, body }) => { app.events.setSeriesActive(params.id, !!body.active); return { ok: true }; });
  add('POST', '/api/communities/:id/series/generate', ({ params, body }) =>
    app.events.generateFromSeries(community(params.id).id, Number(body?.days ?? 7)));

  // ------------------------------------------------------------- events

  add('GET', '/api/communities/:id/events', ({ params, query }) =>
    app.events.list(community(params.id).id, { from: query.get('from') ?? undefined, to: query.get('to') ?? undefined, status: query.get('status') ?? undefined }));
  add('POST', '/api/communities/:id/events', ({ params, body }) => app.events.create({ ...body, community_id: community(params.id).id }));
  add('GET', '/api/events/:id', ({ params }) => app.events.detail(params.id));
  add('PATCH', '/api/events/:id', ({ params, body }) => app.events.update(params.id, body));
  add('POST', '/api/events/:id/cancel', ({ params, body }) => ({ cancelled_registrations: app.booking.cancelEvent(params.id, body?.reason) }));
  add('POST', '/api/events/:id/invite', ({ params, body }) => {
    if (!Array.isArray(body?.player_ids)) throw new HttpError(400, 'player_ids array required');
    return app.events.invite(params.id, body.player_ids);
  });
  add('GET', '/api/events/:id/candidates', ({ params }) => app.events.candidates(params.id));
  add('POST', '/api/events/:id/fill', ({ params, body }) => app.events.fill(params.id, { count: body?.count, playerIds: body?.player_ids }));
  add('POST', '/api/events/:id/attendance', ({ params, body }) => {
    const marks = body?.marks;
    if (!Array.isArray(marks)) throw new HttpError(400, 'marks: [{player_id, attendance}] required');
    return marks.map((m: any) => {
      if (![null, 'attended', 'no_show'].includes(m.attendance)) throw new HttpError(400, 'attendance must be attended, no_show or null');
      const r = app.booking.markAttendance(params.id, m.player_id, m.attendance);
      return { player_id: m.player_id, attendance: r.attendance };
    });
  });
  add('POST', '/api/events/:id/registrations/:playerId/cancel', ({ params, body }) => {
    const r = app.booking.cancel(params.id, params.playerId, 'organiser', { fullRefund: body?.full_refund !== false, reason: body?.reason });
    if (r.kind !== 'cancelled') throw new HttpError(409, r.kind);
    return r;
  });
  add('POST', '/api/events/:id/registrations', ({ params, body }) => {
    // Organiser books a player directly (e.g. paid in cash): invites them and runs the normal RSVP.
    const e = need(app.booking.event(params.id), 'event');
    const playerId = need(body?.player_id as string | undefined, 'player_id');
    app.db.run(
      `INSERT INTO invitations (id, event_id, player_id, source, status, created_at) VALUES (?, ?, ?, 'direct', 'accepted', ?)
       ON CONFLICT (event_id, player_id) DO NOTHING`, newId('inv'), e.id, playerId, iso(app.clock.now()));
    return app.booking.rsvp(e.id, playerId, 'organiser');
  });

  add('GET', '/api/templates', () => Object.values(TEMPLATES));
  add('GET', '/api/refunds', ({ query }) => app.db.all(
    `SELECT rf.*, p.provider_payment_id, pl.name, pl.phone, e.title FROM refunds rf JOIN payments p ON p.id = rf.payment_id
     JOIN registrations r ON r.id = p.registration_id JOIN players pl ON pl.id = r.player_id JOIN events e ON e.id = r.event_id
     WHERE (? IS NULL OR rf.status = ?) ORDER BY rf.created_at DESC LIMIT 200`, query.get('status'), query.get('status')));
  add('POST', '/api/refunds/:id/retry', ({ params }) => {
    const r = need(app.db.get('SELECT * FROM refunds WHERE id = ?', params.id), 'refund');
    if (r.status !== 'failed' && r.provider_refund_id) throw new HttpError(409, 'refund is not retryable');
    app.db.run(`UPDATE refunds SET status = 'pending', provider_refund_id = NULL WHERE id = ?`, r.id);
    app.jobs.schedule('issue_refund', { refundId: r.id }, app.clock.now(), `refund:${r.id}`);
    return { ok: true };
  });

  // ------------------------------------------------------------ dev tools

  if (config.devTools) {
    add('GET', '/dev/simulator', ({ res }) => send(res, 200, readFileSync(new URL('../../public/simulator.html', import.meta.url)), 'text/html'), false);
    add('POST', '/dev/inbound', async ({ body }) => {
      const from = normalisePhone(String(body?.from ?? ''));
      if (!from) throw new HttpError(400, 'from required');
      app.webhooks.ingestInbound([{
        providerMessageId: newId('wamid_sim'), from, profileName: body.name || undefined, timestamp: iso(app.clock.now()),
        type: body.payload ? 'reply' : 'text', text: body.text, payload: body.payload,
      }]);
      await app.jobs.drain();
      return { ok: true };
    }, false);
    add('GET', '/dev/conversation', ({ query }) => {
      const phone = normalisePhone(query.get('phone') ?? '');
      return app.db.all(
        `SELECT m.id, m.direction, m.kind, m.template_name, m.body, m.status, m.created_at FROM messages m
         JOIN players p ON p.id = m.player_id WHERE p.phone = ? ORDER BY m.created_at, m.rowid`, phone,
      ).map((m) => ({ ...m, body: JSON.parse(m.body) }));
    }, false);
    add('GET', '/dev/templates', () => TEMPLATES, false);
    add('GET', '/dev/players', () => app.db.all('SELECT id, name, phone FROM players ORDER BY created_at'), false);
    add('POST', '/dev/run-jobs', async () => { await app.jobs.drain(); return { ok: true }; }, false);
    add('GET', '/dev/pay/:linkId', ({ params, res }) => {
      const pay = app.db.get(
        `SELECT p.*, e.title FROM payments p JOIN registrations r ON r.id = p.registration_id JOIN events e ON e.id = r.event_id
         WHERE p.provider_link_id = ?`, params.linkId);
      if (!pay) return send(res, 404, 'Unknown payment link', 'text/plain');
      const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
      send(res, 200, `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Pay · Dinqo</title>
<body style="font-family:system-ui;max-width:420px;margin:40px auto;padding:0 16px">
<p style="color:#888">Test payment page (fake provider)</p><h2>${esc(pay.title)}</h2><p style="font-size:28px;margin:8px 0">${rupees(pay.amount_paise)}</p>
<p>Status: <b>${pay.status}</b></p>
${pay.status === 'created' || pay.status === 'cancelled' || pay.status === 'expired' ? `<form method=post><button style="font-size:18px;padding:12px 24px;background:#1a7f5a;color:#fff;border:0;border-radius:8px">Pay with UPI (simulated)</button></form>` : ''}
</body>`, 'text/html');
    }, false);
    add('POST', '/dev/pay/:linkId', async ({ params, res }) => {
      if (!(app.payments instanceof FakePaymentProvider)) throw new HttpError(400, 'fake payments are not enabled');
      const { body, headers } = app.payments.paidWebhook(params.linkId);
      app.webhooks.payment(body, headers);
      await app.jobs.drain();
      res.writeHead(303, { Location: `/dev/pay/${params.linkId}` });
      res.end();
    }, false);
  }

  // ------------------------------------------------------------- dispatch

  const authorised = (req: IncomingMessage) => {
    const given = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
    const expected = Buffer.from(config.adminApiKey);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    try {
      const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!route) throw new HttpError(404, 'not found');
      if (route.auth && !authorised(req)) throw new HttpError(401, 'unauthorised');
      const m = route.pattern.exec(url.pathname)!;
      const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const raw = ['POST', 'PATCH', 'PUT'].includes(req.method ?? '') ? await readBody(req) : Buffer.alloc(0);
      let body: any = {};
      if (raw.length && String(req.headers['content-type'] ?? '').includes('application/json')) {
        try { body = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'invalid JSON'); }
      }
      const out = await route.handler({ req, res, params, query: url.searchParams, raw, body });
      if (!res.headersSent) send(res, 200, out ?? { ok: true });
    } catch (e: any) {
      const status = e instanceof HttpError || e instanceof BookingError ? e.status
        : /UNIQUE constraint/.test(e?.message) ? 409 : 500;
      if (status === 500) console.error(e);
      send(res, status, { error: status === 500 ? 'internal error' : e.message });
    }
  });
}
