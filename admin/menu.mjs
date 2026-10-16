import { dateTime, element, icons, showError } from '../assets/api.mjs';

const select = (selector) => document.querySelector(selector);
const typeNames = {
  menu: 'Menu',
  group: 'Category',
  item: 'Item',
  modifierGroup: 'Modifier group',
  modifier: 'Modifier',
};

function image(url, name, className) {
  const photo = element('img', className);
  photo.src = url;
  photo.alt = name;
  photo.loading = 'lazy';
  photo.referrerPolicy = 'no-referrer';
  photo.addEventListener(
    'error',
    () => {
      photo.hidden = true;
    },
    { once: true },
  );
  return photo;
}

async function preparePhoto(file) {
  if (
    !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
    file.size > 20_971_520
  ) {
    throw new Error('Choose a JPEG, PNG, or WebP photo smaller than 20 MB.');
  }
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas
      .getContext('2d')
      .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, 'image/webp', 0.85),
    );
    if (!blob || blob.size > 5_242_880)
      throw new Error('The photo is too large. Choose a smaller image.');
    return blob;
  } finally {
    bitmap.close();
  }
}

export function createMenuEditor({ request, active }) {
  let data;
  let selected;
  let generation = 0;
  let busy = false;

  function preview(url) {
    const node = select('#menu-photo-preview');
    node.hidden = !url;
    if (url) {
      node.referrerPolicy = 'no-referrer';
      node.src = url;
    } else node.removeAttribute('src');
  }

  function setBusy(value) {
    busy = value;
    for (const node of select('#menu-edit-form').querySelectorAll(
      'input,button',
    ))
      node.disabled = value;
    select('#close-menu-dialog').disabled = value;
  }

  function open(entity) {
    selected = entity;
    select('#menu-dialog-heading').textContent =
      `Edit ${typeNames[entity.entityType]}`;
    select('#menu-original').textContent =
      `Toast: ${entity.originalName} / ${entity.context}`;
    select('#menu-online-name').value = entity.displayName;
    select('#menu-hidden').checked = entity.hidden;
    select('#menu-photo-url').value = entity.overridePhotoUrl || '';
    select('#menu-photo-file').value = '';
    select('#menu-photo-status').textContent = '';
    select('#menu-edit-error').hidden = true;
    select('#menu-photo-fields').hidden = !['item', 'modifier'].includes(
      entity.entityType,
    );
    preview(entity.photoUrl);
    setBusy(false);
    select('#menu-dialog').showModal();
  }

  function render() {
    if (!data) return;
    const query = select('#menu-search').value.trim().toLowerCase();
    const kind = select('#menu-kind').value;
    const visibility = select('#menu-visibility').value;
    const entities = data.entities.filter(
      (entity) =>
        (!kind || entity.entityType === kind) &&
        (!visibility || entity.hidden === (visibility === 'hidden')) &&
        `${entity.originalName} ${entity.displayName} ${entity.context}`
          .toLowerCase()
          .includes(query),
    );
    const rows = select('#menu-rows');
    rows.replaceChildren();
    for (const entity of entities) {
      const row = element('tr');
      const name = element('td', 'entity-name');
      name.append(
        element('strong', '', entity.displayName),
        element('small', 'muted', entity.context),
      );
      if (entity.displayName !== entity.originalName)
        name.append(element('small', 'muted', `Toast: ${entity.originalName}`));
      const status = element('td');
      status.append(
        element(
          'span',
          `badge ${entity.hidden ? 'badge-warning' : ''}`,
          entity.hidden ? 'Hidden on site' : 'Toast visibility',
        ),
      );
      if (!entity.toastVisible)
        status.append(element('small', 'muted', 'Not online in Toast'));
      const photo = element('td');
      if (entity.photoUrl && ['item', 'modifier'].includes(entity.entityType))
        photo.append(image(entity.photoUrl, entity.displayName, 'photo-thumb'));
      else photo.textContent = '-';
      const action = element('td');
      const button = element('button', 'icon-button');
      button.setAttribute('aria-label', `Edit ${entity.displayName}`);
      button.title = `Edit ${entity.displayName}`;
      const icon = element('i');
      icon.dataset.lucide = 'square-pen';
      icon.setAttribute('aria-hidden', 'true');
      button.append(icon);
      button.addEventListener('click', () => open(entity));
      action.append(button);
      row.append(
        name,
        element('td', '', typeNames[entity.entityType]),
        status,
        photo,
        action,
      );
      rows.append(row);
    }
    select('#menu-empty').hidden = entities.length > 0;
    const changes = select('#menu-changes');
    changes.replaceChildren();
    for (const change of data.changes) {
      const entity = data.entities.find(
        (entity) =>
          entity.entityType === change.entity_type &&
          entity.entityId === change.entity_id,
      );
      const row = element('tr');
      row.append(
        element('td', '', dateTime(change.occurred_at)),
        element('td', '', entity?.originalName || change.entity_id),
        element(
          'td',
          '',
          `${change.new_value.display_name || 'Toast name'} / ${change.new_value.hidden ? 'Hidden' : 'Toast visibility'}${change.new_value.photo_url ? ' / Custom photo' : ''}`,
        ),
        element('td', 'data-code', change.actor_user_id),
      );
      changes.append(row);
    }
    icons();
  }

  async function load() {
    const current = ++generation;
    const result = await request('/staff/menu');
    if (current !== generation || !active()) return '';
    data = result;
    render();
    return `${data.entities.length} menu entities`;
  }

  select('#menu-edit-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!selected || busy) return;
    const entity = selected;
    const current = generation;
    const name = select('#menu-online-name').value.trim();
    const override = {
      entity_type: entity.entityType,
      entity_id: entity.entityId,
      display_name: name && name !== entity.originalName ? name : null,
      hidden: select('#menu-hidden').checked,
      photo_url: ['item', 'modifier'].includes(entity.entityType)
        ? select('#menu-photo-url').value.trim() || null
        : null,
    };
    setBusy(true);
    select('#menu-edit-error').hidden = true;
    try {
      await request('/staff/menu/override', { method: 'POST', json: override });
      if (!active() || current !== generation) return;
      select('#menu-dialog').close();
      select('#menu-save-status').textContent = `${entity.originalName} saved.`;
      await load();
    } catch (error) {
      if (active() && selected === entity)
        showError(select('#menu-edit-error'), error);
    } finally {
      setBusy(false);
    }
  });

  select('#menu-photo-file').addEventListener('change', async () => {
    const file = select('#menu-photo-file').files[0];
    if (!file || !selected || busy) return;
    const entity = selected;
    const current = generation;
    setBusy(true);
    select('#menu-edit-error').hidden = true;
    select('#menu-photo-status').textContent = 'Uploading photo...';
    try {
      const blob = await preparePhoto(file);
      const result = await request(
        `/staff/menu/photo?entity_type=${encodeURIComponent(entity.entityType)}&entity_id=${encodeURIComponent(entity.entityId)}`,
        { method: 'POST', body: blob, contentType: blob.type },
      );
      if (!active() || current !== generation || selected !== entity) return;
      select('#menu-photo-url').value = result.photoUrl;
      preview(result.photoUrl);
      select('#menu-photo-status').textContent =
        'Photo uploaded. Save changes to publish.';
    } catch (error) {
      if (active() && selected === entity) {
        select('#menu-photo-status').textContent = 'Photo upload failed.';
        showError(select('#menu-edit-error'), error);
      }
    } finally {
      select('#menu-photo-file').value = '';
      setBusy(false);
    }
  });

  select('#menu-reset').addEventListener('click', () => {
    if (!selected) return;
    select('#menu-online-name').value = selected.originalName;
    select('#menu-hidden').checked = false;
    select('#menu-photo-url').value = '';
    preview(selected.toastPhotoUrl);
    select('#menu-photo-status').textContent =
      'Defaults restored. Save changes to publish.';
  });
  select('#menu-photo-url').addEventListener('change', () => {
    const url = select('#menu-photo-url').value.trim();
    preview(url.startsWith('https://') ? url : selected?.toastPhotoUrl);
  });
  select('#menu-photo-preview').addEventListener('error', () => {
    select('#menu-photo-preview').hidden = true;
  });
  for (const id of ['#menu-search', '#menu-kind', '#menu-visibility'])
    select(id).addEventListener(
      id === '#menu-search' ? 'input' : 'change',
      render,
    );
  select('#close-menu-dialog').addEventListener('click', () =>
    select('#menu-dialog').close(),
  );
  select('#menu-dialog').addEventListener('cancel', (event) => {
    if (busy) event.preventDefault();
  });
  select('#menu-dialog').addEventListener('close', () => {
    if (select('#menu-dialog').open) return;
    selected = undefined;
    preview(null);
  });

  return {
    load,
    reset() {
      generation++;
      data = selected = undefined;
      setBusy(false);
      select('#menu-dialog').close();
      preview(null);
      for (const id of ['#menu-rows', '#menu-changes'])
        select(id).replaceChildren();
      select('#menu-edit-form').reset();
      select('#menu-save-status').textContent = '';
    },
  };
}
