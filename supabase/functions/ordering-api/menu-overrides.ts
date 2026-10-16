import { list, record, text, type RecordValue } from './domain.ts';
import { MENU_ENTITY_TYPES, type MenuEntityType, type MenuOverride } from '../_shared/contracts.ts';

export function entityId(entity: RecordValue): string {
  return text(entity.multiLocationId) ? `ml:${text(entity.multiLocationId)}` : text(entity.guid) ? `guid:${text(entity.guid)}` : '';
}

export function photoUrl(value: unknown): string | null {
  if (!value) return null;
  try {
    const url = new URL(text(value));
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function menuEntities(payload: unknown, overrides: MenuOverride[] = []) {
  const root = record(payload);
  const entities = new Map<string, {
    entityType: MenuEntityType; entityId: string; originalName: string; displayName: string;
    hidden: boolean; toastVisible: boolean; photoUrl: string | null; overridePhotoUrl: string | null; toastPhotoUrl: string | null; context: string;
  }>();
  function add(type: MenuEntityType, entity: RecordValue, context: string) {
    const id = entityId(entity);
    if (!id) return;
    const override = overrides.find(entry => entry.entity_type === type && entry.entity_id === id);
    const key = `${type}:${id}`;
    if (!entities.has(key)) entities.set(key, {
      entityType: type, entityId: id, originalName: text(entity.name),
      displayName: override?.display_name ?? text(entity.name), hidden: override?.hidden ?? false,
      toastVisible: list(entity.visibility).includes('TOAST_ONLINE_ORDERING'),
      photoUrl: photoUrl(override?.photo_url ?? entity.image ?? list(entity.images)[0]), context,
      overridePhotoUrl: override?.photo_url ?? null,
      toastPhotoUrl: photoUrl(entity.image ?? list(entity.images)[0]),
    });
  }
  function groups(values: unknown[], context: string, depth = 0) {
    if (depth > 12) return;
    for (const value of values) {
      const group = record(value);
      add('group', group, context);
      const path = `${context} / ${text(group.name)}`;
      for (const item of list(group.menuItems)) add('item', record(item), path);
      groups(list(group.menuGroups), path, depth + 1);
    }
  }
  for (const value of list(root.menus)) {
    const menu = record(value);
    add('menu', menu, 'Menus');
    groups(list(menu.menuGroups), text(menu.name));
  }
  for (const value of Object.values(record(root.modifierGroupReferences))) add('modifierGroup', record(value), 'Shared modifier groups');
  for (const value of Object.values(record(root.modifierOptionReferences))) add('modifier', record(value), 'Shared modifiers');
  return [...entities.values()];
}

export function applyMenuOverrides(payload: unknown, overrides: MenuOverride[]) {
  const root = record(structuredClone(payload));
  const lookup = new Map(overrides.map(override => [`${override.entity_type}:${override.entity_id}`, override]));
  function apply(type: MenuEntityType, entity: RecordValue) {
    const override = lookup.get(`${type}:${entityId(entity)}`);
    if (!override) return;
    if (override.display_name) entity.name = override.display_name;
    if (override.hidden) entity.visibility = [];
    if (override.photo_url) entity.image = photoUrl(override.photo_url);
  }
  function groups(values: unknown[], depth = 0) {
    if (depth > 12) return;
    for (const value of values) {
      const group = record(value);
      apply('group', group);
      for (const item of list(group.menuItems)) apply('item', record(item));
      groups(list(group.menuGroups), depth + 1);
    }
  }
  for (const value of list(root.menus)) {
    const menu = record(value);
    apply('menu', menu);
    groups(list(menu.menuGroups));
  }
  for (const value of Object.values(record(root.modifierGroupReferences))) apply('modifierGroup', record(value));
  for (const value of Object.values(record(root.modifierOptionReferences))) apply('modifier', record(value));
  return root;
}

export function validateOverride(value: unknown): MenuOverride {
  const input = record(value);
  if (!MENU_ENTITY_TYPES.includes(input.entity_type as MenuEntityType) || !/^(ml|guid):[A-Za-z0-9-]{1,100}$/.test(text(input.entity_id))) {
    throw new Error('Invalid menu entity.');
  }
  if (typeof input.hidden !== 'boolean' || (input.display_name !== null && typeof input.display_name !== 'string')) {
    throw new Error('A name and visibility setting are required.');
  }
  const name = text(input.display_name).trim();
  if (name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('Online names must contain at most 100 printable characters.');
  if (input.photo_url !== null && (typeof input.photo_url !== 'string' || !photoUrl(input.photo_url) || input.photo_url.length > 2048)) {
    throw new Error('Photos must use a valid HTTPS URL.');
  }
  if (input.photo_url && !['item', 'modifier'].includes(text(input.entity_type))) throw new Error('Photos are supported for items and modifiers only.');
  return { entity_type: input.entity_type as MenuEntityType, entity_id: text(input.entity_id), display_name: name || null, hidden: input.hidden, photo_url: input.photo_url ? photoUrl(input.photo_url) : null };
}

export async function limitedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (Number(request.headers.get('Content-Length')) > maxBytes) throw new RangeError('Request is too large.');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new RangeError('Request is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export function photoExtension(bytes: Uint8Array, contentType: string): string {
  const matches = (values: number[], offset = 0) => values.every((value, index) => bytes[offset + index] === value);
  if (contentType === 'image/jpeg' && matches([255, 216, 255])) return 'jpg';
  if (contentType === 'image/png' && matches([137, 80, 78, 71, 13, 10, 26, 10])) return 'png';
  if (contentType === 'image/webp' && matches([82, 73, 70, 70]) && matches([87, 69, 66, 80], 8)) return 'webp';
  throw new Error('Upload a JPEG, PNG, or WebP photo with matching file contents.');
}