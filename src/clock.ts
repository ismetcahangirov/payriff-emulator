export const DAY_MS = 86_400_000;

export class Clock {
  private offsetMs = 0;

  constructor(private readonly source: () => number = Date.now) {}

  now(): Date {
    return new Date(this.source() + this.offsetMs);
  }

  advance(ms: number): void {
    this.offsetMs += ms;
  }

  reset(): void {
    this.offsetMs = 0;
  }

  get offset(): number {
    return this.offsetMs;
  }
}

const DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

export function parseDuration(text: string): number | null {
  const normalised = text.trim().toUpperCase();
  const match = DURATION.exec(normalised);
  if (!match || normalised === 'P' || normalised.endsWith('T')) {
    return null;
  }
  const [, days, hours, minutes, seconds] = match;
  return (
    ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes ?? 0)) * 60_000 + Number(seconds ?? 0) * 1000
  );
}

export function localDateTime(date: Date): string {
  return date.toISOString().slice(0, 19);
}
