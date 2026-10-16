import { list, record, text, type Source } from './domain.ts';
import { retryAfter } from './sync-policy.ts';

export class ConnectorError extends Error {
  constructor(
    public code: string,
    public upstreamStatus: number | null = null,
    public retrySeconds = 0,
  ) {
    super(code);
  }
}

export type ToastConfig = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  restaurantGuid?: string;
};
export type ToastSession = { accessToken: string; expiresAt: number };
export type ToastState = {
  beforeRequest(): Promise<void>;
  rateLimited(seconds: number): Promise<void>;
  loadToken(): Promise<ToastSession | null>;
  saveToken(session: ToastSession): Promise<void>;
  invalidateToken(): Promise<void>;
  claimAuthentication(): Promise<boolean>;
};
const guidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ToastReader {
  private token = '';
  private expiresAt = 0;

  constructor(
    private config: ToastConfig,
    private fetcher: typeof fetch = fetch,
    private state?: ToastState,
  ) {
    const url = new URL(config.baseUrl);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    ) {
      throw new ConnectorError('INVALID_TOAST_HOST');
    }
    if (
      (config.restaurantGuid && !guidPattern.test(config.restaurantGuid)) ||
      !config.clientId ||
      !config.clientSecret
    ) {
      throw new ConnectorError('TOAST_NOT_CONFIGURED');
    }
  }

  private async request(path: string, init: RequestInit = {}) {
    await this.state?.beforeRequest();
    let response;
    try {
      response = await this.fetcher(new URL(path, this.config.baseUrl), {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      throw new ConnectorError('UPSTREAM_UNREACHABLE');
    }
    if (response.status === 429) {
      const seconds = Math.max(60, retryAfter(response));
      await this.state?.rateLimited(seconds);
      throw new ConnectorError('RATE_LIMITED', 429, seconds);
    }
    const remaining = response.headers.get('X-Toast-RateLimit-Remaining');
    if (remaining !== null && Number(remaining) === 0)
      await this.state?.rateLimited(retryAfter(response));
    if (
      response.status === 401 &&
      path !== '/authentication/v1/authentication/login'
    ) {
      this.expiresAt = 0;
      await this.state?.invalidateToken();
    }
    return response;
  }

  private async authenticate() {
    if (this.token && Date.now() < this.expiresAt) return;
    const cached = await this.state?.loadToken();
    if (cached && cached.expiresAt > Date.now()) {
      this.token = cached.accessToken;
      this.expiresAt = cached.expiresAt;
      return;
    }
    if (this.state && !(await this.state.claimAuthentication())) {
      throw new ConnectorError('AUTH_COOLDOWN', null, 1800);
    }
    const response = await this.request(
      '/authentication/v1/authentication/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: this.config.clientId,
          clientSecret: this.config.clientSecret,
          userAccessType: 'TOAST_MACHINE_CLIENT',
        }),
      },
    );
    if (!response.ok)
      throw new ConnectorError('TOAST_AUTH_FAILED', response.status);
    let payload;
    try {
      payload = record(record(await response.json()).token);
    } catch {
      throw new ConnectorError('INVALID_AUTH_RESPONSE');
    }
    this.token = text(payload.accessToken);
    if (
      !this.token ||
      typeof payload.expiresIn !== 'number' ||
      payload.expiresIn <= 0
    ) {
      throw new ConnectorError('INVALID_AUTH_RESPONSE');
    }
    this.expiresAt = Date.now() + Math.max(0, payload.expiresIn - 60) * 1_000;
    await this.state?.saveToken({
      accessToken: this.token,
      expiresAt: this.expiresAt,
    });
  }

  async discoverRestaurants() {
    await this.authenticate();
    const response = await this.request('/partners/v1/restaurants', {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (response.status === 401) this.expiresAt = 0;
    if (!response.ok)
      throw new ConnectorError(
        response.status === 403 ? 'DISCOVERY_NOT_PERMITTED' : 'UPSTREAM_HTTP',
        response.status,
      );
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new ConnectorError('INVALID_UPSTREAM_JSON');
    }
    if (
      !Array.isArray(payload) ||
      payload.some(
        (value) => !guidPattern.test(text(record(value).restaurantGuid)),
      )
    ) {
      throw new ConnectorError('INVALID_UPSTREAM_SHAPE');
    }
    return payload
      .map((value) => {
        const restaurant = record(value);
        return {
          restaurantGuid: text(restaurant.restaurantGuid),
          restaurantName: text(restaurant.restaurantName),
          locationName: text(restaurant.locationName),
        };
      })
      .filter(
        (restaurant, index, restaurants) =>
          restaurants.findIndex(
            (entry) => entry.restaurantGuid === restaurant.restaurantGuid,
          ) === index,
      );
  }

  async read(source: Source): Promise<unknown> {
    if (!this.config.restaurantGuid) {
      const restaurants = await this.discoverRestaurants();
      if (!restaurants.length)
        throw new ConnectorError('NO_ACCESSIBLE_RESTAURANTS');
      if (restaurants.length !== 1)
        throw new ConnectorError('RESTAURANT_SELECTION_REQUIRED');
      this.config.restaurantGuid = restaurants[0].restaurantGuid;
    }
    await this.authenticate();
    const paths: Record<Source, string> = {
      menus: '/menus/v2/menus',
      diningOptions: '/config/v2/diningOptions',
      schedule: '/ordermgmt-config/v1/published/orderingSchedule',
      availability: '/restaurant-availability/v1/availability',
      stock: '/stock/v1/inventory',
      restaurant: `/restaurants/v1/restaurants/${this.config.restaurantGuid}`,
      taxRates: '/config/v2/taxRates',
      serviceCharges: '/config/v2/serviceCharges',
    };
    const paginated = ['diningOptions', 'taxRates', 'serviceCharges'].includes(
      source,
    );
    const results: unknown[] = [];
    let next = '';
    for (let page = 0; page < 30; page++) {
      const url = new URL(paths[source], this.config.baseUrl);
      if (next) url.searchParams.set('pageToken', next);
      const response = await this.request(url.pathname + url.search, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Toast-Restaurant-External-ID': this.config.restaurantGuid,
        },
      });
      if (response.status === 401) this.expiresAt = 0;
      if (!response.ok)
        throw new ConnectorError(
          response.status === 403 ? 'SCOPE_DENIED' : 'UPSTREAM_HTTP',
          response.status,
        );
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new ConnectorError('INVALID_UPSTREAM_JSON');
      }
      if (paginated || source === 'stock') {
        if (!Array.isArray(payload))
          throw new ConnectorError('INVALID_UPSTREAM_SHAPE');
      } else if (
        payload === null ||
        typeof payload !== 'object' ||
        Array.isArray(payload)
      ) {
        throw new ConnectorError('INVALID_UPSTREAM_SHAPE');
      }
      if (source === 'menus' && !Array.isArray(record(payload).menus))
        throw new ConnectorError('INVALID_UPSTREAM_SHAPE');
      if (
        source === 'availability' &&
        !['ONLINE', 'OFFLINE'].includes(text(record(payload).status))
      ) {
        throw new ConnectorError('INVALID_UPSTREAM_SHAPE');
      }
      if (!paginated) return payload;
      results.push(...list(payload));
      const token = response.headers.get('Toast-Next-Page-Token') ?? '';
      if (!token) return results;
      if (token === next) throw new ConnectorError('PAGINATION_LOOP');
      next = token;
    }
    throw new ConnectorError('PAGINATION_LIMIT');
  }
}
