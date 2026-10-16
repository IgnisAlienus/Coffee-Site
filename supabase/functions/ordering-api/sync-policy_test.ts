import { dailyCycle, retryAfter, retryDelay, scheduledSources, sourceFresh } from './sync-policy.ts';
import { SOURCES } from '../_shared/contracts.ts';
import { openSession, sealSession } from './token-cache.ts';
import { ToastReader, type ToastSession, type ToastState } from './toast.ts';
import { createSyncService } from './sync-service.ts';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import type { Snapshot } from './domain.ts';

function assert(condition: unknown, message: string) { if (!condition) throw new Error(message); }
const timestamp = (value: string) => Date.parse(value);

Deno.test('daily sync changes at 2am Central and handles both daylight saving transitions', () => {
  assert(dailyCycle(timestamp('2026-10-15T06:59:59Z')) === '2026-10-14', 'Before 2am CDT belongs to yesterday');
  assert(dailyCycle(timestamp('2026-10-15T07:00:00Z')) === '2026-10-15', '2am CDT begins new cycle');
  assert(dailyCycle(timestamp('2026-03-08T07:59:59Z')) === '2026-03-07', 'Spring 1:59am is before the daily sync');
  assert(dailyCycle(timestamp('2026-03-08T08:00:00Z')) === '2026-03-08', 'Skipped spring 2am runs at 3am');
  for (const time of ['2026-11-01T06:00:00Z', '2026-11-01T07:00:00Z']) {
    assert(dailyCycle(timestamp(time)) === '2026-10-31', 'Both repeated 1am hours precede the daily sync');
  }
  assert(dailyCycle(timestamp('2026-11-01T08:00:00Z')) === '2026-11-01', 'Fall 2am CST begins one daily cycle');
});

Deno.test('scheduler prioritizes live sources and refreshes daily sources once per Central cycle', () => {
  const now = timestamp('2026-10-15T08:00:00Z');
  const fresh = SOURCES.map(source => ({ source, fetched_at: new Date(now - 60_000).toISOString() }));
  assert(JSON.stringify(scheduledSources(fresh, now)) === '["stock","availability"]', 'Only live sources need minute polling');
  const previous = fresh.map(snapshot => ({ ...snapshot, fetched_at: '2026-10-14T08:00:00Z' }));
  assert(scheduledSources(previous, now).length === 8, 'Daily sources are due after next 2am');
  assert(sourceFresh('menus', '2026-10-15T07:01:00Z', now), 'Daily snapshots stay fresh beyond 15 minutes');
  assert(!sourceFresh('stock', '2026-10-15T07:57:59Z', now), 'Live data expires after two minutes');
});

Deno.test('rate-limit and failure delays honor Retry-After and reset timestamps', () => {
  const now = timestamp('2026-10-15T08:00:00Z');
  assert(retryAfter(new Response('', { headers: { 'Retry-After': '120' } }), now) === 120, 'Honor seconds');
  assert(retryAfter(new Response('', { headers: { 'Retry-After': 'Thu, 15 Oct 2026 08:02:00 GMT' } }), now) === 120, 'Honor HTTP date');
  assert(retryAfter(new Response('', { headers: { 'X-Toast-RateLimit-Reset': String(now / 1000 + 180) } }), now) === 180, 'Honor later reset');
  assert(retryDelay(1) === 60 && retryDelay(3) === 240 && retryDelay(20) === 3600, 'Back off repeated failures');
  assert(retryDelay(1, 7200) === 7200, 'Never shorten upstream cooldown');
});

Deno.test('durable token cache encrypts tokens and rejects tampered data or a different key', async () => {
  const session = { accessToken: 'private-toast-token', expiresAt: Date.now() + 3600_000 };
  const sealed = await sealSession(session, 'test-service-key');
  assert(!sealed.includes(session.accessToken), 'Stored ciphertext must not expose token');
  assert((await openSession(sealed, 'test-service-key'))?.accessToken === session.accessToken, 'Token must survive a cold start');
  assert(await openSession(sealed, 'wrong-key') === null && await openSession(sealed + 'tampered', 'test-service-key') === null, 'Invalid ciphertext must fail closed');
});

Deno.test('cold Toast readers reuse the same durable token and stop at rate limits', async () => {
  let session: ToastSession | null = null;
  let authentications = 0;
  let guarded = 0;
  let cooldown = 0;
  let limited = false;
  const state: ToastState = {
    loadToken: async () => session, saveToken: async value => { session = value; },
    invalidateToken: async () => { session = null; }, claimAuthentication: async () => true,
    beforeRequest: async () => { guarded++; }, rateLimited: async seconds => { cooldown = seconds; },
  };
  const fetcher: typeof fetch = async input => {
    if (String(input).includes('/authentication/')) { authentications++; return Response.json({ token: { accessToken: 'secret', expiresIn: 86400 } }); }
    return limited ? new Response('private body', { status: 429, headers: { 'Retry-After': '180' } }) : Response.json([]);
  };
  const config = { baseUrl: 'https://toast.example', clientId: 'id', clientSecret: 'secret', restaurantGuid: '00000000-0000-4000-8000-000000000001' };
  await new ToastReader(config, fetcher, state).read('stock');
  await new ToastReader(config, fetcher, state).read('stock');
  assert(authentications === 1 && guarded === 3, 'Each HTTP request must be guarded but cold starts must not reauthenticate');
  limited = true;
  let code = '';
  try { await new ToastReader(config, fetcher, state).read('stock'); } catch (error) { code = (error as Error).message; }
  assert(code === 'RATE_LIMITED' && cooldown === 180 && authentications === 1, 'Persist Retry-After without immediate retries');
});

Deno.test('sync worker fetches only requested or due sources and stops on upstream 429', async () => {
  const now = Date.now();
  const snapshots: Snapshot[] = SOURCES.map(source => ({ source, fetched_at: new Date(now).toISOString(), payload: source === 'menus' ? { restaurantGuid: '00000000-0000-4000-8000-000000000001', menus: [] } : {} }));
  const ciphertext = await sealSession({ accessToken: 'cached-token', expiresAt: now + 86400_000 }, 'test-key');
  const completions: Record<string, unknown>[] = [];
  const requests: string[] = [];
  let blocked = 0;
  let limited = false;
  let released = 0;
  const client = {
    rpc(name: string, args: Record<string, unknown> = {}) {
      let data: unknown = null;
      if (name === 'claim_toast_worker') data = 'lease';
      if (name === 'reserve_toast_request') data = { waitMs: 0 };
      if (name === 'claim_toast_source') data = { failures: 0 };
      if (name === 'complete_toast_source') {
        completions.push(args);
        if (args.p_code === 'SYNCED') {
          const snapshot = snapshots.find(snapshot => snapshot.source === args.p_source)!;
          snapshot.payload = args.p_payload; snapshot.fetched_at = new Date().toISOString();
        }
      }
      if (name === 'block_toast_requests') blocked = Number(args.p_seconds);
      if (name === 'finish_toast_worker') released++;
      return { abortSignal: () => Promise.resolve({ data, error: null }) };
    },
    from(table: string) {
      const data = table === 'toast_auth_cache' ? { ciphertext, expires_at: new Date(now + 86400_000).toISOString() }
        : table === 'integration_control' ? { locked_until: '-infinity', blocked_until: '-infinity', project_url: 'https://project.supabase.co', last_tick_at: null }
        : SOURCES.map(source => ({ source, failures: 0 }));
      const result = { data, error: null };
      const builder = {
        select: () => builder, eq: () => builder,
        single: () => Promise.resolve(result), maybeSingle: () => Promise.resolve(result),
        then: <Value>(resolve: (value: typeof result) => Value) => Promise.resolve(resolve(result)),
      };
      return builder;
    },
  };
  const service = createSyncService({
    database: () => client as unknown as SupabaseClient,
    snapshots: async () => snapshots, encryptionKey: () => 'test-key', message: code => code,
    config: () => ({ baseUrl: 'https://toast.example', clientId: 'id', clientSecret: 'secret', restaurantGuid: '00000000-0000-4000-8000-000000000001' }),
    fetcher: async input => {
      const path = String(input); requests.push(path);
      if (limited) return new Response('', { status: 429, headers: { 'Retry-After': '300' } });
      return path.includes('availability') ? Response.json({ status: 'ONLINE' }) : Response.json([]);
    },
  });
  await service.run('manual', 'manager-id', 'request-id', 'stock');
  assert(requests.length === 1 && requests[0].endsWith('/stock/v1/inventory'), 'Single-source sync must not fetch other sources or reauthenticate');
  assert(completions[0].p_actor === 'manager-id' && completions[0].p_trigger === 'manual', 'Manual sync must record its actor');
  requests.length = completions.length = 0;
  for (const snapshot of snapshots.filter(snapshot => ['stock', 'availability'].includes(snapshot.source))) snapshot.fetched_at = new Date(now - 60_000).toISOString();
  await service.run('scheduled', null, 'scheduled-request');
  assert(requests.length === 2 && completions.every(entry => entry.p_trigger === 'scheduled' && entry.p_actor === null), 'Scheduler must refresh only the two live sources');
  requests.length = completions.length = 0;
  for (const snapshot of snapshots.filter(snapshot => ['stock', 'availability'].includes(snapshot.source))) snapshot.fetched_at = new Date(now - 60_000).toISOString();
  limited = true;
  const previous = snapshots.find(snapshot => snapshot.source === 'stock')!.fetched_at;
  await service.run('scheduled', null, 'limited-request');
  assert(requests.length === 1 && completions[0].p_code === 'RATE_LIMITED', 'Rate limit must stop the batch');
  assert(blocked === 300 && completions[0].p_retry_seconds === 300, 'Persist the full upstream pause');
  assert(snapshots.find(snapshot => snapshot.source === 'stock')!.fetched_at === previous && released === 3, 'Preserve snapshot and always release worker');
});