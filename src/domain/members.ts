import { json, type Db, type Row } from '../db/index.ts';
import type { Purpose } from '../messaging/outbox.ts';
import { type Clock, iso } from '../util/clock.ts';
import { normalisePhone } from '../util/format.ts';
import { newId } from '../util/ids.ts';

export const SKILLS = ['beginner', 'intermediate', 'advanced'] as const;
export const SLOTS = [
  'weekday_morning', 'weekday_evening', 'saturday_morning', 'saturday_evening', 'sunday_morning', 'sunday_evening',
] as const;
export const SLOT_LABELS: Record<string, string> = {
  weekday_morning: 'Weekday mornings', weekday_evening: 'Weekday evenings',
  saturday_morning: 'Saturday morning', saturday_evening: 'Saturday evening',
  sunday_morning: 'Sunday morning', sunday_evening: 'Sunday evening',
};

export class ValidationError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const SLUG_RE = /^[a-z0-9]{2,20}$/;
/** Words the bot treats as commands, so they can't be join codes. */
const RESERVED_SLUGS = new Set(['menu', 'help', 'stop', 'start', 'history', 'games', 'cancel', 'join', 'hi', 'hello', 'dinqo', 'admin', 'settings', 'availability']);

/** pending = onboarding in progress · requested = awaiting organiser approval */
export type MembershipStatus = 'pending' | 'requested' | 'active' | 'removed';

export const TIERS = ['regular', 'guest'] as const;
export type Tier = (typeof TIERS)[number];

export interface ImportRow {
  phone: string;
  name?: string;
  skill_level?: string;
  preferred_locations?: string[];
  /** Regulars get the Mon/Wed availability poll. Imports default to regular. */
  tier?: Tier;
  /** Organiser confirms this person agreed to receive game invites on WhatsApp. */
  opted_in?: boolean;
}

export class Members {
  constructor(private readonly db: Db, private readonly clock: Clock, private readonly policyVersion: string) {}

  private now() { return iso(this.clock.now()); }

  createCommunity(input: {
    name: string; slug: string; locations?: string[]; timezone?: string;
    status?: 'pending' | 'active'; join_policy?: 'open' | 'approval'; ownerId?: string;
  }): Row {
    const name = String(input.name ?? '').trim();
    const slug = String(input.slug ?? '').trim().toLowerCase();
    if (!name || name.length > 60) throw new ValidationError('name is required (max 60 characters)');
    if (!SLUG_RE.test(slug)) throw new ValidationError('join code must be 2–20 letters/numbers, e.g. "doc"');
    if (RESERVED_SLUGS.has(slug)) throw new ValidationError(`"${slug}" is reserved`);
    if (this.db.get('SELECT 1 FROM communities WHERE slug = ?', slug)) throw new ValidationError(`join code "${slug}" is taken`, 409);
    const id = newId('com');
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO communities (id, name, slug, timezone, locations, status, join_policy, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id, name, slug, input.timezone ?? 'Asia/Kolkata', JSON.stringify(input.locations ?? []),
        input.status ?? 'pending', input.join_policy ?? 'open', this.now(),
      );
      if (input.ownerId) this.addStaff(id, input.ownerId, 'owner');
    });
    return this.community(id)!;
  }

  communityBySlug(slug: string): Row | undefined {
    return this.db.get('SELECT * FROM communities WHERE slug = ?', slug.toLowerCase());
  }

  updateCommunity(id: string, patch: Partial<{
    name: string; locations: string[]; join_policy: 'open' | 'approval';
    status: 'pending' | 'active' | 'suspended'; payout_account_id: string | null; platform_fee_bps: number;
  }>): Row {
    if (patch.join_policy && !['open', 'approval'].includes(patch.join_policy)) throw new ValidationError('join_policy must be open or approval');
    if (patch.status && !['pending', 'active', 'suspended'].includes(patch.status)) throw new ValidationError('invalid status');
    if (patch.payout_account_id && !/^acc_[A-Za-z0-9]+$/.test(patch.payout_account_id)) {
      throw new ValidationError('payout_account_id must be a Razorpay linked account id (acc_...)');
    }
    if (patch.platform_fee_bps !== undefined && !(Number.isInteger(patch.platform_fee_bps) && patch.platform_fee_bps >= 0 && patch.platform_fee_bps <= 5000)) {
      throw new ValidationError('platform_fee_bps must be 0–5000');
    }
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      this.db.run(`UPDATE communities SET ${k} = ? WHERE id = ?`, Array.isArray(v) ? JSON.stringify(v) : (v as any), id);
    }
    return this.community(id)!;
  }

  // ------------------------------------------------------------ staff

  addStaff(communityId: string, playerId: string, role: 'owner' | 'organiser'): void {
    this.db.run(
      `INSERT INTO community_staff (community_id, player_id, role, added_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (community_id, player_id) DO UPDATE SET role = excluded.role`,
      communityId, playerId, role, this.now(),
    );
  }

  removeStaff(communityId: string, playerId: string): void {
    const owners = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM community_staff WHERE community_id = ? AND role = 'owner' AND player_id != ?`, communityId, playerId,
    )!.n;
    const target = this.staffRole(communityId, playerId);
    if (target === 'owner' && owners === 0) throw new ValidationError('a community needs at least one owner', 409);
    this.db.run('DELETE FROM community_staff WHERE community_id = ? AND player_id = ?', communityId, playerId);
  }

  staffRole(communityId: string, playerId: string): 'owner' | 'organiser' | undefined {
    return this.db.get('SELECT role FROM community_staff WHERE community_id = ? AND player_id = ?', communityId, playerId)?.role;
  }

  staff(communityId: string): Row[] {
    return this.db.all(
      `SELECT s.player_id, s.role, s.added_at, p.name, p.phone FROM community_staff s JOIN players p ON p.id = s.player_id
       WHERE s.community_id = ? ORDER BY s.role DESC, p.name`, communityId,
    );
  }

  /** Communities this person runs. */
  staffCommunities(playerId: string): Row[] {
    return this.db.all(
      `SELECT c.*, s.role FROM community_staff s JOIN communities c ON c.id = s.community_id WHERE s.player_id = ? ORDER BY c.name`, playerId,
    );
  }

  /** Active communities this player belongs to. */
  playerCommunities(playerId: string): Row[] {
    return this.db.all(
      `SELECT c.*, m.status AS membership_status, m.tier FROM memberships m JOIN communities c ON c.id = m.community_id
       WHERE m.player_id = ? AND m.status != 'removed' ORDER BY m.joined_at`, playerId,
    );
  }

  community(id: string): Row | undefined {
    return this.db.get('SELECT * FROM communities WHERE id = ?', id);
  }

  communities(): Row[] {
    return this.db.all('SELECT * FROM communities ORDER BY created_at');
  }

  player(id: string): Row | undefined {
    return this.db.get('SELECT * FROM players WHERE id = ?', id);
  }

  playerByPhone(phone: string): Row | undefined {
    return this.db.get('SELECT * FROM players WHERE phone = ?', normalisePhone(phone));
  }

  upsertPlayer(phone: string, name?: string): Row {
    const p = normalisePhone(phone);
    const existing = this.playerByPhone(p);
    if (existing) {
      if (name && !existing.name) {
        this.db.run('UPDATE players SET name = ?, updated_at = ? WHERE id = ?', name, this.now(), existing.id);
      }
      return this.player(existing.id)!;
    }
    const id = newId('ply');
    this.db.run(
      `INSERT INTO players (id, phone, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      id, p, name ?? null, this.now(), this.now(),
    );
    return this.player(id)!;
  }

  touchInbound(playerId: string, at: string): void {
    this.db.run(
      `UPDATE players SET last_inbound_at = MAX(COALESCE(last_inbound_at, ''), ?) WHERE id = ?`, at, playerId,
    );
  }

  updateProfile(playerId: string, patch: Partial<{
    name: string; skill_level: string; preferred_locations: string[]; preferred_slots: string[];
  }>): Row {
    if (patch.skill_level && !SKILLS.includes(patch.skill_level as any)) throw new ValidationError(`invalid skill ${patch.skill_level}`);
    const cols: string[] = [];
    const vals: any[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      cols.push(`${k} = ?`);
      vals.push(Array.isArray(v) ? JSON.stringify(v) : v);
    }
    if (cols.length) this.db.run(`UPDATE players SET ${cols.join(', ')}, updated_at = ? WHERE id = ?`, ...vals, this.now(), playerId);
    return this.player(playerId)!;
  }

  membership(communityId: string, playerId: string): Row | undefined {
    return this.db.get('SELECT * FROM memberships WHERE community_id = ? AND player_id = ?', communityId, playerId);
  }

  setMembership(
    communityId: string, playerId: string, status: MembershipStatus, source = 'whatsapp', tier?: Tier,
  ): void {
    this.db.run(
      `INSERT INTO memberships (community_id, player_id, status, source, tier, joined_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (community_id, player_id) DO UPDATE SET status = excluded.status,
         tier = CASE WHEN ? IS NULL THEN memberships.tier ELSE excluded.tier END`,
      communityId, playerId, status, source, tier ?? 'guest', this.now(), tier ?? null,
    );
  }

  setTier(communityId: string, playerId: string, tier: Tier): void {
    if (!TIERS.includes(tier)) throw new ValidationError(`invalid tier ${tier}`);
    this.db.run('UPDATE memberships SET tier = ? WHERE community_id = ? AND player_id = ?', tier, communityId, playerId);
  }

  /** Consent is per community: agreeing to DOC's invites says nothing about another community. */
  setConsent(playerId: string, communityId: string, purpose: Purpose, granted: boolean, source: string): void {
    this.db.run(
      `INSERT INTO consents (player_id, community_id, purpose, granted, source, policy_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (player_id, community_id, purpose) DO UPDATE SET granted = excluded.granted, source = excluded.source,
         policy_version = excluded.policy_version, updated_at = excluded.updated_at`,
      playerId, communityId, purpose, granted ? 1 : 0, source, this.policyVersion, this.now(),
    );
  }

  /** STOP: revokes every consent the player has given, in every community. */
  revokeAll(playerId: string, source: string): void {
    this.db.run(
      `UPDATE consents SET granted = 0, source = ?, policy_version = ?, updated_at = ? WHERE player_id = ?`,
      source, this.policyVersion, this.now(), playerId,
    );
  }

  /** START: restores invites for every community the player is a member of. */
  grantAllMemberships(playerId: string, source: string): number {
    const cs = this.playerCommunities(playerId).filter((c) => c.membership_status === 'active');
    for (const c of cs) this.setConsent(playerId, c.id, 'community_games', true, source);
    return cs.length;
  }

  consents(playerId: string, communityId: string): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const c of this.db.all('SELECT purpose, granted FROM consents WHERE player_id = ? AND community_id = ?', playerId, communityId)) {
      out[c.purpose] = !!c.granted;
    }
    return out;
  }

  /** Members waiting for organiser approval (join_policy = approval). */
  pendingMembers(communityId: string): Row[] {
    return this.db.all(
      `SELECT p.id, p.name, p.phone, p.skill_level, p.preferred_locations, m.joined_at FROM memberships m JOIN players p ON p.id = m.player_id
       WHERE m.community_id = ? AND m.status = 'requested' ORDER BY m.joined_at`, communityId,
    ).map((r) => ({ ...r, preferred_locations: json.parse(r.preferred_locations, []) }));
  }

  /** Organiser-side bulk import of an existing member list (e.g. a WhatsApp group export). */
  importMembers(communityId: string, rows: ImportRow[]): { created: number; updated: number; errors: { row: number; error: string }[] } {
    const out = { created: 0, updated: 0, errors: [] as { row: number; error: string }[] };
    this.db.tx(() => {
      rows.forEach((r, i) => {
        const phone = normalisePhone(String(r.phone ?? ''));
        if (phone.length < 11 || phone.length > 15) return void out.errors.push({ row: i, error: `invalid phone "${r.phone}"` });
        if (r.skill_level && !SKILLS.includes(r.skill_level as any)) return void out.errors.push({ row: i, error: `invalid skill "${r.skill_level}"` });
        if (r.tier && !TIERS.includes(r.tier)) return void out.errors.push({ row: i, error: `invalid tier "${r.tier}"` });
        const existed = !!this.playerByPhone(phone);
        const p = this.upsertPlayer(phone, r.name);
        this.updateProfile(p.id, {
          skill_level: p.skill_level ? undefined : r.skill_level,
          preferred_locations: r.preferred_locations?.length && json.parse(p.preferred_locations, []).length === 0 ? r.preferred_locations : undefined,
        });
        const existing = this.membership(communityId, p.id);
        if (!existing || existing.status === 'removed') this.setMembership(communityId, p.id, 'active', 'import', r.tier ?? 'regular');
        else if (r.tier) this.setTier(communityId, p.id, r.tier);
        if (r.opted_in) this.setConsent(p.id, communityId, 'community_games', true, 'organiser_import');
        existed ? out.updated++ : out.created++;
      });
    });
    return out;
  }

  listMembers(communityId: string, q?: string): Row[] {
    const like = q ? `%${q.toLowerCase()}%` : null;
    return this.db.all(
      `SELECT p.id, p.name, p.phone, p.skill_level, p.preferred_locations, p.preferred_slots, m.status, m.tier, m.source, m.joined_at,
         COALESCE(c.granted, 0) AS invites_ok,
         (SELECT COUNT(*) FROM registrations r JOIN events e ON e.id = r.event_id
            WHERE r.player_id = p.id AND e.community_id = m.community_id AND r.status = 'confirmed') AS games_confirmed,
         (SELECT COUNT(*) FROM registrations r JOIN events e ON e.id = r.event_id
            WHERE r.player_id = p.id AND e.community_id = m.community_id AND r.attendance = 'attended') AS games_attended,
         (SELECT MAX(e.starts_at) FROM registrations r JOIN events e ON e.id = r.event_id
            WHERE r.player_id = p.id AND e.community_id = m.community_id AND r.attendance = 'attended') AS last_played_at
       FROM memberships m JOIN players p ON p.id = m.player_id
       LEFT JOIN consents c ON c.player_id = p.id AND c.community_id = m.community_id AND c.purpose = 'community_games'
       WHERE m.community_id = ? AND m.status != 'removed'
         AND (? IS NULL OR LOWER(COALESCE(p.name, '')) LIKE ? OR p.phone LIKE ?)
       ORDER BY LOWER(COALESCE(p.name, p.phone))`,
      communityId, like, like, like,
    ).map((r) => ({ ...r, preferred_locations: json.parse(r.preferred_locations, []), preferred_slots: json.parse(r.preferred_slots, []), invites_ok: !!r.invites_ok }));
  }
}
