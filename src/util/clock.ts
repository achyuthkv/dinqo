/** Injectable clock so timers (holds, offers, reminders) are testable. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class ManualClock implements Clock {
  private t: number;
  constructor(start: Date | string = '2026-09-20T00:00:00.000Z') {
    this.t = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  set(to: Date | string): void {
    this.t = new Date(to).getTime();
  }
  advanceMinutes(m: number): void {
    this.t += m * 60_000;
  }
}

export const iso = (d: Date): string => d.toISOString();
export const addMinutes = (d: Date, m: number): Date => new Date(d.getTime() + m * 60_000);
