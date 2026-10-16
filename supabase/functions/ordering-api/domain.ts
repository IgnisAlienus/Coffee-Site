import {
  SOURCES,
  type Source,
  type Catalog,
  type CatalogItem,
  type MenuGroup,
  type CatalogModifierGroup,
  type OrderingStatus,
} from '../_shared/contracts.ts';
import { sourceFresh } from './sync-policy.ts';

export const API_VERSION = 'v1';
export { SOURCES };
export type { Source };
export type Snapshot = { source: Source; payload: unknown; fetched_at: string };
export type Freshness = {
  source: Source;
  fetchedAt: string | null;
  stale: boolean;
};
export type RecordValue = Record<string, unknown>;

export function record(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function freshness(
  snapshots: Snapshot[],
  now = Date.now(),
): Freshness[] {
  return SOURCES.map((source) => {
    const snapshot = snapshots.find((entry) => entry.source === source);
    return {
      source,
      fetchedAt: snapshot?.fetched_at ?? null,
      stale: !sourceFresh(source, snapshot?.fetched_at, now),
    };
  });
}

function visible(entity: RecordValue): boolean {
  return list(entity.visibility).includes('TOAST_ONLINE_ORDERING');
}

function startingPrice(item: RecordValue, root: RecordValue): number | null {
  const validPrice = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;
  if (
    ['BASE_PRICE', 'MENU_SPECIFIC_PRICE'].includes(text(item.pricingStrategy))
  )
    return validPrice(item.price) ? item.price : null;
  if (item.pricingStrategy !== 'SIZE_PRICE') return null;
  const sizeGuid = text(record(item.pricingRules).sizeSpecificPricingGuid);
  if (!sizeGuid) return null;
  const group = Object.values(record(root.modifierGroupReferences))
    .map(record)
    .find((group) => group.guid === sizeGuid);
  if (
    !group ||
    !visible(group) ||
    !list(item.modifierGroupReferences).some(
      (reference) =>
        record(record(root.modifierGroupReferences)[String(reference)]).guid ===
        sizeGuid,
    )
  )
    return null;
  const options = list(group.modifierOptionReferences)
    .map((reference) =>
      record(record(root.modifierOptionReferences)[String(reference)]),
    )
    .filter(visible);
  if (
    !options.length ||
    options.some(
      (option) =>
        !['BASE_PRICE', 'MENU_SPECIFIC_PRICE', 'GROUP_PRICE'].includes(
          text(option.pricingStrategy),
        ) || !validPrice(option.price),
    )
  )
    return null;
  return Math.min(...options.map((option) => Number(option.price)));
}

function modifierPrice(option: RecordValue, group: RecordValue, root: RecordValue) {
  const includedDefault = option.isDefault === true &&
    (option.shouldChargePrice === false ||
      (option.shouldChargePrice !== true && group.defaultOptionsChargePrice === 'NO'));
  if (includedDefault) return { price: 0, startingPrice: 0 };
  const fixed = ['BASE_PRICE', 'MENU_SPECIFIC_PRICE'].includes(text(option.pricingStrategy)) ||
    (option.pricingStrategy === 'GROUP_PRICE' && group.pricingStrategy === 'NONE');
  const price = fixed && typeof option.price === 'number' && Number.isFinite(option.price)
    ? option.price : null;
  return { price, startingPrice: price ?? (option.pricingStrategy === 'SIZE_PRICE' ? startingPrice(option, root) : null) };
}

export function publicCatalog(
  payload: unknown,
  stockPayload?: unknown,
  stockFresh = false,
): Pick<Catalog, 'menus' | 'restaurantTimeZone'> {
  const root = record(payload);
  const stock = list(stockPayload).map(record);
  function image(entity: RecordValue): string | null {
    try {
      const url = new URL(text(entity.image || list(entity.images)[0]));
      return url.protocol === 'https:' && !url.username && !url.password
        ? url.href
        : null;
    } catch {
      return null;
    }
  }
  function modifiers(
    references: unknown[],
    seen = new Set<string>(),
    depth = 0,
  ): CatalogModifierGroup[] {
    if (depth > 8) return [];
    return references.flatMap((reference) => {
      const key = String(reference);
      if (seen.has(key)) return [];
      const group = record(record(root.modifierGroupReferences)[key]);
      if (!visible(group)) return [];
      const next = new Set([...seen, key]);
      return [
        {
          id: text(group.guid),
          name: text(group.name),
          minSelections:
            typeof group.minSelections === 'number' ? group.minSelections : 0,
          maxSelections:
            typeof group.maxSelections === 'number'
              ? group.maxSelections
              : null,
          options: list(group.modifierOptionReferences).flatMap((reference) => {
            const option = record(
              record(root.modifierOptionReferences)[String(reference)],
            );
            if (!visible(option)) return [];
            return [
              {
                id: text(option.guid),
                name: text(option.name),
                photoUrl: image(option),
                isDefault: option.isDefault === true,
                ...modifierPrice(option, group, root),
                stockStatus: stockStatus(option),
                groups: modifiers(
                  list(option.modifierGroupReferences),
                  next,
                  depth + 1,
                ),
              },
            ];
          }),
        },
      ];
    });
  }
  function stockStatus(item: RecordValue): CatalogItem['stockStatus'] {
    if (!stockFresh) return 'UNKNOWN';
    const inventory = stock.find((entry) => text(item.multiLocationId) && entry.multiLocationId === item.multiLocationId) ??
      stock.find((entry) => text(item.guid) && entry.guid === item.guid);
    if (!text(item.guid) && !text(item.multiLocationId)) return 'UNKNOWN';
    if (!inventory) return 'IN_STOCK';
    if (inventory.status === 'OUT_OF_STOCK') return 'OUT_OF_STOCK';
    if (inventory.status === 'IN_STOCK') return 'IN_STOCK';
    if (
      inventory.status !== 'QUANTITY' ||
      typeof inventory.quantity !== 'number' ||
      !Number.isFinite(inventory.quantity)
    )
      return 'UNKNOWN';
    if (inventory.quantity <= 0) return 'OUT_OF_STOCK';
    return inventory.quantity < 5 ? 'LIMITED' : 'IN_STOCK';
  }
  function groups(values: unknown[], depth = 0): MenuGroup[] {
    if (depth > 12) return [];
    return values.flatMap((value) => {
      const group = record(value);
      if (!visible(group)) return [];
      return [
        {
          id: text(group.guid),
          name: text(group.name),
          items: list(group.menuItems).flatMap((value) => {
            const item = record(value);
            if (!visible(item)) return [];
            const simplePrice =
              item.pricingStrategy === 'BASE_PRICE' &&
              typeof item.price === 'number' &&
              Number.isFinite(item.price) &&
              item.price >= 0;
            const modifierGroups = modifiers(
              list(item.modifierGroupReferences),
            );
            return [
              {
                id: text(item.guid),
                name: text(item.name),
                description: text(item.description),
                basePrice: simplePrice ? Number(item.price) : null,
                startingPrice: startingPrice(item, root),
                hasModifiers: modifierGroups.length > 0,
                photoUrl: image(item),
                modifierGroups,
                stockStatus: stockStatus(item),
              },
            ];
          }),
          groups: groups(list(group.menuGroups), depth + 1),
        },
      ];
    });
  }
  return {
    restaurantTimeZone: text(root.restaurantTimeZone),
    menus: list(root.menus).flatMap((value) => {
      const menu = record(value);
      if (!visible(menu)) return [];
      return [
        {
          id: text(menu.guid),
          name: text(menu.name),
          groups: groups(list(menu.menuGroups)),
        },
      ];
    }),
  };
}

export function publicState(
  snapshots: Snapshot[],
  now = Date.now(),
): OrderingStatus {
  const sources = freshness(snapshots, now);
  const availability = record(
    snapshots.find((entry) => entry.source === 'availability')?.payload,
  );
  const live = !sources.find((entry) => entry.source === 'availability')!.stale;
  return {
    apiVersion: API_VERSION,
    mode: 'read_only' as const,
    checkoutEnabled: false,
    acceptingOrders: false,
    restaurantStatus:
      live && ['ONLINE', 'OFFLINE'].includes(text(availability.status))
        ? (text(availability.status) as 'ONLINE' | 'OFFLINE')
        : 'UNKNOWN',
    sources,
  };
}
