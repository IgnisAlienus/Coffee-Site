import {
  ApiError,
  createHandler,
  type Backend,
  type Staff,
} from './handler.ts';
import { SOURCES } from './domain.ts';
import { ToastReader } from './toast.ts';

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}
const employee: Staff = {
  id: 'staff',
  role: 'employee',
  token: 'verified',
  mfaRequired: false,
};
function fixture(staff = employee, extra: Partial<Backend> = {}) {
  let privateCalls = 0;
  const read = async () => {
    privateCalls++;
    return {};
  };
  const backend: Backend = {
    snapshots: async () =>
      SOURCES.map((source) => ({
        source,
        payload: { menus: [], status: 'ONLINE' },
        fetched_at: new Date().toISOString(),
      })),
    overrides: async () => [],
    authenticate: async (request) => {
      if (!request.headers.has('Authorization'))
        throw new ApiError(401, 'SIGN_IN_REQUIRED', 'Sign in.');
      return staff;
    },
    orders: read,
    order: read,
    events: read,
    integrations: read,
    restaurants: read,
    sync: read,
    menu: read,
    saveMenu: read,
    uploadPhoto: read,
    scheduled: async (request) => {
      if (request.headers.get('x-sync-token') !== 'scheduler-secret')
        throw new ApiError(401, 'SCHEDULER_UNAUTHORIZED', 'Unauthorized');
      return read();
    },
    ...extra,
  };
  return {
    handler: createHandler(backend, ['https://fhcoffee.co']),
    calls: () => privateCalls,
  };
}

Deno.test(
  'public catalog is read-only and private routes require authentication',
  async () => {
    const { handler, calls } = fixture();
    const catalog = await handler(
      new Request('https://api.example/ordering-api/v1/catalog'),
    );
    assert(
      (await catalog.json()).data.checkoutEnabled === false,
      'Public checkout must be disabled',
    );
    const response = await handler(
      new Request('https://api.example/ordering-api/v1/staff/orders'),
    );
    assert(
      response.status === 401 && calls() === 0,
      'Anonymous request must not query orders',
    );
  },
);

Deno.test(
  'employees cannot trigger sync or view evidence and integrations',
  async () => {
    const { handler, calls } = fixture();
    for (const path of [
      'menu',
      'menu/override',
      'menu/photo',
      'restaurants',
      'integrations',
      'orders/00000000-0000-4000-8000-000000000001/events',
      'sync',
    ]) {
      const response = await handler(
        new Request(`https://api.example/ordering-api/v1/staff/${path}`, {
          method: ['sync', 'menu/override', 'menu/photo'].includes(path)
            ? 'POST'
            : 'GET',
          headers: { Authorization: 'Bearer token' },
        }),
      );
      assert(response.status === 403, 'Employee must be denied');
    }
    assert(
      calls() === 0,
      'Unauthorized requests must not reach private operations',
    );
  },
);

Deno.test(
  'manager routes require MFA, origins are restricted, and order writes do not exist',
  async () => {
    const { handler, calls } = fixture({
      ...employee,
      role: 'manager',
      mfaRequired: true,
    });
    const orders = await handler(
      new Request('https://api.example/ordering-api/v1/staff/orders', {
        headers: { Authorization: 'Bearer token' },
      }),
    );
    assert(
      orders.status === 403 && calls() === 0,
      'Manager MFA must be enforced',
    );
    const blocked = await handler(
      new Request('https://api.example/ordering-api/v1/catalog', {
        headers: { Origin: 'https://untrusted.example' },
      }),
    );
    assert(
      blocked.status === 403 &&
        !blocked.headers.has('Access-Control-Allow-Origin'),
      'Unknown browser origins must be denied',
    );
    const write = await handler(
      new Request('https://api.example/ordering-api/v1/orders', {
        method: 'POST',
      }),
    );
    assert(write.status === 404, 'No order creation in read-only phase');
  },
);

Deno.test(
  'Toast connector authenticates, paginates reads and rejects denied scopes safely',
  async () => {
    const requests: { url: string; method: string }[] = [];
    const fetcher: typeof fetch = async (input, options) => {
      const url = String(input);
      requests.push({ url, method: options?.method ?? 'GET' });
      if (url.includes('/authentication/'))
        return Response.json({
          token: { accessToken: 'secret-token', expiresIn: 86400 },
        });
      if (url.includes('/stock/'))
        return new Response('sensitive upstream body', { status: 403 });
      if (!url.includes('pageToken='))
        return Response.json([{ guid: 'first' }], {
          headers: { 'Toast-Next-Page-Token': 'next' },
        });
      return Response.json([{ guid: 'second' }]);
    };
    const reader = new ToastReader(
      {
        baseUrl: 'https://toast.example',
        clientId: 'id',
        clientSecret: 'secret',
        restaurantGuid: '00000000-0000-4000-8000-000000000001',
      },
      fetcher,
    );
    const options = (await reader.read('diningOptions')) as unknown[];
    assert(options.length === 2, 'All configuration pages must be read');
    try {
      await reader.read('stock');
      throw new Error('Expected rejection');
    } catch (error) {
      assert(
        error instanceof Error && error.message === 'SCOPE_DENIED',
        'Do not leak upstream body',
      );
    }
    assert(
      requests.filter((request) => request.method !== 'GET').length === 1,
      'Only authentication may POST to Toast',
    );
    assert(
      requests[0].url.endsWith('/authentication/v1/authentication/login'),
      'Authentication path must be correct',
    );
  },
);

Deno.test('only managers with MFA can discover restaurants', async () => {
  for (const mfaRequired of [true, false]) {
    const { handler, calls } = fixture({
      ...employee,
      role: 'manager',
      mfaRequired,
    });
    const response = await handler(
      new Request('https://api.example/ordering-api/v1/staff/restaurants', {
        headers: { Authorization: 'Bearer session' },
      }),
    );
    assert(
      response.status === (mfaRequired ? 403 : 200),
      'Discovery must enforce manager MFA',
    );
    assert(
      calls() === (mfaRequired ? 0 : 1),
      'Denied requests must not query Toast',
    );
  }
});

Deno.test(
  'restaurant discovery needs no GUID or location header and only returns safe fields',
  async () => {
    const restaurantGuid = '00000000-0000-4000-8000-000000000001';
    const requests: { url: string; location: string | null }[] = [];
    const fetcher: typeof fetch = async (input, options) => {
      const url = String(input);
      requests.push({
        url,
        location: new Headers(options?.headers).get(
          'Toast-Restaurant-External-ID',
        ),
      });
      if (url.includes('/authentication/'))
        return Response.json({
          token: { accessToken: 'private-token', expiresIn: 86400 },
        });
      if (url.endsWith('/partners/v1/restaurants'))
        return Response.json([
          {
            restaurantGuid,
            restaurantName: 'Firehouse',
            locationName: 'Station 71',
            createdByEmailAddress: 'private@example.test',
          },
        ]);
      return Response.json({ menus: [] });
    };
    const reader = new ToastReader(
      {
        baseUrl: 'https://toast.example',
        clientId: 'id',
        clientSecret: 'secret',
      },
      fetcher,
    );
    const restaurants = await reader.discoverRestaurants();
    assert(
      restaurants[0].restaurantGuid === restaurantGuid,
      'Must return discovered location',
    );
    assert(
      !JSON.stringify(restaurants).includes('private'),
      'Discovery must not leak tokens or employee email',
    );
    assert(
      requests[1].location === null,
      'Discovery must not require a location header',
    );
    await reader.read('menus');
    assert(
      requests.at(-1)?.location === restaurantGuid,
      'Single location should be used for sync',
    );
  },
);

Deno.test(
  'discovery never guesses among multiple locations and reports denied access safely',
  async () => {
    let denied = false;
    let locationRequests = 0;
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/authentication/'))
        return Response.json({
          token: { accessToken: 'private-token', expiresIn: 86400 },
        });
      if (url.endsWith('/partners/v1/restaurants'))
        return denied
          ? new Response('private upstream details', { status: 403 })
          : Response.json(
              [1, 2].map((index) => ({
                restaurantGuid: `00000000-0000-4000-8000-00000000000${index}`,
              })),
            );
      locationRequests++;
      return Response.json({});
    };
    const reader = new ToastReader(
      {
        baseUrl: 'https://toast.example',
        clientId: 'id',
        clientSecret: 'secret',
      },
      fetcher,
    );
    try {
      await reader.read('menus');
      throw new Error('Expected selection error');
    } catch (error) {
      assert(
        error instanceof Error &&
          error.message === 'RESTAURANT_SELECTION_REQUIRED',
        'Multiple locations require explicit selection',
      );
    }
    assert(locationRequests === 0, 'Must not access an arbitrary location');
    denied = true;
    try {
      await reader.discoverRestaurants();
      throw new Error('Expected denied discovery');
    } catch (error) {
      assert(
        error instanceof Error && error.message === 'DISCOVERY_NOT_PERMITTED',
        'Must report denied discovery without raw upstream details',
      );
    }
  },
);

Deno.test(
  'menu saves validate input and require manager MFA before reading a body',
  async () => {
    const manager = { ...employee, role: 'manager' as const };
    const { handler, calls } = fixture(manager);
    const input = {
      entity_type: 'item',
      entity_id: 'ml:100',
      display_name: 'Latte',
      hidden: true,
      photo_url: null,
    };
    const post = (value: unknown) =>
      new Request('https://api.example/ordering-api/v1/staff/menu/override', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer session',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(value),
      });
    assert(
      (await handler(post(input))).status === 200 && calls() === 1,
      'Valid manager save must reach persistence',
    );
    assert(
      (await handler(post({ ...input, photo_url: 'javascript:alert(1)' })))
        .status === 400 && calls() === 1,
      'Invalid URL must not reach persistence',
    );
    const protectedHandler = fixture({ ...manager, mfaRequired: true });
    assert(
      (await protectedHandler.handler(post(input))).status === 403 &&
        protectedHandler.calls() === 0,
      'MFA must be checked before saving',
    );
  },
);

Deno.test(
  'public menu fails closed if online override storage cannot be read',
  async () => {
    const { handler } = fixture(employee, {
      overrides: async () => {
        throw new ApiError(503, 'DATABASE_UNAVAILABLE', 'Menu unavailable.');
      },
    });
    const response = await handler(
      new Request('https://api.example/ordering-api/v1/catalog'),
    );
    assert(
      response.status === 503 && !(await response.json()).data,
      'Never serve unfiltered menu after override failure',
    );
  },
);

Deno.test(
  'manual sync accepts exactly one valid source and rejects unknown source names',
  async () => {
    let selected = '';
    const { handler } = fixture(
      { ...employee, role: 'manager' },
      {
        sync: async (_staff, _requestId, source) => {
          selected = source;
          return {};
        },
      },
    );
    const request = (source: string) =>
      new Request(
        `https://api.example/ordering-api/v1/staff/sync?source=${source}`,
        { method: 'POST', headers: { Authorization: 'Bearer session' } },
      );
    assert(
      (await handler(request('stock'))).status === 200 && selected === 'stock',
      'Pass only the requested source',
    );
    assert(
      (await handler(request('invalid'))).status === 400 &&
        selected === 'stock',
      'Reject unknown sources without fetching',
    );
  },
);

Deno.test(
  'scheduled sync requires its separate scheduler credential, not a staff token',
  async () => {
    const { handler, calls } = fixture();
    const request = (headers = {}) =>
      new Request('https://api.example/ordering-api/v1/internal/sync', {
        method: 'POST',
        headers,
      });
    assert(
      (await handler(request())).status === 401 && calls() === 0,
      'Anonymous scheduler calls must fail',
    );
    assert(
      (await handler(request({ Authorization: 'Bearer staff-session' })))
        .status === 401,
      'Staff token is not a scheduler credential',
    );
    assert(
      (await handler(request({ 'x-sync-token': 'scheduler-secret' })))
        .status === 200 && calls() === 1,
      'Valid scheduler calls may run the worker',
    );
  },
);
