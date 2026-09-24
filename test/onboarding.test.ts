import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harness } from './helpers.ts';

const PHONE = '919845011111';

test('a new number registers as a member over WhatsApp', async () => {
  const h = await harness();
  await h.say(PHONE, 'hi', 'Ananya');
  assert.match(h.last(PHONE).text, /Welcome to \*Dink Over Coffee\*/);
  assert.equal(h.last(PHONE).buttons[0].id, 'onb:name:profile');

  await h.tap(PHONE, 'onb:name:profile');
  assert.equal(h.last(PHONE).kind, 'list');
  await h.tap(PHONE, 'onb:loc:Jayanagar');
  await h.tap(PHONE, 'onb:loc:more');
  await h.say(PHONE, 'Banashankari'); // typed "Other" area
  await h.tap(PHONE, 'onb:loc:done');
  await h.tap(PHONE, 'onb:slot:sunday_morning');
  await h.tap(PHONE, 'onb:slot:done');
  await h.tap(PHONE, 'onb:skill:intermediate');
  await h.tap(PHONE, 'onb:consent:yes');

  const p = h.app.members.playerByPhone(PHONE)!;
  assert.equal(p.name, 'Ananya');
  assert.equal(p.skill_level, 'intermediate');
  assert.deepEqual(JSON.parse(p.preferred_locations), ['Jayanagar', 'Banashankari']);
  assert.deepEqual(JSON.parse(p.preferred_slots), ['sunday_morning']);
  const m = h.app.members.membership(h.community.id, p.id)!;
  assert.equal(m.status, 'active');
  assert.equal(m.tier, 'guest', 'self-registered members start as guests');
  assert.equal(h.app.members.consents(p.id).community_games, true);
  assert.equal(h.last(PHONE).kind, 'list', 'ends on the main menu');
});

test('STOP revokes invite consent and START restores it', async () => {
  const h = await harness();
  const id = h.member(PHONE, 'Ravi');
  await h.say(PHONE, 'STOP');
  assert.equal(h.app.members.consents(id).community_games, false);
  const e = h.event();
  const [out] = h.app.events.invite(e.id, [id]);
  assert.deepEqual(out, { player_id: id, status: 'skipped', reason: 'no_consent' });
  await h.say(PHONE, 'start');
  assert.equal(h.app.members.consents(id).community_games, true);
});

test('duplicate inbound webhooks are processed once', async () => {
  const h = await harness();
  h.member(PHONE, 'Ravi');
  const msg = { providerMessageId: 'wamid.same', from: PHONE, timestamp: h.clock.now().toISOString(), type: 'text' as const, text: 'history' };
  h.app.webhooks.ingestInbound([msg]);
  h.app.webhooks.ingestInbound([msg]);
  await h.app.jobs.drain();
  assert.equal(h.sent(PHONE).length, 1);
});
