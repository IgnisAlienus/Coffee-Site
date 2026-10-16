import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import {
  freshness,
  record,
  text,
  SOURCES,
  type Snapshot,
  type Source,
} from './domain.ts';
import {
  ConnectorError,
  ToastReader,
  type ToastConfig,
  type ToastState,
} from './toast.ts';
import { retryDelay, scheduledSources } from './sync-policy.ts';
import { openSession, sealSession } from './token-cache.ts';

type Options = {
  database(): SupabaseClient;
  snapshots(): Promise<Snapshot[]>;
  config(): ToastConfig;
  encryptionKey(): string;
  message(code: string): string;
  fetcher?: typeof fetch;
};

export function createSyncService(options: Options) {
  async function rpc(name: string, args: Record<string, unknown> = {}) {
    const { data, error } = await options
      .database()
      .rpc(name, args)
      .abortSignal(AbortSignal.timeout(8_000));
    if (error) throw new ConnectorError('SYNC_STATE_UNAVAILABLE');
    return data;
  }

  async function status() {
    const client = options.database();
    const { data: states, error } = await client
      .from('toast_sync_state')
      .select(
        'source,last_attempt_at,next_attempt_at,failures,last_code,last_outcome',
      );
    if (error) throw new ConnectorError('SYNC_STATE_UNAVAILABLE');
    const { data: control, error: controlError } = await client
      .from('integration_control')
      .select('locked_until,blocked_until,project_url,last_tick_at')
      .eq('id', true)
      .single();
    if (controlError) throw new ConnectorError('SYNC_STATE_UNAVAILABLE');
    return {
      sources: freshness(await options.snapshots()).map((source) => ({
        ...source,
        ...states!.find((state) => state.source === source.source),
      })),
      schedule: {
        timeZone: 'America/Chicago',
        dailyAt: '02:00',
        liveEverySeconds: 60,
        ready: Boolean(control.project_url),
        lastTickAt: control.last_tick_at,
        blockedUntil:
          control.blocked_until === '-infinity' ? null : control.blocked_until,
        workerActive: Date.parse(control.locked_until) > Date.now(),
      },
    };
  }

  async function withReader<Value>(
    operation: (
      reader: ToastReader,
      lease: string,
      deadline: number,
    ) => Promise<Value>,
  ): Promise<Value> {
    const lease = (await rpc('claim_toast_worker')) as string | null;
    if (!lease) throw new ConnectorError('SYNC_BUSY', null, 60);
    const deadline = Date.now() + 45_000;
    try {
      const config = options.config();
      if (!config.restaurantGuid)
        config.restaurantGuid =
          text(
            record(
              (await options.snapshots()).find(
                (snapshot) => snapshot.source === 'menus',
              )?.payload,
            ).restaurantGuid,
          ) || undefined;
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(
          JSON.stringify([
            config.baseUrl,
            config.clientId,
            config.clientSecret,
          ]),
        ),
      );
      const cacheKey = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      const state: ToastState = {
        async beforeRequest() {
          if (Date.now() + 8500 > deadline)
            throw new ConnectorError('SYNC_DEFERRED', null, 60);
          const slot = await rpc('reserve_toast_request', { p_lease: lease });
          if (slot.blockedSeconds)
            throw new ConnectorError('RATE_LIMITED', 429, slot.blockedSeconds);
          if (slot.waitMs > 2000 || Date.now() + slot.waitMs + 8500 > deadline)
            throw new ConnectorError('SYNC_DEFERRED', null, 60);
          if (slot.waitMs > 0)
            await new Promise((resolve) => setTimeout(resolve, slot.waitMs));
        },
        async rateLimited(seconds) {
          await rpc('block_toast_requests', {
            p_lease: lease,
            p_seconds: seconds,
          });
        },
        async loadToken() {
          const { data, error } = await options
            .database()
            .from('toast_auth_cache')
            .select('ciphertext,expires_at')
            .eq('cache_key', cacheKey)
            .maybeSingle();
          if (error) throw new ConnectorError('SYNC_STATE_UNAVAILABLE');
          return data?.ciphertext && Date.parse(data.expires_at) > Date.now()
            ? openSession(data.ciphertext, options.encryptionKey())
            : null;
        },
        async saveToken(session) {
          const { error } = await options
            .database()
            .from('toast_auth_cache')
            .update({
              ciphertext: await sealSession(session, options.encryptionKey()),
              expires_at: new Date(session.expiresAt).toISOString(),
            })
            .eq('cache_key', cacheKey);
          if (error) throw new ConnectorError('SYNC_STATE_UNAVAILABLE');
        },
        async invalidateToken() {
          const { error } = await options
            .database()
            .from('toast_auth_cache')
            .update({ ciphertext: null, expires_at: null })
            .eq('cache_key', cacheKey);
          if (error) throw new ConnectorError('SYNC_STATE_UNAVAILABLE');
        },
        async claimAuthentication() {
          const claimed = await rpc('claim_toast_auth', {
            p_lease: lease,
            p_cache_key: cacheKey,
          });
          if (!claimed)
            await rpc('block_toast_requests', {
              p_lease: lease,
              p_seconds: 1800,
            });
          return Boolean(claimed);
        },
      };
      return await operation(
        new ToastReader(config, options.fetcher ?? fetch, state),
        lease,
        deadline,
      );
    } catch (error) {
      if (
        error instanceof ConnectorError &&
        ['AUTH_COOLDOWN', 'TOAST_AUTH_FAILED'].includes(error.code)
      ) {
        await rpc('block_toast_requests', { p_lease: lease, p_seconds: 1800 });
      }
      throw error;
    } finally {
      await rpc('finish_toast_worker', { p_lease: lease });
    }
  }

  async function run(
    trigger: 'manual' | 'scheduled',
    actor: string | null,
    requestId: string,
    requested: Source | 'all' = 'all',
  ) {
    try {
      return await withReader(async (reader, lease, deadline) => {
        const selected =
          requested !== 'all'
            ? [requested]
            : trigger === 'scheduled'
              ? scheduledSources(await options.snapshots())
              : [...SOURCES];
        const results: {
          source: Source;
          outcome: string;
          code: string;
          message?: string;
          upstreamStatus?: number | null;
        }[] = [];
        for (const source of selected) {
          if (Date.now() + 9_000 > deadline) {
            results.push({
              source,
              outcome: 'skipped',
              code: 'SYNC_DEFERRED',
              message: options.message('SYNC_DEFERRED'),
            });
            break;
          }
          const state = await rpc('claim_toast_source', {
            p_lease: lease,
            p_source: source,
          });
          if (!state) {
            results.push({
              source,
              outcome: 'skipped',
              code: 'SOURCE_COOLDOWN',
              message: options.message('SOURCE_COOLDOWN'),
            });
            continue;
          }
          let payload: unknown = null;
          let code = 'SYNCED';
          let upstreamStatus: number | null = null;
          let upstreamDelay = 0;
          try {
            payload = await reader.read(source);
          } catch (error) {
            code = error instanceof ConnectorError ? error.code : 'SYNC_FAILED';
            upstreamStatus =
              error instanceof ConnectorError ? error.upstreamStatus : null;
            upstreamDelay =
              error instanceof ConnectorError ? error.retrySeconds : 0;
          }
          const delay = retryDelay(Number(state.failures) + 1, upstreamDelay);
          await rpc('complete_toast_source', {
            p_lease: lease,
            p_source: source,
            p_payload: payload,
            p_code: code,
            p_status: upstreamStatus,
            p_retry_seconds: delay,
            p_actor: actor,
            p_request_id: requestId,
            p_trigger: trigger,
          });
          results.push({
            source,
            outcome: code === 'SYNCED' ? 'success' : 'failed',
            code,
            upstreamStatus,
            ...(code === 'SYNCED' ? {} : { message: options.message(code) }),
          });
          if (['TOAST_AUTH_FAILED', 'AUTH_COOLDOWN'].includes(code))
            await rpc('block_toast_requests', {
              p_lease: lease,
              p_seconds: 1800,
            });
          if (
            [
              'TOAST_AUTH_FAILED',
              'AUTH_COOLDOWN',
              'RATE_LIMITED',
              'SYNC_DEFERRED',
              'TOAST_NOT_CONFIGURED',
              'RESTAURANT_SELECTION_REQUIRED',
              'NO_ACCESSIBLE_RESTAURANTS',
              'DISCOVERY_NOT_PERMITTED',
              'SYNC_STATE_UNAVAILABLE',
            ].includes(code)
          )
            break;
        }
        return { results, ...(await status()), checkoutEnabled: false };
      });
    } catch (error) {
      if (error instanceof ConnectorError && error.code === 'SYNC_BUSY')
        return {
          results: [],
          deferred: true,
          message: options.message('SYNC_BUSY'),
          ...(await status()),
          checkoutEnabled: false,
        };
      throw error;
    }
  }

  return {
    run,
    status,
    discover: () => withReader((reader) => reader.discoverRestaurants()),
  };
}
