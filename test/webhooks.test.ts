import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { buildServer, parseCsv } from '../src/http/server.ts';
import { ConsoleProvider } from '../src/messaging/console-provider.ts';
import { parseCloudWebhook, toCloudPayload } from '../src/messaging/whatsapp-cloud.ts';
import { FakePaymentProvider } from '../src/payments/fake.ts';
import { ManualClock } from '../src/util/clock.ts';
import { harness } from './helpers.ts';

test('Meta webhook: signature is verified and payload is parsed', async () => {
  const wa = new ConsoleProvider();
  const app = createApp(loadConfig({ databasePath: ':memory:', whatsapp: { appSecret: 'meta-secret' } as any }), {
    clock: new ManualClock(), messaging: wa, payments: new FakePaymentProvider('http://t', 's'),
  });
  app.members.createCommunity({ name: 'DOC', slug: 'doc' });
  const body = Buffer.from(JSON.stringify({
    entry: [{ changes: [{ value: {
      contacts: [{ wa_id: '919812345678', profile: { name: 'Meera' } }],
      messages: [{ id: 'wamid.1', from: '919812345678', timestamp: '1790000000', type: 'text', text: { body: 'hi' } }],
    } }] }],
  }));
  assert.equal(app.webhooks.whatsapp(body, 'sha256=deadbeef').status, 401);
  const sig = 'sha256=' + createHmac('sha256', 'meta-secret').update(body).digest('hex');
  assert.equal(app.webhooks.whatsapp(body, sig).status, 200);
  await app.jobs.drain();
  assert.equal(app.members.playerByPhone('919812345678')!.name, 'Meera');
  assert.equal(wa.sent.length, 1);
});

test('Cloud API payloads', () => {
  const t = toCloudPayload({ to: '91', form: { type: 'template', language: 'en', message: { name: 'x', params: ['a'], buttonPayloads: ['p0', 'p1'] } } }) as any;
  assert.equal(t.template.components.length, 3);
  assert.deepEqual(t.template.components[2], { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'p1' }] });
  const b = toCloudPayload({ to: '91', form: { type: 'session', message: { kind: 'buttons', text: 'hi', buttons: [{ id: 'a', title: 'A very long button title here' }] } } }) as any;
  assert.equal(b.interactive.action.buttons[0].reply.title.length, 20);

  const parsed = parseCloudWebhook({ entry: [{ changes: [{ value: {
    messages: [
      { id: '1', from: '9', timestamp: '1', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'rsvp:yes:e', title: 'Yes' } } },
      { id: '2', from: '9', timestamp: '1', type: 'button', button: { payload: 'offer:no:e', text: 'No' } },
    ],
    statuses: [{ id: 'w', status: 'failed', errors: [{ code: 131047, title: 'Re-engagement message' }] }],
  } }] }] });
  assert.deepEqual(parsed.messages.map((m) => m.payload), ['rsvp:yes:e', 'offer:no:e']);
  assert.equal(parsed.statuses[0].error, '131047: Re-engagement message');
});

test('payment webhooks with a bad signature are rejected', async () => {
  const h = await harness();
  const r = h.app.webhooks.payment(Buffer.from('{"event":"payment_link.paid"}'), { 'x-razorpay-signature': 'nope' });
  assert.equal(r.status, 401);
});

test('CSV import parsing', () => {
  const rows = parseCsv('phone,name,skill_level,tier,opted_in,preferred_locations\n98450 12345,"Rao, K",Intermediate,regular,yes,Jayanagar;HSR\n');
  assert.deepEqual(rows[0], { phone: '98450 12345', name: 'Rao, K', skill_level: 'intermediate', tier: 'regular', opted_in: true, preferred_locations: ['Jayanagar', 'HSR'] });
});

test('HTTP API: auth, create event, simulator round-trip', async () => {
  const app = createApp(loadConfig({ databasePath: ':memory:', adminApiKey: 'k', devTools: true }), {
    messaging: new ConsoleProvider(), payments: new FakePaymentProvider('http://t', 'dev-webhook-secret'),
  });
  const server = buildServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const api = (path: string, init: RequestInit = {}) => fetch(base + path, {
    ...init, headers: { Authorization: 'Bearer k', 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  try {
    assert.equal((await fetch(base + '/api/communities')).status, 401);
    const c = await (await api('/api/communities', { method: 'POST', body: JSON.stringify({ name: 'DOC', slug: 'doc' }) })).json();
    const starts = new Date(Date.now() + 3 * 86400_000);
    const evRes = await api(`/api/communities/${c.id}/events`, { method: 'POST', body: JSON.stringify({
      title: 'Test', starts_at: starts.toISOString(), ends_at: new Date(starts.getTime() + 7200_000).toISOString(), capacity: 4, price_paise: 0,
    }) });
    assert.equal(evRes.status, 200);
    const bad = await api(`/api/communities/${c.id}/events`, { method: 'POST', body: JSON.stringify({ title: 'x', capacity: 0 }) });
    assert.equal(bad.status, 400);

    await fetch(base + '/dev/inbound', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: '9845099999', name: 'Sim', text: 'hi' }) });
    const conv = await (await fetch(base + '/dev/conversation?phone=9845099999')).json();
    assert.equal(conv.length, 2);
    assert.equal(conv[1].direction, 'out');

    const imp = await fetch(`${base}/api/communities/${c.id}/members/import`, {
      method: 'POST', headers: { Authorization: 'Bearer k', 'Content-Type': 'text/csv' },
      body: 'phone,name,tier,opted_in\n9845011111,Asha,regular,yes\nbad,Nope,,\n',
    });
    const impBody = await imp.json();
    assert.equal(impBody.created, 1);
    assert.equal(impBody.errors.length, 1);
    const dash = await (await api(`/api/communities/${c.id}/dashboard`)).json();
    assert.equal(dash.upcoming.length, 1);
  } finally {
    server.close();
  }
});
