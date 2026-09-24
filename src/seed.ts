/**
 * Seeds a local database with the pilot tenant (Dink Over Coffee) plus a second
 * community, so multi-community routing can be tried in the simulator.
 * Run: npm run seed
 *
 * Console logins (codes appear in the simulator for these numbers, and in the API response in dev):
 *   919845000000  Dinqo platform admin (PLATFORM_ADMIN_PHONES default)
 *   919845000100  DOC owner
 */
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';

const app = createApp(loadConfig());
if (app.members.communities().length) {
  console.log('Database already has communities; nothing to seed.');
  process.exit(0);
}

app.members.upsertPlayer('919845000000', 'Dinqo Admin');
const docOwner = app.members.upsertPlayer('919845000100', 'Vikram (DOC)');

const doc = app.members.createCommunity({
  name: 'Dink Over Coffee', slug: 'doc', status: 'active', ownerId: docOwner.id,
  locations: ['Jayanagar', 'JP Nagar', 'HSR Layout', 'Koramangala', 'Indiranagar'],
});
const playMania = app.events.createVenue({ community_id: doc.id, name: 'Play Mania', area: 'Jayanagar' });
const ferrohub = app.events.createVenue({ community_id: doc.id, name: 'Ferrohub', area: 'HSR Layout' });

app.events.createSeries({
  community_id: doc.id, venue_id: playMania.id, title: 'Sunday Community Play', weekday: 'sun', start_time: '07:00',
  duration_minutes: 120, capacity: 16, skill_level: 'intermediate', price_paise: 35000, cancel_hours_before: 24,
});
app.events.createSeries({
  community_id: doc.id, venue_id: ferrohub.id, title: 'Wednesday Night Dinks', weekday: 'wed', start_time: '19:00',
  duration_minutes: 120, capacity: 8, price_paise: 30000, cancel_hours_before: 12, late_refund_percent: 50,
});
app.events.createSeries({
  community_id: doc.id, venue_id: playMania.id, title: 'Saturday Morning Open', weekday: 'sat', start_time: '07:00',
  duration_minutes: 120, capacity: 12, price_paise: 0,
});

const result = app.members.importMembers(doc.id, [
  { phone: '9845000001', name: 'Rahul', skill_level: 'intermediate', tier: 'regular', opted_in: true, preferred_locations: ['Jayanagar'] },
  { phone: '9845000002', name: 'Priya', skill_level: 'intermediate', tier: 'regular', opted_in: true, preferred_locations: ['HSR Layout'] },
  { phone: '9845000003', name: 'Arjun', skill_level: 'advanced', tier: 'regular', opted_in: true, preferred_locations: ['Jayanagar'] },
  { phone: '9845000004', name: 'Sneha', skill_level: 'beginner', tier: 'guest', opted_in: true, preferred_locations: ['Koramangala'] },
  { phone: '9845000005', name: 'Karthik', skill_level: 'intermediate', tier: 'guest', opted_in: true, preferred_locations: ['Jayanagar'] },
]);
for (const p of app.members.listMembers(doc.id)) {
  app.members.updateProfile(p.id, { preferred_slots: ['sunday_morning', 'saturday_morning'] });
}

// A second tenant on the same number: players join it with "join smash".
const smashOwner = app.members.upsertPlayer('919845000200', 'Anita (Smash)');
const smash = app.members.createCommunity({
  name: 'HSR Smash Club', slug: 'smash', status: 'active', join_policy: 'approval', ownerId: smashOwner.id,
  locations: ['HSR Layout', 'Koramangala', 'BTM Layout'],
});
const smashVenue = app.events.createVenue({ community_id: smash.id, name: 'Smash Arena', area: 'HSR Layout' });
app.events.createSeries({
  community_id: smash.id, venue_id: smashVenue.id, title: 'Thursday Evening Doubles', weekday: 'thu', start_time: '19:30',
  duration_minutes: 90, capacity: 8, price_paise: 25000,
});

const events = app.events.generateFromSeries(doc.id, 7).length + app.events.generateFromSeries(smash.id, 7).length;
for (const c of [doc, smash]) app.polls.scheduleNext(c.id);
console.log(`Seeded "${doc.name}" (join: ${app.joinLink(doc.slug)}) and "${smash.name}" (join: ${app.joinLink(smash.slug)}).`);
console.log(`${result.created} DOC members, ${events} upcoming games.`);
console.log('Console logins: 919845000000 (Dinqo admin), 919845000100 (DOC owner), 919845000200 (Smash owner).');
app.db.close();
