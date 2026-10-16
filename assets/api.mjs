import { createOrderingClient, isPublicConfig, ServiceError } from '../shared/ordering-client.mjs';

const config = window.FIREHOUSE_CONFIG ?? {};
const client = createOrderingClient(config);
export const configured = () => isPublicConfig(config);
export const api = (path, options) => client.request(path, options);
export { ServiceError };

let authClient;
export async function auth() {
  if (!configured()) throw new ServiceError('Staff sign-in is temporarily unavailable.', 'NOT_CONFIGURED');
  if (!authClient) {
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2.57.4');
    authClient = createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false },
    });
  }
  return authClient;
}

export async function clearAuth() {
  const previous = authClient;
  authClient = undefined;
  try { await previous?.auth.stopAutoRefresh(); } catch {}
}

export function element(tag, className = '', content = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = content;
  return node;
}

export function dateTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Chicago',
  }).format(date) : 'Not available';
}

export function money(value, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value);
}

export function showError(node, error) {
  node.textContent = error.message + (error.requestId ? ` Reference: ${error.requestId}` : '');
  node.hidden = false;
}

export async function icons() {
  try {
    const { createIcons, RefreshCw, Search, ArrowUpRight, ArrowLeft, LogOut, X, ChevronLeft, ChevronRight, ShieldCheck, SquarePen, Save, RotateCcw } = await import('https://esm.sh/lucide@0.468.0');
    createIcons({ icons: { RefreshCw, Search, ArrowUpRight, ArrowLeft, LogOut, X, ChevronLeft, ChevronRight, ShieldCheck, SquarePen, Save, RotateCcw } });
  } catch {
    return;
  }
}