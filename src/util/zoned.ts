/** Minimal time-zone math on top of Intl (no dependencies). */

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

export interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; weekday: Weekday }

export function localParts(d: Date, tz: string): LocalParts {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
      weekday: 'short', hourCycle: 'h23',
    });
    partsFormatters.set(tz, f);
  }
  const parts = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute),
    weekday: parts.weekday.toLowerCase().slice(0, 3) as Weekday,
  };
}

/** The UTC instant at which the wall clock in `tz` reads the given local time. */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (t: number) => {
    const p = localParts(new Date(t), tz);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - t;
  };
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t); // second pass settles DST edges
  return new Date(t);
}

export function parseHHMM(s: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`invalid time "${s}", expected HH:MM`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** Local-midnight-anchored calendar days starting at `from` (inclusive), as local y/m/d + weekday. */
export function* localDays(from: Date, days: number, tz: string): Generator<{ year: number; month: number; day: number; weekday: Weekday }> {
  const start = localParts(from, tz);
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.UTC(start.year, start.month - 1, start.day + i));
    yield { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: WEEKDAYS[d.getUTCDay()] };
  }
}

/** Next instant strictly after `after` that falls on one of `weekdays` at local `hhmm`. */
export function nextOccurrence(after: Date, weekdays: string[], hhmm: string, tz: string): Date | null {
  const { hour, minute } = parseHHMM(hhmm);
  for (const d of localDays(after, 8, tz)) {
    if (!weekdays.includes(d.weekday)) continue;
    const at = zonedToUtc(d.year, d.month, d.day, hour, minute, tz);
    if (at > after) return at;
  }
  return null;
}

/** 'sunday_morning' style slot key matching player preferences. */
export function slotKey(startsAt: Date, tz: string): string {
  const p = localParts(startsAt, tz);
  const part = p.hour < 12 ? 'morning' : 'evening';
  if (p.weekday === 'sat') return `saturday_${part}`;
  if (p.weekday === 'sun') return `sunday_${part}`;
  return `weekday_${part}`;
}
