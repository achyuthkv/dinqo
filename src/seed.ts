/**
 * Seeds a local database with a DOC-like community: venues, weekly series,
 * a few regulars and guests. Run: npm run seed
 */
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';

const app = createApp(loadConfig());
if (app.members.communities().length) {
  console.log('Database already has a community; nothing to seed.');
  process.exit(0);
}

const doc = app.members.createCommunity({
  name: 'Dink Over Coffee', slug: 'doc',
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
const events = app.events.generateFromSeries(doc.id, 7);
app.polls.scheduleNext(doc.id);
console.log(`Seeded "${doc.name}" (${doc.id}): ${result.created} members, ${events.length} upcoming games.`);
app.db.close();
