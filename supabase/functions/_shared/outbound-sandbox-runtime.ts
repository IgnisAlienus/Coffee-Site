import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import {
  createOutboundSandbox,
  type SandboxProvider,
} from './outbound-sandbox.ts';

function serverKey(): string {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
  if (!keys.default)
    throw new Error('Sandbox authentication is not configured.');
  return keys.default;
}

export function serveOutboundSandbox(provider: SandboxProvider) {
  Deno.serve(
    createOutboundSandbox(provider, async (receivedProvider, key) => {
      const url = Deno.env.get('SUPABASE_URL');
      if (!url) throw new Error('Sandbox authentication is not configured.');
      const client = createClient(url, serverKey(), {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data, error } = await client
        .rpc('verify_toast_sandbox_key', {
          p_provider: receivedProvider,
          p_key: key,
        })
        .abortSignal(AbortSignal.timeout(2000));
      if (error) throw new Error('Sandbox authentication is unavailable.');
      return data === true;
    }),
  );
}
