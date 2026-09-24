import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { buildServer } from '../src/http/server.ts';
import { ConsoleProvider } from '../src/messaging/console-provider.ts';
import { Actions } from '../src/messaging/notify.ts';
import { FakePaymentProvider } from '../src/payments/fake.ts';
import { harness, reg } from './helpers.ts';

const P = '919833000001', Q = '919833000002';

// ------------------------------------------------------------ WhatsApp routing

test('one number, many communities: join codes, approval, and per-community consent', async () => {
  const h = await harness();
  const smashOwner = h.app.members.upsertPlayer('919833009999', 'Anita');
  const smash = h.app.members.createCommunity({
    name: 'HSR Smash Club', slug: 'smash', status: 'active', join_policy: 'approval', ownerId: smashOwner.id, locations: ['HSR Layout'],
  });

  // Unknown code
  await h.say(P, 'join nope');
  assert.match(h.last(P).text, /couldn't find a community with the code \*nope\*/);

  // Join DOC (open) through the full profile flow
  await h.say(P, 'join doc', 'Meera');
  await h.tap(P, 'onb:name:profile');
  await h.tap(P, 'onb:loc:Jayanagar'); await h.tap(P, 'onb:loc:done');
  await h.tap(P, 'onb:slot:sunday_morning'); await h.tap(P, 'onb:slot:done');
  await h.tap(P, 'onb:skill:intermediate');
  await h.tap(P, 'onb:consent:yes');
  const p = h.app.members.playerByPhone(P)!;
  assert.equal(h.app.members.membership(h.community.id, p.id)!.status, 'active');

  // Join Smash (approval): the profile carries over, only consent is asked, then it waits for the organiser.
  await h.say(P, 'join smash');
  assert.match(h.sent(P).at(-2).text, /profile is already set up/);
  assert.match(h.last(P).text, /Can \*HSR Smash Club\* message you/);
  await h.tap(P, 'onb:consent:no');
  assert.equal(h.app.members.membership(smash.id, p.id)!.status, 'requested');
  assert.match(h.last(P).text, /approves new members personally/);
  assert.equal(h.app.members.consents(p.id, h.community.id).community_games, true);
  assert.equal(h.app.members.consents(p.id, smash.id).community_games, false, 'consent is per community');
  assert.deepEqual(h.app.members.pendingMembers(smash.id).map((m) => m.id), [p.id]);

  // Smash can't invite a pending member; after approval it still can't market without Smash consent.
  const smashGame = h.app.events.create({
    community_id: smash.id, title: 'Thursday Doubles', capacity: 4, price_paise: 0,
    starts_at: new Date(h.clock.now().getTime() + 2 * 86400_000).toISOString(),
    ends_at: new Date(h.clock.now().getTime() + 2 * 86400_000 + 5400_000).toISOString(),
  });
  assert.equal(h.app.events.invite(smashGame.id, [p.id])[0].reason, 'not_member');
  h.app.members.setMembership(smash.id, p.id, 'active');
  h.app.notify.membershipApproved(p.id, smash.id);
  await h.app.jobs.drain();
  assert.match(h.last(P).text, /HSR Smash Club\* has approved/);
  assert.equal(h.app.events.invite(smashGame.id, [p.id])[0].reason, 'no_consent');

  // Free text goes to the current community (the one just joined); the menu offers a switch.
  await h.say(P, 'history');
  assert.match(h.last(P).text, /Your history — HSR Smash Club/);
  await h.say(P, 'menu');
  assert.ok(h.last(P).rows.some((r: any) => r.id === `menu:switch:${smash.id}`));
  await h.tap(P, `switch:to:${h.community.id}`);
  await h.say(P, 'history');
  assert.match(h.last(P).text, /Your history — Dink Over Coffee/);

  // A member of two communities with no current one is asked which community they mean.
  const q = h.member(Q, 'Bala');
  h.app.members.importMembers(smash.id, [{ phone: Q, name: 'Bala' }]);
  assert.ok(q);
  await h.say(Q, 'history');
  assert.equal(h.last(Q).kind, 'list');
  assert.match(h.last(Q).text, /Which community/);
  await h.tap(Q, `switch:to:${smash.id}`);
  assert.match(h.last(Q).text, /\*HSR Smash Club\* — what would you like to do/);

  // Buttons carry their community: an RSVP for a Smash game works regardless of the current community.
  await h.tap(P, `switch:to:${h.community.id}`);
  await h.tap(P, Actions.rsvpYes(smashGame.id));
  assert.match(h.last(P).text, /invite-only/);

  // STOP revokes every community; START restores both memberships.
  await h.say(P, 'STOP');
  assert.equal(h.app.members.consents(p.id, h.community.id).community_games, false);
  await h.say(P, 'START');
  assert.equal(h.app.members.consents(p.id, h.community.id).community_games, true);
  assert.equal(h.app.members.consents(p.id, smash.id).community_games, true);
});

test('pending communities cannot message players', async () => {
  const h = await harness();
  const owner = h.app.members.upsertPlayer('919833008888', 'New Org');
  const c = h.app.members.createCommunity({ name: 'New Club', slug: 'newclub', ownerId: owner.id });
  assert.equal(c.status, 'pending');
  h.app.members.importMembers(c.id, [{ phone: P, name: 'Meera', opted_in: true }]);
  const pid = h.app.members.playerByPhone(P)!.id;
  const e = h.app.events.create({
    community_id: c.id, title: 'Game', capacity: 4,
    starts_at: new Date(h.clock.now().getTime() + 86400_000).toISOString(),
    ends_at: new Date(h.clock.now().getTime() + 90000_000).toISOString(),
  });
  assert.equal(h.app.events.invite(e.id, [pid])[0].reason, 'community_inactive');
  assert.equal((await h.app.polls.run(c.id)).poll_id, null);
});

// -------------------------------------------------------------- Route payouts

test('Route: community share is transferred on payment and reversed before refunds', async () => {
  const h = await harness();
  h.app.members.updateCommunity(h.community.id, { payout_account_id: 'acc_DOC123', platform_fee_bps: 500 });
  const a = h.member(P, 'Asha'), b = h.member(Q, 'Bala');
  const e = h.event({ visibility: 'members', late_refund_percent: 50 });

  for (const ph of [P, Q]) { await h.tap(ph, Actions.rsvpYes(e.id)); await h.payLatestLink(ph); }
  assert.deepEqual(h.pay.transfers.map((t) => [t.accountId, t.amountPaise]), [['acc_DOC123', 33250], ['acc_DOC123', 33250]]);
  const payA = h.app.db.get(`SELECT p.* FROM payments p JOIN registrations r ON r.id = p.registration_id WHERE r.player_id = ?`, a)!;
  assert.equal(payA.platform_fee_paise, 1750);
  assert.equal(payA.transfer_status, 'created');

  // Full refund before the deadline: community share reversed in full, platform covers its fee.
  await h.tap(P, Actions.cancelConfirm(e.id));
  assert.equal(h.pay.transfers[0].reversedPaise, 33250);
  assert.equal(h.pay.refunds[0].amountPaise, 35000);

  // Late cancellation (50%): only the refunded amount is pulled back from the community.
  h.clock.set(new Date(new Date(e.cancellation_deadline).getTime() + 60_000));
  await h.tap(Q, Actions.cancelConfirm(e.id));
  assert.equal(h.pay.transfers[1].reversedPaise, 17500);
  assert.equal(h.pay.refunds[1].amountPaise, 17500);
  assert.equal(reg(h, e.id, b).status, 'cancelled');
});

test('Route: payouts wait for a linked account and are released when it is added', async () => {
  const h = await harness();
  h.member(P, 'Asha');
  const e = h.event({ visibility: 'members' });
  await h.tap(P, Actions.rsvpYes(e.id));
  await h.payLatestLink(P);
  assert.equal(h.app.db.get('SELECT transfer_status FROM payments')!.transfer_status, 'awaiting_account');
  assert.equal(h.pay.transfers.length, 0);

  h.app.members.updateCommunity(h.community.id, { payout_account_id: 'acc_LATE1' });
  assert.equal(h.app.booking.releaseAwaitingTransfers(h.community.id), 1);
  await h.app.jobs.drain();
  assert.deepEqual(h.pay.transfers.map((t) => [t.accountId, t.amountPaise]), [['acc_LATE1', 35000]]);
});

test('Route: a late payment that is refunded straight away is never transferred', async () => {
  const h = await harness();
  h.app.members.updateCommunity(h.community.id, { payout_account_id: 'acc_DOC123' });
  h.member(P, 'Asha'); h.member(Q, 'Bala');
  const e = h.event({ visibility: 'members', capacity: 1 });
  await h.tap(P, Actions.rsvpYes(e.id));
  await h.advance(31);                                  // Asha's hold lapses
  await h.tap(Q, Actions.rsvpYes(e.id)); await h.payLatestLink(Q);
  await h.payLatestLink(P);                             // late, game full → refunded
  assert.equal(h.pay.transfers.length, 1, 'only Bala is paid out');
  assert.equal(h.pay.refunds.length, 1);
});

// --------------------------------------------------------------------- HTTP

async function server() {
  const wa = new ConsoleProvider();
  const app = createApp(
    loadConfig({ databasePath: ':memory:', adminApiKey: 'platform-key', devTools: true, platformAdminPhones: ['919800000000'], baseUrl: 'http://127.0.0.1' }),
    { messaging: wa, payments: new FakePaymentProvider('http://t', 'dev-webhook-secret') },
  );
  const srv = buildServer(app);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = async (path: string, init: RequestInit & { cookie?: string; key?: string } = {}) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init.headers as any) };
    if (init.cookie) headers.Cookie = init.cookie;
    if (init.key) headers.Authorization = `Bearer ${init.key}`;
    const res = await fetch(base + path, { ...init, headers });
    const body = await res.json().catch(() => null);
    return { status: res.status, body, res };
  };
  const login = async (phone: string) => {
    const r = await call('/auth/request-code', { method: 'POST', body: JSON.stringify({ phone }) });
    assert.equal(r.status, 200);
    const v = await call('/auth/verify', { method: 'POST', body: JSON.stringify({ phone, code: r.body.devCode }) });
    assert.equal(v.status, 200);
    return v.res.headers.get('set-cookie')!.split(';')[0];
  };
  return { app, wa, srv, base, call, login };
}

test('HTTP: OTP login, self-serve signup, approval and tenant isolation', async () => {
  const { app, wa, srv, call, login } = await server();
  try {
    assert.equal((await call('/api/communities')).status, 401);

    // Code is delivered over WhatsApp as the authentication template (window closed).
    const req = await call('/auth/request-code', { method: 'POST', body: JSON.stringify({ phone: '98450 11111' }) });
    await app.jobs.drain();
    const sent = wa.sent.at(-1)!;
    assert.equal(sent.to, '919845011111');
    assert.equal(sent.form.type, 'template');
    assert.equal((sent.form.message as any).name, 'dinqo_login_code');
    assert.equal((sent.form.message as any).otpCode, req.body.devCode);

    // Wrong codes lock out after 5 attempts.
    for (let i = 0; i < 5; i++) {
      assert.equal((await call('/auth/verify', { method: 'POST', body: JSON.stringify({ phone: '9845011111', code: '000000' === req.body.devCode ? '111111' : '000000' }) })).status, 401);
    }
    assert.equal((await call('/auth/verify', { method: 'POST', body: JSON.stringify({ phone: '9845011111', code: req.body.devCode }) })).status, 401);

    const alice = await login('9845022222');
    const bob = await login('9845033333');

    // Self-serve signup → pending, owner role
    const created = await call('/api/communities', { method: 'POST', cookie: alice, body: JSON.stringify({ name: 'Alice Club', slug: 'alice', owner_name: 'Alice' }) });
    assert.equal(created.status, 200);
    assert.equal(created.body.status, 'pending');
    assert.match(created.body.join_link, /^https:\/\/wa\.me\/\d+\?text=join%20alice$/);
    const cid = created.body.id;
    assert.equal((await call('/api/communities', { method: 'POST', cookie: bob, body: JSON.stringify({ name: 'X', slug: 'alice' }) })).status, 409);
    assert.equal((await call('/api/communities', { method: 'POST', cookie: bob, body: JSON.stringify({ name: 'X', slug: 'menu' }) })).status, 400);

    // Pending communities can't send polls; owners can't approve themselves.
    assert.equal((await call(`/api/communities/${cid}/polls/run`, { method: 'POST', cookie: alice })).status, 409);
    assert.equal((await call(`/api/communities/${cid}`, { method: 'PATCH', cookie: alice, body: JSON.stringify({ status: 'active' }) })).status, 403);

    // Isolation: Bob can't see or touch Alice's community, events or members.
    assert.equal((await call(`/api/communities/${cid}/dashboard`, { cookie: bob })).status, 404);
    assert.deepEqual((await call('/api/communities', { cookie: bob })).body, []);
    const starts = new Date(Date.now() + 3 * 86400_000);
    const ev = await call(`/api/communities/${cid}/events`, { method: 'POST', cookie: alice, body: JSON.stringify({
      title: 'Test', starts_at: starts.toISOString(), ends_at: new Date(starts.getTime() + 7200_000).toISOString(), capacity: 4,
    }) });
    assert.equal(ev.status, 200);
    assert.equal((await call(`/api/events/${ev.body.id}`, { cookie: bob })).status, 404);
    assert.equal((await call(`/api/events/${ev.body.id}/fill`, { method: 'POST', cookie: bob, body: '{}' })).status, 404);

    // CSRF: cookie writes need JSON and same origin.
    assert.equal((await call(`/api/communities/${cid}/venues`, { method: 'POST', cookie: alice, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'name=x' })).status, 403);
    assert.equal((await call(`/api/communities/${cid}/venues`, { method: 'POST', cookie: alice, headers: { Origin: 'https://evil.example' }, body: JSON.stringify({ name: 'x' }) })).status, 403);

    // Staff: owner adds Bob as organiser → Bob gets access but can't manage staff.
    assert.equal((await call(`/api/communities/${cid}/staff`, { method: 'POST', cookie: alice, body: JSON.stringify({ phone: '9845033333', role: 'organiser' }) })).status, 200);
    assert.equal((await call(`/api/communities/${cid}/dashboard`, { cookie: bob })).status, 200);
    assert.equal((await call(`/api/communities/${cid}/staff`, { method: 'POST', cookie: bob, body: JSON.stringify({ phone: '9845044444' }) })).status, 403);

    // Platform: API key and platform-admin phone can approve and set payouts; templates are staff-only.
    assert.equal((await call('/api/templates', { cookie: alice })).status, 403);
    const admin = await login('919800000000');
    const approved = await call(`/api/communities/${cid}`, { method: 'PATCH', cookie: admin, body: JSON.stringify({ status: 'active', payout_account_id: 'acc_ALICE1', platform_fee_bps: 300 }) });
    assert.equal(approved.body.status, 'active');
    assert.equal(approved.body.payout_account_id, 'acc_ALICE1');
    const list = await call('/api/admin/communities', { key: 'platform-key' });
    assert.equal(list.body.length, 1);
    assert.match(list.body[0].owners, /Alice/);

    const meRes = await call('/auth/me', { cookie: alice });
    assert.deepEqual(meRes.body.communities.map((c: any) => [c.slug, c.role]), [['alice', 'owner']]);

    // Logout kills the session.
    await call('/auth/logout', { method: 'POST', cookie: alice });
    assert.equal((await call('/auth/me', { cookie: alice })).status, 401);
  } finally {
    srv.close();
  }
});

test('HTTP: login codes are rate limited', async () => {
  const { srv, call } = await server();
  try {
    for (let i = 0; i < 3; i++) assert.equal((await call('/auth/request-code', { method: 'POST', body: JSON.stringify({ phone: '9845055555' }) })).status, 200);
    assert.equal((await call('/auth/request-code', { method: 'POST', body: JSON.stringify({ phone: '9845055555' }) })).status, 429);
    assert.equal((await call('/auth/request-code', { method: 'POST', body: JSON.stringify({ phone: '12' }) })).status, 400);
  } finally {
    srv.close();
  }
});
