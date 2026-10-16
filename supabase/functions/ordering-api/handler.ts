import {
  API_VERSION,
  SOURCES,
  publicCatalog,
  publicState,
  type Snapshot,
  type Source,
} from './domain.ts';
import {
  applyMenuOverrides,
  limitedBody,
  validateOverride,
} from './menu-overrides.ts';
import type { MenuOverride } from '../_shared/contracts.ts';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export type Staff = {
  id: string;
  role: 'employee' | 'manager';
  mfaRequired: boolean;
  token: string;
};
export type Backend = {
  ready?(): Promise<void>;
  snapshots(): Promise<Snapshot[]>;
  overrides(payload: unknown): Promise<MenuOverride[]>;
  authenticate(request: Request): Promise<Staff>;
  orders(staff: Staff, page: number, status: string): Promise<unknown>;
  order(staff: Staff, id: string): Promise<unknown>;
  events(
    staff: Staff,
    id: string,
    page: number,
    requestId: string,
  ): Promise<unknown>;
  integrations(staff: Staff, page: number): Promise<unknown>;
  restaurants(staff: Staff, requestId: string): Promise<unknown>;
  sync(
    staff: Staff,
    requestId: string,
    source: Source | 'all',
  ): Promise<unknown>;
  scheduled(request: Request, requestId: string): Promise<unknown>;
  menu(staff: Staff): Promise<unknown>;
  saveMenu(
    staff: Staff,
    override: MenuOverride,
    requestId: string,
  ): Promise<unknown>;
  uploadPhoto(
    staff: Staff,
    request: Request,
    requestId: string,
  ): Promise<unknown>;
};

export function createHandler(backend: Backend, allowedOrigins: string[]) {
  return async (request: Request): Promise<Response> => {
    const requestId = crypto.randomUUID();
    const origin = request.headers.get('Origin');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Request-ID': requestId,
      Vary: 'Origin',
    };
    const respond = (status: number, payload: object) =>
      Response.json(
        { apiVersion: API_VERSION, requestId, ...payload },
        { status, headers },
      );
    try {
      if (origin) {
        if (!allowedOrigins.includes(origin))
          throw new ApiError(
            403,
            'ORIGIN_DENIED',
            'This origin is not permitted.',
          );
        headers['Access-Control-Allow-Origin'] = origin;
        headers['Access-Control-Allow-Headers'] =
          'authorization, apikey, content-type';
        headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
        headers['Access-Control-Expose-Headers'] = 'x-request-id';
      }
      if (request.method === 'OPTIONS')
        return new Response(null, { status: 204, headers });
      await backend.ready?.();
      const url = new URL(request.url);
      const match = url.pathname.match(/\/ordering-api\/v1(\/.*)$/);
      if (!match) throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found.');
      const path = match[1];
      if (request.method === 'POST' && path === '/internal/sync')
        return respond(200, {
          data: await backend.scheduled(request, requestId),
        });
      if (
        request.method === 'GET' &&
        (path === '/status' || path === '/catalog')
      ) {
        const snapshots = await backend.snapshots();
        const state = publicState(snapshots);
        if (path === '/status') return respond(200, { data: state });
        const menus = snapshots.find((entry) => entry.source === 'menus');
        if (!menus)
          throw new ApiError(
            503,
            'MENU_NOT_SYNCED',
            'The menu is not available yet. Please order on Toast.',
          );
        const stock = snapshots.find((entry) => entry.source === 'stock');
        const payload = applyMenuOverrides(
          menus.payload,
          await backend.overrides(menus.payload),
        );
        return respond(200, {
          data: {
            ...state,
            ...publicCatalog(
              payload,
              stock?.payload,
              !state.sources.find((entry) => entry.source === 'stock')!.stale,
            ),
          },
        });
      }
      if (!path.startsWith('/staff/'))
        throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found.');
      const staff = await backend.authenticate(request);
      if (request.method === 'GET' && path === '/staff/me') {
        return respond(200, {
          data: {
            id: staff.id,
            role: staff.role,
            mfaRequired: staff.mfaRequired,
          },
        });
      }
      if (staff.mfaRequired)
        throw new ApiError(
          403,
          'MFA_REQUIRED',
          'Verify your authenticator to continue.',
        );
      const page = Number(url.searchParams.get('page') ?? '0');
      if (!Number.isInteger(page) || page < 0 || page > 10_000)
        throw new ApiError(400, 'INVALID_PAGE', 'Invalid page number.');
      if (request.method === 'GET' && path === '/staff/orders') {
        const status = url.searchParams.get('status') ?? '';
        if (
          ![
            '',
            'draft',
            'submitting',
            'accepted',
            'unknown',
            'failed',
            'cancelled',
          ].includes(status)
        ) {
          throw new ApiError(400, 'INVALID_STATUS', 'Invalid order status.');
        }
        return respond(200, {
          data: await backend.orders(staff, page, status),
        });
      }
      const orderMatch = path.match(
        /^\/staff\/orders\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/events)?$/i,
      );
      if (request.method === 'GET' && orderMatch && !orderMatch[2]) {
        return respond(200, {
          data: await backend.order(staff, orderMatch[1]),
        });
      }
      if (staff.role !== 'manager')
        throw new ApiError(
          403,
          'MANAGER_REQUIRED',
          'Manager access is required.',
        );
      if (request.method === 'GET' && path === '/staff/menu')
        return respond(200, { data: await backend.menu(staff) });
      if (request.method === 'POST' && path === '/staff/menu/override') {
        let override;
        try {
          if (
            request.headers.get('Content-Type')?.split(';')[0] !==
            'application/json'
          )
            throw new Error('Expected JSON.');
          override = validateOverride(
            JSON.parse(
              new TextDecoder().decode(await limitedBody(request, 16_384)),
            ),
          );
        } catch (error) {
          throw new ApiError(
            error instanceof RangeError ? 413 : 400,
            'INVALID_OVERRIDE',
            error instanceof Error ? error.message : 'Invalid menu override.',
          );
        }
        return respond(200, {
          data: await backend.saveMenu(staff, override, requestId),
        });
      }
      if (request.method === 'POST' && path === '/staff/menu/photo')
        return respond(200, {
          data: await backend.uploadPhoto(staff, request, requestId),
        });
      if (request.method === 'GET' && path === '/staff/restaurants') {
        return respond(200, {
          data: await backend.restaurants(staff, requestId),
        });
      }
      if (request.method === 'GET' && orderMatch?.[2]) {
        return respond(200, {
          data: await backend.events(staff, orderMatch[1], page, requestId),
        });
      }
      if (request.method === 'GET' && path === '/staff/integrations') {
        return respond(200, { data: await backend.integrations(staff, page) });
      }
      if (request.method === 'POST' && path === '/staff/sync') {
        const source = url.searchParams.get('source') ?? 'all';
        if (source !== 'all' && !SOURCES.includes(source as Source))
          throw new ApiError(
            400,
            'INVALID_SOURCE',
            'Select a valid sync source.',
          );
        return respond(200, {
          data: await backend.sync(staff, requestId, source as Source | 'all'),
        });
      }
      throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found.');
    } catch (error) {
      if (error instanceof ApiError)
        return respond(error.status, {
          error: { code: error.code, message: error.message },
        });
      console.error(JSON.stringify({ requestId, code: 'INTERNAL_ERROR' }));
      return respond(500, {
        error: {
          code: 'INTERNAL_ERROR',
          message:
            'The request could not be completed. Use the request ID when contacting support.',
        },
      });
    }
  };
}
