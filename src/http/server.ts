import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import type { App } from '../app.ts';
import type { Principal } from '../auth.ts';
import type { Row } from '../db/index.ts';
import { BookingError } from '../domain/booking.ts';
import { memberHistory } from '../domain/history.ts';
import { TIERS, ValidationError, type ImportRow } from '../domain/members.ts';
import { TEMPLATES } from '../messaging/templates.ts';
import { FakePaymentProvider } from '../payments/fake.ts';
import { iso } from '../util/clock.ts';
import { normalisePhone, rupees } from '../util/format.ts';
import { newId } from '../util/ids.ts';

/** Who is calling: Dinqo automation (API key), or a logged-in person. */
type Caller = { kind: 'platform' } | { kind: 'user'; principal: Principal; viaCookie: boolean };

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  raw: Buffer;
  body: any;
  caller: Caller | null;
}
type Handler = (ctx: Ctx) => unknown | Promise<unknown>;
type Access = 'public' | 'user' | 'platform';
interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler; access: Access }

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const MAX_BODY = 2 * 1024 * 1024;
const COOKIE = 'dinqo_session';

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

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json', headers: Record<string, string | string[]> = {}) {
  if (res.headersSent) return;
  const payload = type === 'application/json' ? JSON.stringify(body) : String(body);
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', ...headers });
  res.end(payload);
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
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
  const add = (method: string, path: string, handler: Handler, access: Access = 'user') => {
    const keys: string[] = [];
    const pattern = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, pattern, keys, handler, access });
  };
  const { config } = app;
  const secureCookie = config.baseUrl.startsWith('https://');
  const need = <T>(v: T, what: string): NonNullable<T> => {
    if (v === undefined || v === null) throw new HttpError(404, `${what} not found`);
    return v;
  };

  // ------------------------------------------------------ authorisation

  const isPlatform = (c: Caller | null) => c?.kind === 'platform' || (c?.kind === 'user' && c.principal.platformAdmin);
  const me = (c: Caller | null): Row => {
    if (c?.kind !== 'user') throw new HttpError(403, 'this action needs an organiser login');
    return c.principal.player;
  };

  /** Loads a community the caller may manage. Owners-only actions pass role 'owner'. Unknown and forbidden look the same. */
  const community = (ctx: Ctx, id: string, role: 'organiser' | 'owner' = 'organiser'): Row => {
    const c = app.members.community(id);
    if (!c) throw new HttpError(404, 'community not found');
    if (isPlatform(ctx.caller)) return c;
    const r = ctx.caller?.kind === 'user' ? app.members.staffRole(id, ctx.caller.principal.player.id) : undefined;
    if (!r) throw new HttpError(404, 'community not found');
    if (role === 'owner' && r !== 'owner') throw new HttpError(403, 'only the community owner can do this');
    return c;
  };
  const event = (ctx: Ctx, id: string): Row => {
    const e = need(app.booking.event(id), 'event');
    community(ctx, e.community_id);
    return e;
  };

  const withJoin = (c: Row) => ({ ...c, locations: JSON.parse(c.locations), poll_days: JSON.parse(c.poll_days), join_link: app.joinLink(c.slug) });

  // ------------------------------------------------------------- public

  add('GET', '/health', () => ({ ok: true, time: iso(app.clock.now()) }), 'public');
  add('GET', '/', ({ res }) => { res.writeHead(302, { Location: '/admin' }); res.end(); }, 'public');
  add('GET', '/admin', ({ res }) => send(res, 200, readFileSync(new URL('../../public/admin.html', import.meta.url)), 'text/html'), 'public');

  // ------------------------------------------------------------- auth

  add('POST', '/auth/request-code', ({ body }) => {
    const r = app.auth.requestCode(String(body?.phone ?? ''));
    if (!r.ok) throw new HttpError(r.reason === 'rate_limited' ? 429 : 400, r.reason === 'rate_limited' ? 'too many codes requested, try again later' : 'enter a valid mobile number');
    return r;
  }, 'public');

  add('POST', '/auth/verify', ({ body, res }) => {
    const s = app.auth.verifyCode(String(body?.phone ?? ''), String(body?.code ?? ''));
    if (!s) throw new HttpError(401, 'wrong or expired code');
    const maxAge = Math.floor((new Date(s.expiresAt).getTime() - app.clock.now().getTime()) / 1000);
    send(res, 200, { ok: true, token: s.token }, 'application/json', {
      'Set-Cookie': `${COOKIE}=${encodeURIComponent(s.token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`,
    });
  }, 'public');

  add('POST', '/auth/logout', ({ req, res }) => {
    app.auth.logout(cookies(req)[COOKIE]);
    send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` });
  }, 'public');

  add('GET', '/auth/me', ({ caller }) => {
    if (caller?.kind === 'platform') return { platform_admin: true, player: null, communities: app.members.communities().map(withJoin) };
    const p = me(caller);
    const cs = isPlatform(caller)
      ? app.members.communities().map((c) => ({ ...c, role: app.members.staffRole(c.id, p.id) ?? 'platform' }))
      : app.members.staffCommunities(p.id);
    return { platform_admin: isPlatform(caller), player: { id: p.id, name: p.name, phone: p.phone }, communities: cs.map(withJoin) };
  });

  // ----------------------------------------------------------- webhooks

  add('GET', '/webhooks/whatsapp', ({ query, res }) => {
    if (query.get('hub.mode') === 'subscribe' && query.get('hub.verify_token') === config.whatsapp.verifyToken) {
      return send(res, 200, query.get('hub.challenge') ?? '', 'text/plain');
    }
    send(res, 403, { error: 'verification failed' });
  }, 'public');

  add('POST', '/webhooks/whatsapp', ({ req, raw, res }) => {
    const r = app.webhooks.whatsapp(raw, req.headers['x-hub-signature-256'] as string | undefined);
    send(res, r.status, { ok: r.ok });
  }, 'public');

  add('POST', '/webhooks/payments', ({ req, raw, res }) => {
    const r = app.webhooks.payment(raw, req.headers);
    send(res, r.status, { ok: r.ok });
  }, 'public');

  // -------------------------------------------------------- communities

  add('GET', '/api/communities', ({ caller }) =>
    (isPlatform(caller) ? app.members.communities() : app.members.staffCommunities(me(caller).id)).map(withJoin));

  /** Self-serve: any logged-in organiser can set up a community; it stays pending until Dinqo approves it. */
  add('POST', '/api/communities', ({ caller, body }) => {
    const owner = caller?.kind === 'user' ? caller.principal.player
      : body?.owner_phone ? app.members.upsertPlayer(String(body.owner_phone), body.owner_name) : null;
    if (!owner) throw new HttpError(400, 'owner_phone is required when creating a community with the API key');
    if (caller?.kind === 'user' && body?.owner_name && !owner.name) app.members.updateProfile(owner.id, { name: String(body.owner_name) });
    const c = app.members.createCommunity({
      name: body?.name, slug: body?.slug, locations: Array.isArray(body?.locations) ? body.locations : [],
      join_policy: body?.join_policy, ownerId: owner.id,
      status: isPlatform(caller) && body?.status === 'active' ? 'active' : 'pending',
    });
    app.polls.scheduleNext(c.id);
    return withJoin(c);
  });

  add('GET', '/api/communities/:id', (ctx) => withJoin(community(ctx, ctx.params.id)));

  add('PATCH', '/api/communities/:id', (ctx) => {
    const c = community(ctx, ctx.params.id, 'owner');
    const b = ctx.body ?? {};
    const patch: any = {};
    for (const k of ['name', 'locations', 'join_policy']) if (b[k] !== undefined) patch[k] = b[k];
    const platformOnly = ['status', 'payout_account_id', 'platform_fee_bps'].filter((k) => b[k] !== undefined);
    if (platformOnly.length) {
      if (!isPlatform(ctx.caller)) throw new HttpError(403, `${platformOnly.join(', ')} can only be changed by Dinqo`);
      for (const k of platformOnly) patch[k] = b[k] === '' ? null : b[k];
    }
    const updated = app.members.updateCommunity(c.id, patch);
    if (patch.payout_account_id) app.booking.releaseAwaitingTransfers(c.id);
    if (patch.status) app.polls.scheduleNext(c.id);
    return withJoin(updated);
  });

  add('GET', '/api/communities/:id/dashboard', (ctx) => {
    const c = community(ctx, ctx.params.id);
    const id = c.id;
    const now = iso(app.clock.now());
    const upcoming = app.events.list(id, { from: now }).filter((e) => e.status === 'open');
    const members = app.members.listMembers(id);
    const monthAgo = iso(new Date(app.clock.now().getTime() - 30 * 86400_000));
    const past = app.events.list(id, { from: monthAgo, to: now });
    const marked = past.reduce((s, e) => s + e.attended + e.no_shows, 0);
    const money = app.db.get(
      `SELECT COALESCE(SUM(p.amount_paise - p.refunded_paise), 0) AS net,
              COALESCE(SUM(p.transfer_paise - p.transfer_reversed_paise), 0) AS paid_out,
              COALESCE(SUM(CASE WHEN p.transfer_status = 'awaiting_account' THEN p.amount_paise - p.platform_fee_paise - p.refunded_paise ELSE 0 END), 0) AS awaiting
       FROM payments p JOIN registrations r ON r.id = p.registration_id JOIN events e ON e.id = r.event_id
       WHERE e.community_id = ? AND p.status = 'paid' AND p.paid_at >= ?`, id, monthAgo,
    )!;
    const pendingRefunds = app.db.get(
      `SELECT COUNT(*) AS n FROM refunds rf JOIN payments p ON p.id = rf.payment_id JOIN registrations r ON r.id = p.registration_id
       JOIN events e ON e.id = r.event_id WHERE e.community_id = ? AND rf.status != 'processed'`, id,
    )!;
    const nextPoll = app.db.get(`SELECT run_at FROM jobs WHERE unique_key = ? AND status = 'pending'`, `poll:${id}`);
    return {
      community: withJoin(c),
      members: members.length,
      regulars: members.filter((m) => m.tier === 'regular').length,
      invites_ok: members.filter((m) => m.invites_ok).length,
      pending_members: app.members.pendingMembers(id).length,
      upcoming,
      games_last_30_days: past.length,
      attendance_rate_30d: marked ? Math.round((past.reduce((s, e) => s + e.attended, 0) / marked) * 100) : null,
      net_revenue_30d_paise: money.net,
      net_revenue_30d: rupees(money.net),
      paid_out_30d: rupees(money.paid_out),
      awaiting_payout_account: rupees(money.awaiting),
      refunds_needing_attention: pendingRefunds.n,
      next_poll_at: c.status === 'active' ? nextPoll?.run_at ?? null : null,
      latest_polls: app.polls.list(id, 3),
    };
  });

  // ------------------------------------------------------------- staff

  add('GET', '/api/communities/:id/staff', (ctx) => app.members.staff(community(ctx, ctx.params.id).id));
  add('POST', '/api/communities/:id/staff', (ctx) => {
    const c = community(ctx, ctx.params.id, 'owner');
    const role = ctx.body?.role === 'owner' ? 'owner' : 'organiser';
    const phone = normalisePhone(String(ctx.body?.phone ?? ''));
    if (!/^\d{11,15}$/.test(phone)) throw new HttpError(400, 'enter a valid mobile number');
    const p = app.members.upsertPlayer(phone, ctx.body?.name || undefined);
    app.members.addStaff(c.id, p.id, role);
    return app.members.staff(c.id);
  });
  add('DELETE', '/api/communities/:id/staff/:playerId', (ctx) => {
    const c = community(ctx, ctx.params.id, 'owner');
    app.members.removeStaff(c.id, ctx.params.playerId);
    return app.members.staff(c.id);
  });

  // --------------------------------------------------------- availability polls

  add('PATCH', '/api/communities/:id/poll-settings', (ctx) => {
    const c = community(ctx, ctx.params.id);
    const b = ctx.body ?? {};
    if (b.poll_days && (!Array.isArray(b.poll_days) || b.poll_days.some((d: string) => !['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].includes(d)))) {
      throw new HttpError(400, 'poll_days must be an array like ["mon","wed"]');
    }
    if (b.poll_time && !/^\d{1,2}:\d{2}$/.test(b.poll_time)) throw new HttpError(400, 'poll_time must be HH:MM');
    return withJoin(app.polls.updateSettings(c.id, b));
  });
  add('GET', '/api/communities/:id/polls', (ctx) => app.polls.list(community(ctx, ctx.params.id).id));
  add('POST', '/api/communities/:id/polls/run', (ctx) => {
    const c = community(ctx, ctx.params.id);
    if (c.status !== 'active') throw new HttpError(409, 'this community is awaiting approval by Dinqo and cannot message players yet');
    return app.polls.run(c.id);
  });

  // ------------------------------------------------------------- members

  add('GET', '/api/communities/:id/members', (ctx) => app.members.listMembers(community(ctx, ctx.params.id).id, ctx.query.get('q') ?? undefined));
  add('GET', '/api/communities/:id/members/pending', (ctx) => app.members.pendingMembers(community(ctx, ctx.params.id).id));
  add('POST', '/api/communities/:id/members/:playerId/approve', (ctx) => {
    const c = community(ctx, ctx.params.id);
    const m = need(app.members.membership(c.id, ctx.params.playerId), 'membership');
    if (m.status !== 'requested') throw new HttpError(409, `membership is ${m.status}`);
    app.members.setMembership(c.id, ctx.params.playerId, 'active', m.source, ctx.body?.tier);
    app.notify.membershipApproved(ctx.params.playerId, c.id);
    return { ok: true };
  });
  add('POST', '/api/communities/:id/members/:playerId/reject', (ctx) => {
    const c = community(ctx, ctx.params.id);
    const m = need(app.members.membership(c.id, ctx.params.playerId), 'membership');
    if (m.status !== 'requested') throw new HttpError(409, `membership is ${m.status}`);
    app.members.setMembership(c.id, ctx.params.playerId, 'removed', m.source);
    return { ok: true };
  });
  add('POST', '/api/communities/:id/members/import', (ctx) => {
    const c = community(ctx, ctx.params.id);
    const ct = String(ctx.req.headers['content-type'] ?? '');
    const rows: ImportRow[] = ct.includes('text/csv') ? parseCsv(ctx.raw.toString('utf8'))
      : typeof ctx.body?.csv === 'string' ? parseCsv(ctx.body.csv) : ctx.body?.rows;
    if (!Array.isArray(rows)) throw new HttpError(400, 'send {"rows": [...]}, {"csv": "..."} or text/csv');
    return app.members.importMembers(c.id, rows);
  });
  add('PATCH', '/api/communities/:id/members/:playerId', (ctx) => {
    const c = community(ctx, ctx.params.id);
    const { body, params } = ctx;
    const m = need(app.members.membership(c.id, params.playerId), 'membership');
    if (body.tier) {
      if (!TIERS.includes(body.tier)) throw new HttpError(400, 'tier must be regular or guest');
      app.members.setTier(c.id, params.playerId, body.tier);
    }
    if (body.status) {
      if (!['active', 'removed'].includes(body.status)) throw new HttpError(400, 'status must be active or removed');
      app.members.setMembership(c.id, params.playerId, body.status, m.source);
    }
    // Profiles belong to the player and are shared across communities, so organisers can't edit them.
    return app.members.listMembers(c.id).find((x) => x.id === params.playerId) ?? { ok: true };
  });
  add('GET', '/api/communities/:id/members/:playerId/history', (ctx) => {
    const c = community(ctx, ctx.params.id);
    need(app.members.membership(c.id, ctx.params.playerId), 'member');
    const player = need(app.members.player(ctx.params.playerId), 'player');
    return {
      player: { id: player.id, name: player.name, phone: player.phone, skill_level: player.skill_level },
      consents: app.members.consents(player.id, c.id),
      ...memberHistory(app.db, app.clock, player.id, c.id),
    };
  });

  // -------------------------------------------------------- venues & series

  add('GET', '/api/communities/:id/venues', (ctx) => app.events.venues(community(ctx, ctx.params.id).id));
  add('POST', '/api/communities/:id/venues', (ctx) => {
    const c = community(ctx, ctx.params.id);
    if (!ctx.body?.name) throw new HttpError(400, 'name is required');
    return app.events.createVenue({ name: ctx.body.name, area: ctx.body.area, maps_url: ctx.body.maps_url, community_id: c.id });
  });
  const venueOf = (c: Row, venueId: unknown) => {
    if (!venueId) return null;
    const v = app.db.get('SELECT id FROM venues WHERE id = ? AND community_id = ?', String(venueId), c.id);
    if (!v) throw new HttpError(400, 'unknown venue');
    return v.id as string;
  };
  add('GET', '/api/communities/:id/series', (ctx) => app.events.series(community(ctx, ctx.params.id).id));
  add('POST', '/api/communities/:id/series', (ctx) => {
    const c = community(ctx, ctx.params.id);
    return app.events.createSeries({ ...ctx.body, venue_id: venueOf(c, ctx.body?.venue_id), community_id: c.id });
  });
  add('PATCH', '/api/series/:id', (ctx) => {
    const s = need(app.db.get('SELECT * FROM event_series WHERE id = ?', ctx.params.id), 'series');
    community(ctx, s.community_id);
    app.events.setSeriesActive(s.id, !!ctx.body?.active);
    return { ok: true };
  });
  add('POST', '/api/communities/:id/series/generate', (ctx) =>
    app.events.generateFromSeries(community(ctx, ctx.params.id).id, Math.min(Number(ctx.body?.days ?? 7), 28)));

  // ------------------------------------------------------------- events

  add('GET', '/api/communities/:id/events', (ctx) => {
    const c = community(ctx, ctx.params.id);
    const q = ctx.query;
    return app.events.list(c.id, { from: q.get('from') ?? undefined, to: q.get('to') ?? undefined, status: q.get('status') ?? undefined });
  });
  add('POST', '/api/communities/:id/events', (ctx) => {
    const c = community(ctx, ctx.params.id);
    return app.events.create({ ...ctx.body, venue_id: venueOf(c, ctx.body?.venue_id), series_id: null, community_id: c.id });
  });
  add('GET', '/api/events/:id', (ctx) => { event(ctx, ctx.params.id); return app.events.detail(ctx.params.id); });
  add('PATCH', '/api/events/:id', (ctx) => {
    const e = event(ctx, ctx.params.id);
    const c = app.members.community(e.community_id)!;
    const patch = { ...ctx.body };
    if (patch.venue_id !== undefined) patch.venue_id = venueOf(c, patch.venue_id);
    return app.events.update(e.id, patch);
  });
  add('POST', '/api/events/:id/cancel', (ctx) => ({ cancelled_registrations: app.booking.cancelEvent(event(ctx, ctx.params.id).id, ctx.body?.reason) }));
  add('POST', '/api/events/:id/invite', (ctx) => {
    const e = event(ctx, ctx.params.id);
    if (!Array.isArray(ctx.body?.player_ids)) throw new HttpError(400, 'player_ids array required');
    return app.events.invite(e.id, ctx.body.player_ids);
  });
  add('GET', '/api/events/:id/candidates', (ctx) => app.events.candidates(event(ctx, ctx.params.id).id));
  add('POST', '/api/events/:id/fill', (ctx) => {
    const e = event(ctx, ctx.params.id);
    return app.events.fill(e.id, { count: ctx.body?.count, playerIds: ctx.body?.player_ids });
  });
  add('POST', '/api/events/:id/attendance', (ctx) => {
    const e = event(ctx, ctx.params.id);
    const marks = ctx.body?.marks;
    if (!Array.isArray(marks)) throw new HttpError(400, 'marks: [{player_id, attendance}] required');
    return marks.map((m: any) => {
      if (![null, 'attended', 'no_show'].includes(m.attendance)) throw new HttpError(400, 'attendance must be attended, no_show or null');
      const r = app.booking.markAttendance(e.id, m.player_id, m.attendance);
      return { player_id: m.player_id, attendance: r.attendance };
    });
  });
  add('POST', '/api/events/:id/registrations/:playerId/cancel', (ctx) => {
    const e = event(ctx, ctx.params.id);
    const r = app.booking.cancel(e.id, ctx.params.playerId, 'organiser', { fullRefund: ctx.body?.full_refund !== false, reason: ctx.body?.reason });
    if (r.kind !== 'cancelled') throw new HttpError(409, r.kind);
    return r;
  });
  add('POST', '/api/events/:id/registrations', (ctx) => {
    // Organiser books a member directly (e.g. paid in cash): invites them and runs the normal RSVP.
    const e = event(ctx, ctx.params.id);
    const playerId = need(ctx.body?.player_id as string | undefined, 'player_id');
    const m = app.members.membership(e.community_id, playerId);
    if (m?.status !== 'active') throw new HttpError(400, 'player is not an active member of this community');
    app.db.run(
      `INSERT INTO invitations (id, event_id, player_id, source, status, created_at) VALUES (?, ?, ?, 'direct', 'accepted', ?)
       ON CONFLICT (event_id, player_id) DO NOTHING`, newId('inv'), e.id, playerId, iso(app.clock.now()));
    return app.booking.rsvp(e.id, playerId, 'organiser');
  });

  add('GET', '/api/templates', () => Object.values(TEMPLATES), 'platform');
  add('GET', '/api/communities/:id/refunds', (ctx) => {
    const c = community(ctx, ctx.params.id);
    return app.db.all(
      `SELECT rf.*, pl.name, pl.phone, e.title FROM refunds rf JOIN payments p ON p.id = rf.payment_id
       JOIN registrations r ON r.id = p.registration_id JOIN players pl ON pl.id = r.player_id JOIN events e ON e.id = r.event_id
       WHERE e.community_id = ? AND (? IS NULL OR rf.status = ?) ORDER BY rf.created_at DESC LIMIT 200`,
      c.id, ctx.query.get('status'), ctx.query.get('status'));
  });
  add('POST', '/api/refunds/:id/retry', (ctx) => {
    const r = need(app.db.get(
      `SELECT rf.*, e.community_id FROM refunds rf JOIN payments p ON p.id = rf.payment_id
       JOIN registrations reg ON reg.id = p.registration_id JOIN events e ON e.id = reg.event_id WHERE rf.id = ?`, ctx.params.id), 'refund');
    community(ctx, r.community_id);
    if (r.status !== 'failed') throw new HttpError(409, 'only failed refunds can be retried');
    app.db.run(`UPDATE refunds SET status = 'pending', provider_refund_id = NULL WHERE id = ?`, r.id);
    app.jobs.schedule('issue_refund', { refundId: r.id }, app.clock.now(), `refund:${r.id}`);
    return { ok: true };
  });

  // ------------------------------------------------------ platform admin

  add('GET', '/api/admin/communities', () => app.db.all(
    `SELECT c.*, (SELECT COUNT(*) FROM memberships m WHERE m.community_id = c.id AND m.status = 'active') AS members,
       (SELECT COUNT(*) FROM events e WHERE e.community_id = c.id) AS events,
       (SELECT GROUP_CONCAT(p.name || ' (' || p.phone || ')', ', ') FROM community_staff s JOIN players p ON p.id = s.player_id
          WHERE s.community_id = c.id AND s.role = 'owner') AS owners,
       (SELECT COUNT(*) FROM messages m WHERE m.community_id = c.id AND m.direction = 'out' AND m.category = 'marketing') AS marketing_sent
     FROM communities c ORDER BY c.created_at DESC`).map(withJoin), 'platform');

  // ------------------------------------------------------------ dev tools

  if (config.devTools) {
    add('GET', '/dev/simulator', ({ res }) => send(res, 200, readFileSync(new URL('../../public/simulator.html', import.meta.url)), 'text/html'), 'public');
    add('POST', '/dev/inbound', async ({ body }) => {
      const from = normalisePhone(String(body?.from ?? ''));
      if (!from) throw new HttpError(400, 'from required');
      app.webhooks.ingestInbound([{
        providerMessageId: newId('wamid_sim'), from, profileName: body.name || undefined, timestamp: iso(app.clock.now()),
        type: body.payload ? 'reply' : 'text', text: body.text, payload: body.payload,
      }]);
      await app.jobs.drain();
      return { ok: true };
    }, 'public');
    add('GET', '/dev/conversation', ({ query }) => {
      const phone = normalisePhone(query.get('phone') ?? '');
      return app.db.all(
        `SELECT m.id, m.direction, m.kind, m.template_name, m.body, m.status, m.created_at FROM messages m
         JOIN players p ON p.id = m.player_id WHERE p.phone = ? ORDER BY m.created_at, m.rowid`, phone,
      ).map((m) => ({ ...m, body: JSON.parse(m.body) }));
    }, 'public');
    add('GET', '/dev/templates', () => TEMPLATES, 'public');
    add('GET', '/dev/players', () => app.db.all('SELECT id, name, phone FROM players ORDER BY created_at'), 'public');
    add('POST', '/dev/run-jobs', async () => { await app.jobs.drain(); return { ok: true }; }, 'public');
    add('GET', '/dev/pay/:linkId', ({ params, res }) => {
      const pay = app.db.get(
        `SELECT p.*, e.title, c.name AS community FROM payments p JOIN registrations r ON r.id = p.registration_id
         JOIN events e ON e.id = r.event_id JOIN communities c ON c.id = e.community_id WHERE p.provider_link_id = ?`, params.linkId);
      if (!pay) return send(res, 404, 'Unknown payment link', 'text/plain');
      const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
      send(res, 200, `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Pay · Dinqo</title>
<body style="font-family:system-ui;max-width:420px;margin:40px auto;padding:0 16px">
<p style="color:#888">Test payment page (fake provider)</p><p>${esc(pay.community)}</p><h2>${esc(pay.title)}</h2><p style="font-size:28px;margin:8px 0">${rupees(pay.amount_paise)}</p>
<p>Status: <b>${pay.status}</b></p>
${pay.status === 'created' || pay.status === 'cancelled' || pay.status === 'expired' ? `<form method=post><button style="font-size:18px;padding:12px 24px;background:#1a7f5a;color:#fff;border:0;border-radius:8px">Pay with UPI (simulated)</button></form>` : ''}
</body>`, 'text/html');
    }, 'public');
    add('POST', '/dev/pay/:linkId', async ({ params, res }) => {
      if (!(app.payments instanceof FakePaymentProvider)) throw new HttpError(400, 'fake payments are not enabled');
      const { body, headers } = app.payments.paidWebhook(params.linkId);
      app.webhooks.payment(body, headers);
      await app.jobs.drain();
      res.writeHead(303, { Location: `/dev/pay/${params.linkId}` });
      res.end();
    }, 'public');
  }

  // ------------------------------------------------------------- dispatch

  const identify = (req: IncomingMessage): Caller | null => {
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (bearer) {
      const given = Buffer.from(bearer);
      const expected = Buffer.from(config.adminApiKey);
      if (given.length === expected.length && timingSafeEqual(given, expected)) return { kind: 'platform' };
      const p = app.auth.session(bearer);
      return p ? { kind: 'user', principal: p, viaCookie: false } : null;
    }
    const p = app.auth.session(cookies(req)[COOKIE]);
    return p ? { kind: 'user', principal: p, viaCookie: true } : null;
  };

  /** Cookie-authenticated writes must come from our own origin with a non-form content type (CSRF). */
  const csrfOk = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (origin && origin !== new URL(config.baseUrl).origin) return false;
    const ct = String(req.headers['content-type'] ?? '');
    return ct.includes('application/json') || ct.includes('text/csv');
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    try {
      const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!route) throw new HttpError(404, 'not found');
      const caller = route.access === 'public' ? null : identify(req);
      if (route.access !== 'public' && !caller) throw new HttpError(401, 'please log in');
      if (route.access === 'platform' && !isPlatform(caller)) throw new HttpError(403, 'Dinqo staff only');
      if (caller?.kind === 'user' && caller.viaCookie && req.method !== 'GET' && !csrfOk(req)) throw new HttpError(403, 'cross-site request blocked');
      const m = route.pattern.exec(url.pathname)!;
      const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const raw = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method ?? '') ? await readBody(req) : Buffer.alloc(0);
      let body: any = {};
      if (raw.length && String(req.headers['content-type'] ?? '').includes('application/json')) {
        try { body = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'invalid JSON'); }
      }
      const out = await route.handler({ req, res, params, query: url.searchParams, raw, body, caller });
      if (!res.headersSent) send(res, 200, out ?? { ok: true });
    } catch (e: any) {
      const status = e instanceof HttpError || e instanceof BookingError || e instanceof ValidationError ? e.status
        : /UNIQUE constraint/.test(e?.message) ? 409 : 500;
      if (status === 500) console.error(e);
      send(res, status, { error: status === 500 ? 'internal error' : e.message });
    }
  });
}
