const TZ = 'Asia/Kolkata';

// Building an Intl.DateTimeFormat is expensive (~0.1 ms); a poll formats thousands of dates.
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(kind: string, tz: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${kind}|${tz}`;
  let f = formatters.get(key);
  if (!f) formatters.set(key, (f = new Intl.DateTimeFormat('en-IN', { ...opts, timeZone: tz })));
  return f;
}

export function rupees(paise: number): string {
  const r = paise / 100;
  return '₹' + (Number.isInteger(r) ? r.toLocaleString('en-IN') : r.toFixed(2));
}

/** "Sun, 20 Sep" */
export function day(isoStr: string, tz = TZ): string {
  return formatter('day', tz, { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(isoStr));
}

/** "7:00 am" */
export function time(isoStr: string, tz = TZ): string {
  return formatter('time', tz, { hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(isoStr)).toLowerCase();
}

/** "Sun, 20 Sep, 7:00 am" */
export function when(isoStr: string, tz = TZ): string {
  return `${day(isoStr, tz)}, ${time(isoStr, tz)}`;
}

/** WhatsApp sends numbers as digits with country code; accept "+91 98450 12345" etc. */
export function normalisePhone(raw: string, defaultCountry = '91'): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return defaultCountry + digits;
  if (digits.length === 11 && digits.startsWith('0')) return defaultCountry + digits.slice(1);
  return digits;
}
