import { json, type Db, type Row } from '../db/index.ts';
import type { Booking, RsvpResult } from '../domain/booking.ts';
import { memberHistory, upcomingForPlayer } from '../domain/history.ts';
import { type Members, SKILLS, SLOTS, SLOT_LABELS } from '../domain/members.ts';
import type { Polls } from '../domain/polls.ts';
import { Actions, loadEventView } from '../messaging/notify.ts';
import type { Outbox } from '../messaging/outbox.ts';
import type { InboundMessage, SessionMessage } from '../messaging/types.ts';
import { type Clock, iso } from '../util/clock.ts';
import { day, rupees, time, when } from '../util/format.ts';
import { newId } from '../util/ids.ts';

type Conv = { state: string; community_id: string | null; context: Record<string, any> };

const STOP_WORDS = new Set(['stop', 'unsubscribe', 'stop all']);
const START_WORDS = new Set(['start', 'subscribe', 'unstop']);
const JOIN_RE = /^\s*join\s+([a-z0-9]{2,20})\b/i;

/** Actions whose third segment is an event id; the community is derived from the event. */
const EVENT_ACTIONS = new Set(['rsvp', 'offer', 'wl', 'cancel']);

/**
 * WhatsApp conversation handler for the shared Dinqo number.
 *
 * Many communities share one number, so every message is first resolved to a
 * community: a "join <code>" (from the organiser's wa.me link), the event or
 * poll a button refers to, or the player's current community. Players in more
 * than one community can switch from the menu.
 */
export class Bot {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly members: Members,
    private readonly booking: Booking,
    private readonly polls: Polls,
    private readonly outbox: Outbox,
  ) {}

  private reply(playerId: string, m: SessionMessage, communityId?: string | null) { this.outbox.reply(playerId, m, communityId); }
  private text(playerId: string, text: string, communityId?: string | null) { this.reply(playerId, { kind: 'text', text }, communityId); }

  /** Returns false if this message id was already processed. */
  handle(msg: InboundMessage): boolean {
    const player = this.members.upsertPlayer(msg.from, msg.profileName);
    const logged = this.db.run(
      `INSERT OR IGNORE INTO messages (id, player_id, direction, kind, body, status, provider_message_id, created_at, updated_at)
       VALUES (?, ?, 'in', ?, ?, 'received', ?, ?, ?)`,
      newId('msg'), player.id, msg.type, JSON.stringify({ text: msg.text, payload: msg.payload }),
      msg.providerMessageId, iso(this.clock.now()), iso(this.clock.now()),
    );
    if (!logged.changes) return false;
    this.members.touchInbound(player.id, msg.timestamp);

    const conv = this.conversation(player.id);
    const text = (msg.text ?? '').trim();
    const lower = text.toLowerCase();

    if (msg.type === 'text' && STOP_WORDS.has(lower)) return this.stop(player), true;
    if (msg.type === 'text' && START_WORDS.has(lower)) return this.start(player), true;

    const join = msg.type === 'text' ? JOIN_RE.exec(text) : null;
    if (join) return this.join(player, join[1].toLowerCase(), msg.profileName), true;

    if (conv.state.startsWith('onb_') && conv.community_id) {
      this.onboarding(player, conv, msg);
      return true;
    }

    if (msg.payload) {
      const communityId = this.communityForPayload(player, conv, msg.payload);
      if (!communityId || !this.requireMember(player, communityId)) return true;
      this.setCurrent(player.id, communityId);
      this.action(player, communityId, msg.payload);
      return true;
    }

    // Free text: a bare join code also works ("doc").
    const bySlug = this.members.communityBySlug(lower);
    if (bySlug && !this.members.membership(bySlug.id, player.id)) return this.join(player, bySlug.slug, msg.profileName), true;

    const communityId = this.currentCommunity(player, conv);
    if (!communityId) return true; // currentCommunity already explained what to do
    this.command(player, communityId, lower);
    return true;
  }

  // ------------------------------------------------------------- plumbing

  private conversation(playerId: string): Conv {
    const c = this.db.get('SELECT * FROM conversations WHERE player_id = ?', playerId);
    return c ? { state: c.state, community_id: c.community_id, context: json.parse(c.context, {}) } : { state: 'idle', community_id: null, context: {} };
  }

  private saveConversation(playerId: string, c: Conv) {
    this.db.run(
      `INSERT INTO conversations (player_id, community_id, state, context, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (player_id) DO UPDATE SET community_id = excluded.community_id, state = excluded.state,
         context = excluded.context, updated_at = excluded.updated_at`,
      playerId, c.community_id, c.state, JSON.stringify(c.context), iso(this.clock.now()),
    );
  }

  private setCurrent(playerId: string, communityId: string) {
    const conv = this.conversation(playerId);
    if (conv.community_id === communityId && conv.state === 'idle') return;
    this.saveConversation(playerId, { state: conv.state.startsWith('onb_') ? 'idle' : conv.state, community_id: communityId, context: {} });
  }

  /** Buttons carry the event, poll or community they belong to. */
  private communityForPayload(player: Row, conv: Conv, payload: string): string | null {
    const [kind, verb, arg] = payload.split(':');
    if (EVENT_ACTIONS.has(kind) && arg) return this.booking.event(arg)?.community_id ?? null;
    if (kind === 'avail' && verb && verb !== 'none') return this.booking.event(verb)?.community_id ?? null;
    if (kind === 'poll' && arg) return this.db.get('SELECT community_id FROM availability_polls WHERE id = ?', arg)?.community_id ?? null;
    if ((kind === 'menu' || kind === 'consent' || kind === 'switch' || kind === 'profile') && arg) return arg;
    return this.currentCommunity(player, conv);
  }

  /**
   * The community free text refers to: the current one if still valid, else the
   * only active membership. Explains to the player when it can't decide.
   */
  private currentCommunity(player: Row, conv: Conv): string | null {
    const active = this.members.playerCommunities(player.id).filter((c) => c.membership_status === 'active' && c.status !== 'suspended');
    if (conv.community_id && active.some((c) => c.id === conv.community_id)) return conv.community_id;
    if (active.length === 1) return active[0].id;
    if (active.length > 1) {
      this.pickCommunity(player.id, active);
      return null;
    }
    const requested = this.members.playerCommunities(player.id).find((c) => c.membership_status === 'requested');
    if (requested) {
      this.text(player.id, `Your request to join *${requested.name}* is waiting for the organiser's approval. We'll message you here as soon as you're in.`, requested.id);
      return null;
    }
    this.text(player.id,
      "👋 Welcome to Dinqo — games and community play, right here on WhatsApp.\n\n" +
      "To join your community, tap the join link your organiser shared, or send *join* followed by the community code (e.g. *join doc*).");
    return null;
  }

  private requireMember(player: Row, communityId: string): boolean {
    const m = this.members.membership(communityId, player.id);
    if (m?.status === 'active') return true;
    const c = this.members.community(communityId);
    if (m?.status === 'requested') this.text(player.id, `Your request to join *${c?.name}* is still waiting for approval.`, communityId);
    else this.text(player.id, `You're not a member of *${c?.name ?? 'this community'}* yet. Send *join ${c?.slug ?? '<code>'}* to join.`, communityId);
    return false;
  }

  private pickCommunity(playerId: string, communities: Row[], text = 'Which community is this about?') {
    this.reply(playerId, {
      kind: 'list', text, buttonLabel: 'Choose',
      rows: communities.slice(0, 10).map((c) => ({ id: `switch:to:${c.id}`, title: c.name, description: `Code: ${c.slug}` })),
    });
  }

  // ------------------------------------------------------------ joining

  private join(player: Row, slug: string, profileName?: string) {
    const c = this.members.communityBySlug(slug);
    if (!c || c.status === 'suspended') {
      return this.text(player.id, `We couldn't find a community with the code *${slug}*. Please check the link or code your organiser shared.`);
    }
    const m = this.members.membership(c.id, player.id);
    if (m?.status === 'active') {
      this.setCurrent(player.id, c.id);
      return this.menu(player.id, c.id, `You're already a member of *${c.name}* ✅ What would you like to do?`);
    }
    if (m?.status === 'requested') {
      return this.text(player.id, `Your request to join *${c.name}* is waiting for the organiser's approval.`, c.id);
    }
    this.members.setMembership(c.id, player.id, 'pending', 'whatsapp');
    const p = this.members.player(player.id)!;
    const profileDone = p.name && p.skill_level
      && json.parse<string[]>(p.preferred_locations, []).length && json.parse<string[]>(p.preferred_slots, []).length;
    if (profileDone) {
      // Returning Dinqo player: their profile carries over, only this community's consent is new.
      const conv: Conv = { state: 'onb_consent', community_id: c.id, context: {} };
      this.saveConversation(player.id, conv);
      this.text(player.id, `Welcome to *${c.name}* 👋 Your Dinqo player profile is already set up, so this is quick.`, c.id);
      return this.prompt(player, conv, c);
    }
    this.saveConversation(player.id, { state: 'onb_name', community_id: c.id, context: {} });
    const intro = `Welcome to *${c.name}* on Dinqo 👋\n\nWe'll help you find games that match you — right here on WhatsApp. It takes 30 seconds to set up your player profile.\n\nFirst, what should we call you?`;
    if (profileName) {
      this.reply(player.id, {
        kind: 'buttons', text: intro, footer: 'Or just type your name',
        buttons: [{ id: 'onb:name:profile', title: `I'm ${profileName}`.slice(0, 20) }],
      }, c.id);
    } else this.text(player.id, intro, c.id);
  }

  // ----------------------------------------------------------- onboarding

  private onboarding(player: Row, conv: Conv, msg: InboundMessage) {
    const c = this.members.community(conv.community_id!)!;
    const payload = msg.payload ?? '';
    const text = (msg.text ?? '').trim();
    const ctx = conv.context;
    const go = (state: string) => { conv.state = state; this.saveConversation(player.id, conv); this.prompt(player, conv, c); };

    switch (conv.state) {
      case 'onb_name': {
        const name = payload === 'onb:name:profile' ? player.name : msg.type === 'text' ? text : '';
        if (!name || name.length > 60) return this.text(player.id, 'Please type your name (just your first name is fine).', c.id);
        this.members.updateProfile(player.id, { name });
        ctx.locations = [];
        return go('onb_locations');
      }
      case 'onb_locations':
      case 'onb_slots': {
        const key = conv.state === 'onb_locations' ? 'locations' : 'slots';
        const prefix = key === 'locations' ? 'onb:loc:' : 'onb:slot:';
        ctx[key] ??= [];
        if (payload === `${prefix}done`) {
          if (!ctx[key].length) return this.text(player.id, 'Pick at least one option first 🙂', c.id);
          if (key === 'locations') {
            this.members.updateProfile(player.id, { preferred_locations: ctx.locations });
            ctx.slots = [];
            return go('onb_slots');
          }
          this.members.updateProfile(player.id, { preferred_slots: ctx.slots });
          if (ctx.editing) return this.finishEdit(player, c);
          return go('onb_skill');
        }
        if (payload === `${prefix}more`) return this.prompt(player, conv, c);
        let value: string | null = payload.startsWith(prefix) ? payload.slice(prefix.length) : null;
        if (!value && msg.type === 'text' && key === 'locations' && text) value = text.slice(0, 40); // "Other" typed in
        if (!value) return this.prompt(player, conv, c);
        if (value === 'other') return this.text(player.id, 'Type the name of your area:', c.id);
        if (!ctx[key].includes(value)) ctx[key].push(value);
        this.saveConversation(player.id, conv);
        const label = key === 'locations' ? ctx.locations.join(', ') : ctx.slots.map((s: string) => SLOT_LABELS[s]).join(', ');
        return this.reply(player.id, {
          kind: 'buttons', text: `Got it: *${label}*`,
          buttons: [{ id: `${prefix}more`, title: 'Add another' }, { id: `${prefix}done`, title: "That's all" }],
        }, c.id);
      }
      case 'onb_skill': {
        const skill = payload.startsWith('onb:skill:') ? payload.slice(10) : text.toLowerCase();
        if (!SKILLS.includes(skill as any)) return this.prompt(player, conv, c);
        this.members.updateProfile(player.id, { skill_level: skill });
        return go('onb_consent');
      }
      case 'onb_consent': {
        if (payload !== 'onb:consent:yes' && payload !== 'onb:consent:no') return this.prompt(player, conv, c);
        const optedIn = payload === 'onb:consent:yes';
        this.members.setConsent(player.id, c.id, 'community_games', optedIn, 'whatsapp_onboarding');
        const p = this.members.player(player.id)!;
        const summary =
          `📍 ${json.parse<string[]>(p.preferred_locations, []).join(', ')}\n` +
          `⏰ ${json.parse<string[]>(p.preferred_slots, []).map((s) => SLOT_LABELS[s]).join(', ')}\n` +
          `🎾 ${cap(p.skill_level)}`;
        if (c.join_policy === 'approval') {
          this.members.setMembership(c.id, player.id, 'requested', 'whatsapp');
          this.saveConversation(player.id, { state: 'idle', community_id: c.id, context: {} });
          return this.text(player.id,
            `Thanks, ${p.name}! 🙌\n\n${summary}\n\n*${c.name}* approves new members personally. We'll message you here as soon as the organiser lets you in.`, c.id);
        }
        this.members.setMembership(c.id, player.id, 'active', 'whatsapp');
        this.saveConversation(player.id, { state: 'idle', community_id: c.id, context: {} });
        this.text(player.id,
          `You're in, ${p.name} ✅\n\n${summary}\n\n` +
          (optedIn
            ? `We'll message you when ${c.name} has a game that fits you.`
            : `We'll only message you about games you book. You can turn on invites anytime from the menu.`), c.id);
        return this.menu(player.id, c.id);
      }
    }
  }

  private finishEdit(player: Row, c: Row) {
    this.saveConversation(player.id, { state: 'idle', community_id: c.id, context: {} });
    this.text(player.id, 'Profile updated ✅', c.id);
  }

  private prompt(player: Row, conv: Conv, c: Row) {
    const ctx = conv.context;
    switch (conv.state) {
      case 'onb_locations': {
        const options: string[] = json.parse<string[]>(c.locations, []).filter((l) => !(ctx.locations ?? []).includes(l));
        return this.reply(player.id, {
          kind: 'list', text: 'Where do you usually play? Pick one — you can add more after.', buttonLabel: 'Choose area',
          rows: [...options.slice(0, 9).map((l) => ({ id: `onb:loc:${l}`, title: l })), { id: 'onb:loc:other', title: 'Other', description: 'Type your area' }],
        }, c.id);
      }
      case 'onb_slots':
        return this.reply(player.id, {
          kind: 'list', text: 'When do you usually prefer to play? Pick one — you can add more after.', buttonLabel: 'Choose time',
          rows: SLOTS.filter((s) => !(ctx.slots ?? []).includes(s)).map((s) => ({ id: `onb:slot:${s}`, title: SLOT_LABELS[s] })),
        }, c.id);
      case 'onb_skill':
        return this.reply(player.id, {
          kind: 'buttons', text: "What's your playing level?",
          buttons: SKILLS.map((s) => ({ id: `onb:skill:${s}`, title: cap(s) })),
        }, c.id);
      case 'onb_consent':
        return this.reply(player.id, {
          kind: 'buttons',
          text: `Can *${c.name}* message you here about games that match your preferences (like the weekly availability check)?\n\nThis only applies to ${c.name}. You can reply STOP anytime.`,
          buttons: [{ id: 'onb:consent:yes', title: 'Yes, invite me' }, { id: 'onb:consent:no', title: 'Only my bookings' }],
        }, c.id);
    }
  }

  // ------------------------------------------------------------- commands

  private command(player: Row, communityId: string, lower: string) {
    if (/^(hi|hey|hello|menu|help|start over|options)\b/.test(lower)) return this.menu(player.id, communityId);
    if (/\b(availability|available|this week|play)\b/.test(lower)) return this.availability(player, communityId);
    if (/\b(my games|games|bookings|upcoming)\b/.test(lower)) return this.myGames(player.id);
    if (/\b(history|stats)\b/.test(lower)) return this.history(player.id, communityId);
    if (/\b(cancel|can't make it|cant make it|drop out)\b/.test(lower)) return this.myGames(player.id, true);
    if (/\b(profile|preferences|settings)\b/.test(lower)) return this.settings(player.id, communityId);
    if (/\b(switch|communities|community)\b/.test(lower)) return this.switchList(player.id);
    return this.menu(player.id, communityId, "Sorry, I didn't catch that. Here's what I can help with:");
  }

  private menu(playerId: string, communityId: string, text?: string) {
    const c = this.members.community(communityId)!;
    const others = this.members.playerCommunities(playerId).filter((x) => x.membership_status === 'active' && x.id !== communityId);
    this.reply(playerId, {
      kind: 'list', text: text ?? `*${c.name}* — what would you like to do?`, buttonLabel: 'Menu',
      rows: [
        { id: `menu:avail:${c.id}`, title: 'Mark availability', description: `This week's ${c.name} games` },
        { id: `menu:games:${c.id}`, title: 'My games', description: 'Upcoming bookings, pay or cancel' },
        { id: `menu:history:${c.id}`, title: 'My history', description: 'Games played, attendance, payments' },
        { id: `menu:settings:${c.id}`, title: 'Settings', description: 'Profile and notifications' },
        ...(others.length ? [{ id: `menu:switch:${c.id}`, title: 'Switch community', description: others.map((o) => o.name).join(', ') }] : []),
      ],
    }, communityId);
  }

  private switchList(playerId: string) {
    const active = this.members.playerCommunities(playerId).filter((c) => c.membership_status === 'active');
    if (active.length < 2) return this.text(playerId, "You're only in one community right now. Send *join <code>* to join another.");
    this.pickCommunity(playerId, active, 'Switch to which community?');
  }

  private availability(player: Row, communityId: string) {
    if (!this.polls.sendList(player.id, communityId)) {
      this.text(player.id, "You're all caught up — no open games waiting for your answer right now. We'll let you know when new ones are up.", communityId);
    }
  }

  private myGames(playerId: string, forCancel = false) {
    const games = upcomingForPlayer(this.db, this.clock, playerId);
    if (!games.length) return this.text(playerId, "You don't have any upcoming games. Reply *availability* to see this week's games.");
    const multi = new Set(games.map((g) => g.community_id)).size > 1;
    const label: Record<string, string> = { confirmed: '✅ Confirmed', held: '⏳ Awaiting payment', offered: '🎟 Spot offered to you', waitlisted: '🕒 Waitlist' };
    const lines = games.map((g) => `${label[g.status]} — *${g.title}*${multi ? ` (${g.community})` : ''}, ${when(g.starts_at)}${g.venue ? ` @ ${g.venue}` : ''}` +
      (g.status === 'waitlisted' ? ` (#${this.booking.waitlistPosition(g.event_id, playerId)})` : '') +
      (g.status === 'held' || g.status === 'offered' ? ` — until ${time(g.expires_at)}` : ''));
    const rows = games.flatMap((g) => {
      const d = `${day(g.starts_at)} ${time(g.starts_at)}`;
      const out = [];
      if (g.status === 'held') out.push({ id: Actions.rsvpYes(g.event_id), title: `Pay: ${d}`, description: g.title });
      if (g.status === 'offered') out.push({ id: Actions.offerYes(g.event_id), title: `Take spot: ${d}`, description: g.title });
      out.push({ id: Actions.cancelAsk(g.event_id), title: `${g.status === 'waitlisted' ? 'Leave' : 'Cancel'}: ${d}`, description: g.title });
      return out;
    }).slice(0, 10);
    this.reply(playerId, {
      kind: 'list', text: `${forCancel ? 'Which game do you want to cancel?\n\n' : 'Your upcoming games:\n\n'}${lines.join('\n')}`,
      buttonLabel: 'Manage', rows,
    });
  }

  private history(playerId: string, communityId: string) {
    const c = this.members.community(communityId)!;
    const { stats, events } = memberHistory(this.db, this.clock, playerId, communityId);
    const icon = (r: Row) => r.attendance === 'attended' ? '🏓' : r.attendance === 'no_show' ? '❌' : r.status === 'confirmed' ? '✅'
      : r.status === 'cancelled' ? '↩️' : r.status === 'waitlisted' ? '🕒' : '•';
    const recent = events.filter((r) => r.status).slice(0, 6)
      .map((r) => `${icon(r)} ${day(r.starts_at)} — ${r.title}${r.refunded_paise ? ` (refund ${rupees(r.refunded_paise)})` : ''}`);
    this.text(playerId,
      `📊 *Your history — ${c.name}*\n\n` +
      `Games played: *${stats.played}*\n` +
      `Upcoming: ${stats.confirmed_upcoming}\n` +
      `Cancellations: ${stats.cancellations} · No-shows: ${stats.no_shows}\n` +
      (stats.attendance_rate !== null ? `Attendance: ${Math.round(stats.attendance_rate * 100)}%\n` : '') +
      `Paid: ${rupees(stats.total_paid_paise)}${stats.total_refunded_paise ? ` · Refunded: ${rupees(stats.total_refunded_paise)}` : ''}\n` +
      (recent.length ? `\n*Recent*\n${recent.join('\n')}` : '\nNo games yet — reply *availability* to find one!'), communityId);
  }

  private settings(playerId: string, communityId: string) {
    const c = this.members.community(communityId)!;
    const on = !!this.members.consents(playerId, communityId).community_games;
    this.reply(playerId, {
      kind: 'buttons',
      text: `⚙️ *Settings — ${c.name}*\n\nGame invites & weekly availability from ${c.name}: *${on ? 'ON' : 'OFF'}*\nBooking updates (payments, reminders): always on while you have a booking.`,
      buttons: [
        on ? { id: `consent:off:${c.id}`, title: 'Turn invites off' } : { id: `consent:on:${c.id}`, title: 'Turn invites on' },
        { id: `profile:edit:${c.id}`, title: 'Update profile' },
      ],
    }, communityId);
  }

  private stop(player: Row) {
    this.members.revokeAll(player.id, 'whatsapp_stop');
    this.text(player.id, "You're unsubscribed from invites and availability checks from every community. You'll still get updates about games you've already booked. Reply START to opt back in.");
  }

  private start(player: Row) {
    const n = this.members.grantAllMemberships(player.id, 'whatsapp_start');
    this.text(player.id, n
      ? "Welcome back! You'll get game invites and the weekly availability check again."
      : "You're not in a community yet. Send *join <code>* to join one.");
  }

  // -------------------------------------------------------------- actions

  private action(player: Row, communityId: string, payload: string) {
    const [kind, verb, arg] = payload.split(':');
    const eventId = arg;
    switch (`${kind}:${verb}`) {
      case 'menu:avail': return this.availability(player, communityId);
      case 'menu:games': return this.myGames(player.id);
      case 'menu:history': return this.history(player.id, communityId);
      case 'menu:settings': return this.settings(player.id, communityId);
      case 'menu:switch': return this.switchList(player.id);
      case 'switch:to': return this.menu(player.id, communityId);
      case 'consent:on':
        this.members.setConsent(player.id, communityId, 'community_games', true, 'whatsapp_settings');
        return this.text(player.id, `Invites from *${this.members.community(communityId)!.name}* are on 👍`, communityId);
      case 'consent:off':
        this.members.setConsent(player.id, communityId, 'community_games', false, 'whatsapp_settings');
        return this.text(player.id, `Invites from *${this.members.community(communityId)!.name}* are off. You'll still get updates about games you've booked.`, communityId);
      case 'profile:edit': {
        const conv: Conv = { state: 'onb_locations', community_id: communityId, context: { locations: [], editing: true } };
        this.saveConversation(player.id, conv);
        return this.prompt(player, conv, this.members.community(communityId)!);
      }
      case 'poll:open': return this.availability(player, communityId);
      case 'poll:none':
      case 'avail:none': {
        this.polls.notThisWeek(player.id, communityId);
        return this.text(player.id, "Thanks for letting us know 👍 We'll check in again with the next set of games.", communityId);
      }
      case 'rsvp:yes':
      case 'offer:yes':
        return this.afterRsvp(player, eventId, this.booking.rsvp(eventId, player.id));
      case 'rsvp:no':
        this.booking.decline(eventId, player.id);
        return this.text(player.id, "No worries 👍 We'll let you know about the next one.", communityId);
      case 'wl:join':
        return this.afterRsvp(player, eventId, this.booking.joinWaitlist(eventId, player.id));
      case 'wl:skip':
        return this.text(player.id, "Okay! We'll keep you posted about other games.", communityId);
      case 'offer:no':
        this.booking.declineOffer(eventId, player.id);
        return this.text(player.id, "No problem — we've passed the spot to the next person.", communityId);
      case 'cancel:ask': return this.cancelAsk(player, eventId);
      case 'cancel:yes': {
        const r = this.booking.cancel(eventId, player.id, 'player');
        if (r.kind === 'too_late') return this.text(player.id, 'This game has already started, so it can no longer be cancelled here. Please contact the organiser.', communityId);
        if (r.kind === 'not_registered') return this.text(player.id, "You don't have an active booking for this game.", communityId);
        return; // confirmation (with refund info) is sent by the booking engine
      }
      case 'cancel:keep': return this.text(player.id, 'Great — your spot is kept. See you on court! 🏓', communityId);
    }
    if (kind === 'avail' && verb) {
      // avail:<eventId> — a pick from the availability list
      const r = this.booking.rsvp(verb, player.id);
      this.polls.markResponded(player.id, communityId);
      this.afterRsvp(player, verb, r);
      if (this.polls.pendingFor(player.id, communityId).length) this.polls.sendList(player.id, communityId, true);
      return;
    }
    this.menu(player.id, communityId, 'That option has expired. Here is the menu:');
  }

  private afterRsvp(player: Row, eventId: string, r: RsvpResult) {
    const e = () => loadEventView(this.db, eventId);
    const cid = () => e().communityId;
    switch (r.kind) {
      case 'confirmed':
      case 'held':
      case 'already_held':
        return; // confirmation / payment link is sent by the booking engine
      case 'already_confirmed':
        return this.text(player.id, `You're already confirmed for *${e().title}* on ${day(e().starts_at)} ✅`, cid());
      case 'waitlisted':
        return this.text(player.id, `You're *#${r.position}* on the waitlist for *${e().title}* (${day(e().starts_at)}). If a spot opens we'll offer it to you right here.`, cid());
      case 'full':
        return this.reply(player.id, {
          kind: 'buttons', text: `*${e().title}* on ${day(e().starts_at)} is full right now. Want to join the waitlist? We'll offer you a spot the moment one opens.`,
          buttons: [{ id: Actions.waitlistJoin(eventId), title: 'Join waitlist' }, { id: Actions.waitlistSkip(eventId), title: 'No thanks' }],
        }, cid());
      case 'not_eligible':
        return this.text(player.id, 'This is an invite-only game. The organiser will reach out if a spot opens up for you.', cid());
      case 'closed':
        return this.text(player.id, r.reason === 'started' ? 'This game has already started.' : 'Registrations for this game are closed.');
    }
  }

  private cancelAsk(player: Row, eventId: string) {
    const event = this.booking.event(eventId);
    const reg = this.booking.registration(eventId, player.id);
    if (!event || !reg || !['waitlisted', 'offered', 'held', 'confirmed'].includes(reg.status)) {
      return this.text(player.id, "You don't have an active booking for this game.");
    }
    const v = loadEventView(this.db, eventId);
    let policy = '';
    if (reg.status === 'confirmed') {
      const q = this.booking.refundQuote(event, reg);
      if (q.paidPaise === 0) policy = '';
      else if (q.fullRefund) policy = `You'll get a full refund of ${rupees(q.refundPaise)} (free cancellation until ${when(q.deadline)}).`;
      else if (q.refundPaise > 0) policy = `The free-cancellation window closed at ${when(q.deadline)}, so you'll get ${rupees(q.refundPaise)} back of ${rupees(q.paidPaise)}.`;
      else policy = `The free-cancellation window closed at ${when(q.deadline)}, so this cancellation is not refundable.`;
    }
    const what = reg.status === 'waitlisted' ? 'Leave the waitlist for' : 'Cancel your spot for';
    this.reply(player.id, {
      kind: 'buttons',
      text: `${what} *${v.title}* on ${when(v.starts_at)}?\n\n${policy}`.trim(),
      buttons: [
        { id: Actions.cancelConfirm(eventId), title: policy.includes('refund of') ? 'Cancel & refund' : 'Yes, cancel' },
        { id: Actions.cancelKeep(eventId), title: 'Keep my spot' },
      ],
    }, event.community_id);
  }
}

const cap = (s: string | null) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
