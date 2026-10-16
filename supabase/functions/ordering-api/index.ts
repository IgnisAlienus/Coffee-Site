import {
  createClient,
  type SupabaseClient,
} from 'npm:@supabase/supabase-js@2.57.4';
import { record, text, type Snapshot } from './domain.ts';
import {
  ApiError,
  createHandler,
  type Backend,
  type Staff,
} from './handler.ts';
import { ConnectorError } from './toast.ts';
import { createSyncService } from './sync-service.ts';
import {
  limitedBody,
  menuEntities,
  photoExtension,
  validateOverride,
} from './menu-overrides.ts';
import type { MenuOverride } from '../_shared/contracts.ts';

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value)
    throw new ApiError(
      503,
      'SERVER_NOT_CONFIGURED',
      'The service is not configured yet.',
    );
  return value;
}

function key(legacy: string, modern: string): string {
  const legacyValue = Deno.env.get(legacy);
  if (legacyValue) return legacyValue;
  const values = JSON.parse(Deno.env.get(modern) ?? '{}');
  if (!values.default)
    throw new ApiError(
      503,
      'SERVER_NOT_CONFIGURED',
      'The service is not configured yet.',
    );
  return values.default;
}

function database(token?: string): SupabaseClient {
  return createClient(
    required('SUPABASE_URL'),
    token
      ? key('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEYS')
      : key('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEYS'),
    {
      auth: { persistSession: false, autoRefreshToken: false },
      ...(token
        ? { global: { headers: { Authorization: `Bearer ${token}` } } }
        : {}),
    },
  );
}

function check(error: unknown) {
  if (error)
    throw new ApiError(
      503,
      'DATABASE_UNAVAILABLE',
      'Order data is temporarily unavailable.',
    );
}

async function snapshots(): Promise<Snapshot[]> {
  const { data, error } = await database()
    .from('toast_snapshots')
    .select('source,payload,fetched_at');
  check(error);
  return data as Snapshot[];
}

async function overrides(payload: unknown): Promise<MenuOverride[]> {
  const restaurantGuid = text(record(payload).restaurantGuid);
  if (!restaurantGuid) return [];
  const entries: MenuOverride[] = [];
  for (let start = 0; start < 10_000; start += 1_000) {
    const { data, error } = await database()
      .from('menu_overrides')
      .select('entity_type,entity_id,display_name,hidden,photo_url')
      .eq('restaurant_guid', restaurantGuid)
      .order('entity_type')
      .order('entity_id')
      .range(start, start + 999);
    check(error);
    entries.push(...(data as MenuOverride[]));
    if (data!.length < 1_000) return entries;
  }
  throw new ApiError(
    503,
    'MENU_TOO_LARGE',
    'The menu exceeds the current override limit.',
  );
}

async function importedMenu() {
  const snapshot = (await snapshots()).find(
    (entry) => entry.source === 'menus',
  );
  const restaurantGuid = text(record(snapshot?.payload).restaurantGuid);
  if (!snapshot || !/^[0-9a-f-]{36}$/i.test(restaurantGuid))
    throw new ApiError(
      503,
      'MENU_NOT_SYNCED',
      'Sync the Toast menu before editing it.',
    );
  return { payload: snapshot.payload, restaurantGuid };
}

function requireEntity(payload: unknown, override: MenuOverride) {
  const entity = menuEntities(payload).find(
    (entity) =>
      entity.entityType === override.entity_type &&
      entity.entityId === override.entity_id,
  );
  if (!entity)
    throw new ApiError(
      404,
      'MENU_ENTITY_NOT_FOUND',
      'This entity is no longer in the imported menu. Refresh the menu editor.',
    );
  return entity;
}

function connectionMessage(code: string): string {
  const messages: Record<string, string> = {
    DISCOVERY_NOT_PERMITTED:
      'Toast denied location discovery for these credentials. Find the location GUID in the Standard API activation email or contact Toast support, then set TOAST_RESTAURANT_GUID in Supabase secrets.',
    RESTAURANT_SELECTION_REQUIRED:
      'Multiple Toast locations are accessible. Find Restaurants lists their GUIDs; set TOAST_RESTAURANT_GUID in Supabase secrets to select this store.',
    NO_ACCESSIBLE_RESTAURANTS:
      'Toast returned no accessible locations. Check which locations are enabled for these credentials in Toast Web.',
    TOAST_AUTH_FAILED:
      'Toast authentication failed. Check the API hostname and credentials stored in Supabase secrets.',
    SYNC_BUSY:
      'Another sync is active or Toast requests are paused. Try again after the active run or cooldown ends.',
    SOURCE_COOLDOWN:
      'This source was recently refreshed or is waiting after an error. Check its next attempt time.',
    SYNC_DEFERRED:
      'The sync time budget was reached. Remaining due sources will be picked up by the next scheduled run.',
    RATE_LIMITED:
      'Toast requested a pause. Automatic and manual requests will respect its retry time.',
    AUTH_COOLDOWN:
      'Toast authentication is paused to avoid repeated token requests. Existing snapshots are preserved.',
  };
  return (
    messages[code] ??
    'The Toast connection could not be completed. Review the connection logs.'
  );
}

const syncService = createSyncService({
  database,
  snapshots,
  encryptionKey: () => key('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEYS'),
  message: connectionMessage,
  config: () => ({
    baseUrl: required('TOAST_API_BASE_URL'),
    clientId: required('TOAST_CLIENT_ID'),
    clientSecret: required('TOAST_CLIENT_SECRET'),
    restaurantGuid: Deno.env.get('TOAST_RESTAURANT_GUID')?.trim() || undefined,
  }),
});
let schedulerSetup: Promise<void> | undefined;

const backend: Backend = {
  async ready() {
    try {
      schedulerSetup ??= (async () => {
        const { error } = await database().rpc('configure_toast_scheduler', {
          p_project_url: required('SUPABASE_URL'),
        });
        check(error);
      })();
      await schedulerSetup;
    } catch {
      schedulerSetup = undefined;
      throw new ApiError(
        503,
        'SCHEDULER_SETUP_FAILED',
        'The sync service is not ready.',
      );
    }
  },
  snapshots,
  overrides,
  async authenticate(request) {
    const token = request.headers
      .get('Authorization')
      ?.match(/^Bearer (.+)$/i)?.[1];
    if (!token)
      throw new ApiError(401, 'SIGN_IN_REQUIRED', 'Sign in to continue.');
    const client = database(token);
    const { data: auth, error: authError } = await client.auth.getUser(token);
    if (authError || !auth.user)
      throw new ApiError(
        401,
        'SESSION_INVALID',
        'Your session has expired. Sign in again.',
      );
    const { data: member, error } = await client
      .from('staff_members')
      .select('role,active')
      .eq('user_id', auth.user.id)
      .maybeSingle();
    check(error);
    if (!member?.active)
      throw new ApiError(
        403,
        'STAFF_REQUIRED',
        'An active staff account is required.',
      );
    const { data: effectiveRole, error: roleError } =
      await client.rpc('staff_role');
    check(roleError);
    return {
      id: auth.user.id,
      role: member.role,
      token,
      mfaRequired: member.role === 'manager' && effectiveRole !== 'manager',
    } as Staff;
  },
  async orders(staff, page, status) {
    let query = database(staff.token)
      .from('orders')
      .select(
        'id,toast_order_guid,status,payment_status,customer_name,total_minor,currency,created_at',
        { count: 'exact' },
      );
    if (status) query = query.eq('status', status);
    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(page * 25, page * 25 + 24);
    check(error);
    return { orders: data, total: count, page, pageSize: 25 };
  },
  async order(staff, id) {
    const { data, error } = await database(staff.token)
      .from('orders')
      .select(
        'id,toast_order_guid,status,payment_status,customer_name,total_minor,currency,items,created_at,updated_at',
      )
      .eq('id', id)
      .maybeSingle();
    check(error);
    if (!data) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found.');
    return data;
  },
  async events(staff, id, page, requestId) {
    const { error: auditError } = await database()
      .from('integration_events')
      .insert({
        correlation_id: requestId,
        actor_user_id: staff.id,
        source: `order:${id}`,
        outcome: 'success',
        code: 'AUDIT_VIEWED',
      });
    check(auditError);
    const { data, error } = await database(staff.token)
      .from('order_events')
      .select(
        'id,order_id,occurred_at,correlation_id,actor_user_id,event_type,summary,origin_ip,user_agent,provider_reference,upstream_status,policy_version,fulfillment_reference',
      )
      .eq('order_id', id)
      .order('occurred_at', { ascending: false })
      .order('id', { ascending: false })
      .range(page * 50, page * 50 + 49);
    check(error);
    return { events: data, page, pageSize: 50 };
  },
  async integrations(staff, page) {
    const { data, error } = await database(staff.token)
      .from('integration_events')
      .select(
        'id,occurred_at,correlation_id,actor_user_id,source,outcome,code,upstream_status,trigger_type',
      )
      .order('occurred_at', { ascending: false })
      .order('id', { ascending: false })
      .range(page * 50, page * 50 + 49);
    check(error);
    return {
      events: data,
      ...(await syncService.status()),
      page,
      pageSize: 50,
    };
  },
  async restaurants(staff, requestId) {
    let restaurants;
    let failure: unknown;
    try {
      restaurants = await syncService.discover();
    } catch (error) {
      failure = error;
    }
    const code =
      failure instanceof ConnectorError || failure instanceof ApiError
        ? failure.code
        : failure
          ? 'DISCOVERY_FAILED'
          : 'LOCATIONS_DISCOVERED';
    const { error } = await database()
      .from('integration_events')
      .insert({
        correlation_id: requestId,
        actor_user_id: staff.id,
        source: 'restaurant_discovery',
        outcome: failure ? 'failed' : 'success',
        code,
        upstream_status:
          failure instanceof ConnectorError ? failure.upstreamStatus : null,
      });
    check(error);
    if (failure instanceof ApiError) throw failure;
    if (failure) throw new ApiError(502, code, connectionMessage(code));
    return {
      restaurants,
      configuredRestaurantGuid:
        Deno.env.get('TOAST_RESTAURANT_GUID')?.trim() || null,
    };
  },
  async menu(staff) {
    const { payload, restaurantGuid } = await importedMenu();
    const { data: changes, error } = await database(staff.token)
      .from('menu_change_events')
      .select(
        'id,occurred_at,actor_user_id,entity_type,entity_id,previous_value,new_value,correlation_id',
      )
      .eq('restaurant_guid', restaurantGuid)
      .order('occurred_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(25);
    check(error);
    return {
      restaurantGuid,
      entities: menuEntities(payload, await overrides(payload)),
      changes,
    };
  },
  async saveMenu(staff, override, requestId) {
    const { payload, restaurantGuid } = await importedMenu();
    requireEntity(payload, override);
    const { error } = await database(staff.token).rpc('save_menu_override', {
      p_restaurant_guid: restaurantGuid,
      p_entity_type: override.entity_type,
      p_entity_id: override.entity_id,
      p_display_name: override.display_name,
      p_hidden: override.hidden,
      p_photo_url: override.photo_url,
      p_request_id: requestId,
    });
    check(error);
    return { saved: true };
  },
  async uploadPhoto(staff, request, requestId) {
    const url = new URL(request.url);
    let identity;
    try {
      identity = validateOverride({
        entity_type: url.searchParams.get('entity_type'),
        entity_id: url.searchParams.get('entity_id'),
        display_name: null,
        hidden: false,
        photo_url: null,
      });
    } catch {
      throw new ApiError(400, 'INVALID_ENTITY', 'Invalid menu entity.');
    }
    if (!['item', 'modifier'].includes(identity.entity_type))
      throw new ApiError(
        400,
        'INVALID_ENTITY',
        'Photos are supported for items and modifiers only.',
      );
    const { payload, restaurantGuid } = await importedMenu();
    requireEntity(payload, identity);
    const contentType =
      request.headers.get('Content-Type')?.split(';')[0] ?? '';
    let bytes;
    let extension;
    try {
      bytes = await limitedBody(request, 5_242_880);
      extension = photoExtension(bytes, contentType);
    } catch (error) {
      throw new ApiError(
        error instanceof RangeError ? 413 : 415,
        'INVALID_PHOTO',
        error instanceof Error ? error.message : 'Invalid photo.',
      );
    }
    const path = `${restaurantGuid}/${crypto.randomUUID()}.${extension}`;
    const client = database();
    const { error: uploadError } = await client.storage
      .from('menu-photos')
      .upload(path, bytes, {
        contentType,
        upsert: false,
        cacheControl: '3600',
      });
    if (uploadError)
      throw new ApiError(
        503,
        'PHOTO_UPLOAD_FAILED',
        'The photo could not be uploaded.',
      );
    const { error: auditError } = await client
      .from('integration_events')
      .insert({
        correlation_id: requestId,
        actor_user_id: staff.id,
        source: `photo:${identity.entity_type}:${identity.entity_id}`,
        outcome: 'success',
        code: 'MENU_PHOTO_UPLOADED',
      });
    if (auditError) {
      await client.storage.from('menu-photos').remove([path]);
      check(auditError);
    }
    return {
      photoUrl: client.storage.from('menu-photos').getPublicUrl(path).data
        .publicUrl,
    };
  },
  sync(staff, requestId, source) {
    return syncService.run('manual', staff.id, requestId, source);
  },
  async scheduled(request, requestId) {
    const secret = request.headers.get('x-sync-token');
    if (!secret || secret.length > 200)
      throw new ApiError(
        401,
        'SCHEDULER_UNAUTHORIZED',
        'Scheduler authentication required.',
      );
    const { data: valid, error } = await database().rpc(
      'verify_toast_scheduler',
      { p_token: secret },
    );
    check(error);
    if (!valid)
      throw new ApiError(
        401,
        'SCHEDULER_UNAUTHORIZED',
        'Scheduler authentication required.',
      );
    return syncService.run('scheduled', null, requestId);
  },
};

const handler = createHandler(
  backend,
  (Deno.env.get('ALLOWED_ORIGINS') ?? 'https://fhcoffee.co')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);
Deno.serve(handler);
