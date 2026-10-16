export class ServiceError extends Error {
  constructor(message, code = 'SERVICE_UNAVAILABLE', requestId = '') {
    super(message);
    this.code = code;
    this.requestId = requestId;
  }
}

export function isPublicConfig(config) {
  try {
    const url = new URL(config.supabaseUrl);
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    const key = config.supabasePublishableKey;
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return false;
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return false;
    if (typeof key !== 'string') return false;
    if (key.startsWith('sb_publishable_')) return true;
    if (!key.startsWith('eyJ') || key.split('.').length !== 3) return false;
    const payload = key.split('.')[1].replaceAll('-', '+').replaceAll('_', '/');
    return JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, '='))).role === 'anon';
  } catch {
    return false;
  }
}

export function createOrderingClient(config, fetcher = globalThis.fetch) {
  return {
    async request(path, { token, method = 'GET', json, body, contentType } = {}) {
      if (!isPublicConfig(config)) throw new ServiceError('The service is temporarily unavailable.', 'NOT_CONFIGURED');
      if (!path.startsWith('/') || path.startsWith('//')) throw new ServiceError('Invalid API path.', 'INVALID_PATH');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), method === 'POST' ? 120_000 : 20_000);
      try {
        const response = await fetcher(`${config.supabaseUrl.replace(/\/$/, '')}/functions/v1/ordering-api/v1${path}`, {
          method,
          headers: { apikey: config.supabasePublishableKey, ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(json !== undefined ? { 'Content-Type': 'application/json' } : contentType ? { 'Content-Type': contentType } : {}) },
          body: json !== undefined ? JSON.stringify(json) : body,
          cache: 'no-store', signal: controller.signal,
        });
        let payload;
        try { payload = await response.json(); }
        catch { throw new ServiceError('The service returned an unexpected response.'); }
        if (!response.ok) throw new ServiceError(payload.error?.message ?? 'The request failed.', payload.error?.code, payload.requestId);
        if (payload.apiVersion !== 'v1' || !Object.hasOwn(payload, 'data')) throw new ServiceError('The service returned an unexpected response.');
        return payload.data;
      } catch (error) {
        if (error instanceof ServiceError) throw error;
        throw new ServiceError('Unable to reach the service. Please try again.');
      } finally { clearTimeout(timer); }
    },
  };
}