export type { Catalog, OrderingStatus, StaffProfile, OrdersPage, OrderSummary, OrderEvent, ApiEnvelope } from '../supabase/functions/_shared/contracts.ts';
export type PublicConfig = { supabaseUrl: string; supabasePublishableKey: string };
export declare class ServiceError extends Error {
  code: string;
  requestId: string;
  constructor(message: string, code?: string, requestId?: string);
}
export declare function isPublicConfig(config: PublicConfig): boolean;
export declare function createOrderingClient(config: PublicConfig, fetcher?: typeof fetch): {
  request<Value = unknown>(path: string, options?: { token?: string; method?: 'GET' | 'POST'; json?: unknown; body?: BodyInit; contentType?: string }): Promise<Value>;
};