import { SOURCES, type Source } from '../_shared/contracts.ts';

export const LIVE_SOURCES: Source[] = ['stock', 'availability'];
const centralClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
});

export function dailyCycle(timestamp: number): string {
  const parts = Object.fromEntries(centralClock.formatToParts(timestamp).map(part => [part.type, part.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return Number(parts.hour) >= 2 ? date : new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

export function sourceFresh(source: Source, fetchedAt: string | null | undefined, now = Date.now()): boolean {
  const timestamp = Date.parse(fetchedAt ?? '');
  if (!Number.isFinite(timestamp) || timestamp > now + 5_000) return false;
  return LIVE_SOURCES.includes(source) ? now - timestamp <= 120_000 : dailyCycle(timestamp) === dailyCycle(now);
}

export function scheduledSources(snapshots: { source: Source; fetched_at: string }[], now = Date.now()): Source[] {
  const priority = [...LIVE_SOURCES, ...SOURCES.filter(source => !LIVE_SOURCES.includes(source))];
  return priority.filter(source => {
    const fetchedAt = snapshots.find(snapshot => snapshot.source === source)?.fetched_at;
    const timestamp = Date.parse(fetchedAt ?? '');
    if (!Number.isFinite(timestamp) || timestamp > now + 5_000) return true;
    return LIVE_SOURCES.includes(source) ? now - timestamp >= 55_000 : !sourceFresh(source, fetchedAt, now);
  });
}

export function retryDelay(failures: number, upstreamSeconds = 0): number {
  return Math.max(Math.min(3600, 60 * 2 ** Math.min(Math.max(failures - 1, 0), 6)), upstreamSeconds);
}

export function retryAfter(response: Response, now = Date.now()): number {
  const raw = response.headers.get('Retry-After');
  const seconds = raw && /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw ? (Date.parse(raw) - now) / 1000 : 0;
  const reset = Number(response.headers.get('X-Toast-RateLimit-Reset')) * 1000;
  return Math.max(1, Math.ceil(Number.isFinite(seconds) ? seconds : 0), Number.isFinite(reset) ? Math.ceil((reset - now) / 1000) : 0);
}