export const SOURCES = ['menus', 'diningOptions', 'schedule', 'availability', 'stock', 'restaurant', 'taxRates', 'serviceCharges'] as const;
export type Source = typeof SOURCES[number];
export type SourceFreshness = { source: Source; fetchedAt: string | null; stale: boolean };
export type OrderingStatus = {
  apiVersion: 'v1';
  mode: 'read_only';
  checkoutEnabled: false;
  acceptingOrders: false;
  restaurantStatus: 'ONLINE' | 'OFFLINE' | 'UNKNOWN';
  sources: SourceFreshness[];
};
export type CatalogItem = {
  id: string;
  name: string;
  description: string;
  basePrice: number | null;
  startingPrice: number | null;
  hasModifiers: boolean;
  photoUrl: string | null;
  modifierGroups: CatalogModifierGroup[];
  stockStatus: 'IN_STOCK' | 'OUT_OF_STOCK' | 'LIMITED' | 'UNKNOWN';
};
export type CatalogModifierGroup = {
  id: string; name: string; minSelections: number; maxSelections: number | null;
  options: { id: string; name: string; photoUrl: string | null; isDefault: boolean; groups: CatalogModifierGroup[] }[];
};
export const MENU_ENTITY_TYPES = ['menu', 'group', 'item', 'modifierGroup', 'modifier'] as const;
export type MenuEntityType = typeof MENU_ENTITY_TYPES[number];
export type MenuOverride = {
  entity_type: MenuEntityType; entity_id: string; display_name: string | null;
  hidden: boolean; photo_url: string | null;
};
export type MenuGroup = { id: string; name: string; items: CatalogItem[]; groups: MenuGroup[] };
export type Catalog = OrderingStatus & {
  restaurantTimeZone: string;
  menus: { id: string; name: string; groups: MenuGroup[] }[];
};
export type StaffProfile = { id: string; role: 'employee' | 'manager'; mfaRequired: boolean };
export type OrderStatus = 'draft' | 'submitting' | 'accepted' | 'unknown' | 'failed' | 'cancelled';
export type OrderSummary = {
  id: string;
  toast_order_guid: string | null;
  status: OrderStatus;
  payment_status: 'not_started' | 'authorized' | 'captured' | 'voided' | 'failed' | 'refunded';
  customer_name: string | null;
  total_minor: number;
  currency: string;
  created_at: string;
};
export type OrdersPage = { orders: OrderSummary[]; total: number; page: number; pageSize: number };
export type OrderEvent = {
  id: number;
  order_id: string;
  occurred_at: string;
  correlation_id: string;
  actor_user_id: string | null;
  event_type: string;
  summary: string;
  origin_ip: string | null;
  user_agent: string | null;
  provider_reference: string | null;
  upstream_status: number | null;
  policy_version: string | null;
  fulfillment_reference: string | null;
};
export type ApiEnvelope<Value> = { apiVersion: 'v1'; requestId: string } & (
  { data: Value } | { error: { code: string; message: string } }
);