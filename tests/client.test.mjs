import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOrderingClient, isPublicConfig } from '../shared/ordering-client.mjs';

const config = { supabaseUrl: 'https://project.supabase.co', supabasePublishableKey: 'sb_publishable_test' };

test('shared client runs without browser globals and includes the versioned API path', async () => {
  let request;
  const client = createOrderingClient(config, async (url, options) => {
    request = { url, options };
    return Response.json({ apiVersion: 'v1', requestId: 'test', data: { checkoutEnabled: false } });
  });
  assert.equal((await client.request('/catalog')).checkoutEnabled, false);
  assert.equal(request.url, 'https://project.supabase.co/functions/v1/ordering-api/v1/catalog');
  assert.equal(request.options.headers.apikey, config.supabasePublishableKey);
  assert.equal(request.options.headers.Authorization, undefined);
  await client.request('/staff/me', { token: 'user-session' });
  assert.equal(request.options.headers.Authorization, 'Bearer user-session');
});

test('configuration rejects secret keys and non-local insecure origins', () => {
  assert.equal(isPublicConfig(config), true);
  assert.equal(isPublicConfig({ ...config, supabaseUrl: 'http://project.supabase.co' }), false);
  assert.equal(isPublicConfig({ ...config, supabasePublishableKey: 'sb_secret_private' }), false);
  const jwt = role => `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ role }))}.signature`;
  assert.equal(isPublicConfig({ ...config, supabasePublishableKey: jwt('service_role') }), false);
  assert.equal(isPublicConfig({ ...config, supabasePublishableKey: jwt('anon') }), true);
  const encoded = Buffer.from(JSON.stringify({ role: 'anon', marker: '~~~???' })).toString('base64url');
  assert.equal(isPublicConfig({ ...config, supabasePublishableKey: `eyJhbGciOiJIUzI1NiJ9.${encoded}.signature` }), true);
  assert.equal(isPublicConfig({ ...config, supabasePublishableKey: 'eyJ.invalid' }), false);
  assert.equal(isPublicConfig({ ...config, supabaseUrl: 'http://127.0.0.1:54321' }), true);
});

test('shared client reports correlation IDs and rejects invalid envelopes', async () => {
  const denied = createOrderingClient(config, async () => Response.json({ error: { code: 'STAFF_REQUIRED', message: 'Staff only.' }, requestId: 'trace-id' }, { status: 403 }));
  await assert.rejects(denied.request('/staff/me'), error => error.code === 'STAFF_REQUIRED' && error.requestId === 'trace-id');
  const invalid = createOrderingClient(config, async () => Response.json({ data: {} }));
  await assert.rejects(invalid.request('/catalog'), /unexpected response/);
});

test('shared client sends menu metadata as JSON and photo bytes without JSON encoding', async () => {
  let sent;
  const client = createOrderingClient(config, async (_url, options) => {
    sent = options;
    return Response.json({ apiVersion: 'v1', data: { saved: true }, requestId: 'test' });
  });
  await client.request('/staff/menu/override', { method: 'POST', json: { hidden: true } });
  assert.equal(sent.headers['Content-Type'], 'application/json');
  assert.equal(sent.body, '{"hidden":true}');
  const bytes = new Uint8Array([1, 2, 3]);
  await client.request('/staff/menu/photo', { method: 'POST', body: bytes, contentType: 'image/webp' });
  assert.equal(sent.headers['Content-Type'], 'image/webp');
  assert.equal(sent.body, bytes);
});