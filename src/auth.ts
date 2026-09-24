import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Db, Row } from './db/index.ts';
import type { Members } from './domain/members.ts';
import type { Outbox } from './messaging/outbox.ts';
import { type Clock, addMinutes, iso } from './util/clock.ts';
import { normalisePhone } from './util/format.ts';
import { newId } from './util/ids.ts';

const CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_15_MIN = 3;
const MAX_CODES_PER_DAY = 10;
const SESSION_DAYS = 30;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export type RequestCodeResult = { ok: true; devCode?: string } | { ok: false; reason: 'invalid_phone' | 'rate_limited' };

export interface Principal {
  player: Row;
  platformAdmin: boolean;
}

/**
 * Organiser console login: a 6-digit code sent from the Dinqo WhatsApp number
 * (authentication template), exchanged for a 30-day session.
 */
export class Auth {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly members: Members,
    private readonly outbox: Outbox,
    private readonly opts: { platformAdminPhones: string[]; exposeDevCodes: boolean },
  ) {}

  isPlatformAdmin(phone: string): boolean {
    return this.opts.platformAdminPhones.map((p) => normalisePhone(p)).includes(phone);
  }

  requestCode(rawPhone: string): RequestCodeResult {
    const phone = normalisePhone(rawPhone);
    if (!/^\d{11,15}$/.test(phone)) return { ok: false, reason: 'invalid_phone' };
    const since = (m: number) => this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM login_codes WHERE phone = ? AND created_at >= ?', phone, iso(addMinutes(this.clock.now(), -m)),
    )!.n;
    if (since(15) >= MAX_CODES_PER_15_MIN || since(24 * 60) >= MAX_CODES_PER_DAY) return { ok: false, reason: 'rate_limited' };

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const player = this.members.upsertPlayer(phone);
    this.db.run(
      `INSERT INTO login_codes (id, phone, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
      newId('otp'), phone, sha(`${phone}:${code}`), iso(this.clock.now()), iso(addMinutes(this.clock.now(), CODE_TTL_MINUTES)),
    );
    this.outbox.send({
      playerId: player.id, category: 'authentication',
      envelope: {
        session: { kind: 'text', text: `*${code}* is your Dinqo organiser login code. It expires in ${CODE_TTL_MINUTES} minutes. Don't share it with anyone.` },
        template: { name: 'dinqo_login_code', params: [code], otpCode: code },
      },
    });
    return this.opts.exposeDevCodes ? { ok: true, devCode: code } : { ok: true };
  }

  /** Returns a session token, or null if the code is wrong, expired or exhausted. */
  verifyCode(rawPhone: string, code: string): { token: string; expiresAt: string } | null {
    const phone = normalisePhone(rawPhone);
    return this.db.tx(() => {
      const row = this.db.get(
        `SELECT * FROM login_codes WHERE phone = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1`,
        phone, iso(this.clock.now()),
      );
      if (!row || row.attempts >= MAX_ATTEMPTS) return null;
      const given = Buffer.from(sha(`${phone}:${String(code ?? '').trim()}`));
      if (!timingSafeEqual(given, Buffer.from(row.code_hash))) {
        this.db.run('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?', row.id);
        return null;
      }
      this.db.run('UPDATE login_codes SET used_at = ? WHERE id = ?', iso(this.clock.now()), row.id);
      const player = this.members.playerByPhone(phone)!;
      const token = randomBytes(32).toString('base64url');
      const expiresAt = iso(addMinutes(this.clock.now(), SESSION_DAYS * 24 * 60));
      this.db.run(
        'INSERT INTO sessions (token_hash, player_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
        sha(token), player.id, iso(this.clock.now()), expiresAt,
      );
      return { token, expiresAt };
    });
  }

  session(token: string | undefined): Principal | null {
    if (!token) return null;
    const s = this.db.get('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?', sha(token), iso(this.clock.now()));
    if (!s) return null;
    const player = this.members.player(s.player_id);
    if (!player) return null;
    return { player, platformAdmin: this.isPlatformAdmin(player.phone) };
  }

  logout(token: string | undefined): void {
    if (token) this.db.run('DELETE FROM sessions WHERE token_hash = ?', sha(token));
  }
}
