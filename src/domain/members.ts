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

  createCommunity(input: { name: string; slug: string; locations?: string[]; timezone?: string }): Row {
    const id = newId('com');
    this.db.run(
      `INSERT INTO communities (id, name, slug, timezone, locations, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      id, input.name, input.slug, input.timezone ?? 'Asia/Kolkata', JSON.stringify(input.locations ?? []), this.now(),
    );
    return this.community(id)!;
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
    if (patch.skill_level && !SKILLS.includes(patch.skill_level as any)) throw new Error(`invalid skill ${patch.skill_level}`);
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
    communityId: string, playerId: string, status: 'pending' | 'active' | 'removed', source = 'whatsapp', tier?: Tier,
  ): void {
    this.db.run(
      `INSERT INTO memberships (community_id, player_id, status, source, tier, joined_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (community_id, player_id) DO UPDATE SET status = excluded.status,
         tier = CASE WHEN ? IS NULL THEN memberships.tier ELSE excluded.tier END`,
      communityId, playerId, status, source, tier ?? 'guest', this.now(), tier ?? null,
    );
  }

  setTier(communityId: string, playerId: string, tier: Tier): void {
    if (!TIERS.includes(tier)) throw new Error(`invalid tier ${tier}`);
    this.db.run('UPDATE memberships SET tier = ? WHERE community_id = ? AND player_id = ?', tier, communityId, playerId);
  }

  setConsent(playerId: string, purpose: Purpose, granted: boolean, source: string): void {
    this.db.run(
      `INSERT INTO consents (player_id, purpose, granted, source, policy_version, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (player_id, purpose) DO UPDATE SET granted = excluded.granted, source = excluded.source,
         policy_version = excluded.policy_version, updated_at = excluded.updated_at`,
      playerId, purpose, granted ? 1 : 0, source, this.policyVersion, this.now(),
    );
  }

  consents(playerId: string): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const c of this.db.all('SELECT purpose, granted FROM consents WHERE player_id = ?', playerId)) out[c.purpose] = !!c.granted;
    return out;
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
        if (r.opted_in) this.setConsent(p.id, 'community_games', true, 'organiser_import');
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
       LEFT JOIN consents c ON c.player_id = p.id AND c.purpose = 'community_games'
       WHERE m.community_id = ? AND m.status != 'removed'
         AND (? IS NULL OR LOWER(COALESCE(p.name, '')) LIKE ? OR p.phone LIKE ?)
       ORDER BY LOWER(COALESCE(p.name, p.phone))`,
      communityId, like, like, like,
    ).map((r) => ({ ...r, preferred_locations: json.parse(r.preferred_locations, []), preferred_slots: json.parse(r.preferred_slots, []), invites_ok: !!r.invites_ok }));
  }
}
