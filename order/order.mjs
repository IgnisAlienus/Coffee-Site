import { api, dateTime, element, icons, money } from '../assets/api.mjs';

const search = document.querySelector('#search');
const refresh = document.querySelector('#refresh');
const status = document.querySelector('#menu-status');
const warning = document.querySelector('#menu-warning');
const layout = document.querySelector('#menu-layout');
const categories = document.querySelector('#categories');
const sections = document.querySelector('#menu-sections');
const empty = document.querySelector('#empty');
const itemDialog = document.querySelector('#item-dialog');
let catalog;

function photo(url, name, className) {
  const image = element('img', className);
  image.src = url;
  image.alt = name;
  image.loading = 'lazy';
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';
  image.addEventListener('error', () => { image.hidden = true; }, { once: true });
  return image;
}

function matchesOption(option, query, depth = 0) {
  if (option.name.toLowerCase().includes(query)) return true;
  return depth < 8 && (option.groups ?? []).some(group => group.options.some(child => matchesOption(child, query, depth + 1)));
}

function modifierDetails(groups, depth = 0, initialQuery = '') {
  const section = element('div', 'item-option-groups');
  if (depth > 8) return section;
  for (const [index, group] of groups.entries()) {
    const disclosure = element('details', 'option-group');
    disclosure.open = Boolean(initialQuery) || (depth === 0 && index === 0);
    const summary = element('summary');
    const heading = element('span', 'option-group-heading');
    const title = element('span', 'option-group-title', group.name);
    const count = element('span', 'muted option-count', `${group.options.length} option${group.options.length === 1 ? '' : 's'}`);
    heading.append(title, count, element('span', 'badge', group.minSelections > 0 ? 'Required' : 'Optional'));
    summary.append(heading);
    const body = element('div', 'option-group-body');
    if (group.minSelections > 0 || group.maxSelections !== null) {
      const limits = [];
      if (group.minSelections > 0) limits.push(`Minimum ${group.minSelections}`);
      if (group.maxSelections !== null) limits.push(`Maximum ${group.maxSelections}`);
      body.append(element('p', 'muted option-limits', limits.join(' / ')));
    }
    const options = element('ul', 'option-list');
    const noMatches = element('p', 'muted option-no-matches', 'No matching options.');
    noMatches.hidden = true;
    let searchInput;
    function renderOptions(query = '') {
      const normalized = query.trim().toLowerCase();
      const matching = group.options.filter(option => matchesOption(option, normalized));
      options.replaceChildren();
      for (const option of matching) {
        const row = element('li', 'option-entry');
        const label = element('div', 'option-label');
        if (option.photoUrl) label.append(photo(option.photoUrl, option.name, 'modifier-photo'));
        label.append(element('span', 'option-name', option.name));
        if (option.isDefault) label.append(element('small', 'badge', 'Default'));
        row.append(label);
        if (option.groups?.length) {
          const nestedQuery = normalized && !option.name.toLowerCase().includes(normalized) ? normalized : '';
          row.append(modifierDetails(option.groups, depth + 1, nestedQuery));
        }
        options.append(row);
      }
      count.textContent = normalized ? `${matching.length} of ${group.options.length} options` : `${group.options.length} option${group.options.length === 1 ? '' : 's'}`;
      noMatches.hidden = matching.length > 0;
    }
    if (group.options.length >= 10 || initialQuery) {
      const searchWrap = element('div', 'option-search');
      searchInput = element('input');
      searchInput.type = 'search';
      searchInput.placeholder = `Search ${group.name.toLowerCase()}`;
      searchInput.setAttribute('aria-label', `Search ${group.name} options`);
      searchInput.autocomplete = 'off';
      searchInput.value = initialQuery;
      const results = element('span', 'sr-only');
      results.setAttribute('role', 'status');
      searchInput.addEventListener('input', () => {
        renderOptions(searchInput.value);
        results.textContent = count.textContent;
      });
      searchWrap.append(searchInput, results);
      body.append(searchWrap);
    }
    renderOptions(initialQuery);
    body.append(options, noMatches);
    disclosure.append(summary, body);
    section.append(disclosure);
  }
  return section;
}

function itemPrice(item) {
  const price = item.startingPrice ?? item.basePrice;
  return typeof price === 'number' && Number.isFinite(price) && Math.round(price * 100) > 0
    ? `${item.basePrice === null || item.hasModifiers ? 'Starting at: ' : ''}${money(price)}` : '';
}

function stockBadge(stockStatus) {
  const states = {
    IN_STOCK: { label: 'In Stock', className: 'badge-good' },
    LIMITED: { label: 'Low Stock', className: 'badge-warning' },
    OUT_OF_STOCK: { label: 'Out of Stock', className: 'badge-error' },
  };
  const state = states[stockStatus];
  return state ? element('span', `badge ${state.className}`, state.label) : null;
}

function openItem(item) {
  document.querySelector('#item-dialog-name').textContent = item.name;
  document.querySelector('#item-dialog-description').textContent = item.description || '';
  const price = document.querySelector('#item-dialog-price');
  price.textContent = itemPrice(item);
  price.hidden = !price.textContent;
  const stock = stockBadge(item.stockStatus);
  const stockContainer = document.querySelector('#item-dialog-stock');
  stockContainer.replaceChildren(...(stock ? [stock] : []));
  stockContainer.hidden = !stock;
  const soldOut = item.stockStatus === 'OUT_OF_STOCK';
  document.querySelector('#item-dialog-order').hidden = soldOut;
  document.querySelector('#item-dialog-unavailable').hidden = !soldOut;
  document.querySelector('#item-dialog-order-note').textContent = soldOut
    ? 'This item is currently out of stock.' : 'Choose options and complete your order on Toast.';
  const image = document.querySelector('#item-dialog-photo');
  image.replaceChildren();
  if (item.photoUrl) image.append(photo(item.photoUrl, item.name, 'item-detail-photo'));
  document.querySelector('#item-dialog-options').replaceChildren(modifierDetails(item.modifierGroups));
  itemDialog.showModal();
}

function flatten(groups, parents = []) {
  return groups.flatMap(group => [
    { name: [...parents, group.name || 'Menu'].join(' / '), items: group.items },
    ...flatten(group.groups, [...parents, group.name || 'Menu']),
  ]).filter(group => group.items.length);
}

function render() {
  const query = search.value.trim().toLowerCase();
  categories.replaceChildren();
  sections.replaceChildren();
  const groups = catalog.menus.flatMap((menu, menuIndex) => flatten(menu.groups).map(group => ({ ...group, menuName: menu.name, menuIndex })));
  const menuNavigation = new Map();
  let itemCount = 0;
  groups.forEach((group, index) => {
    const items = group.items.filter(item => `${item.name} ${item.description}`.toLowerCase().includes(query));
    if (!items.length) return;
    itemCount += items.length;
    const id = `category-${index}`;
    let menuLinks = menuNavigation.get(group.menuIndex);
    if (!menuLinks) {
      const menu = element('section', 'category-menu');
      const heading = element('h2', 'category-menu-title', group.menuName);
      heading.id = `nav-menu-${group.menuIndex}`;
      menu.setAttribute('aria-labelledby', heading.id);
      menuLinks = element('div', 'category-links');
      menu.append(heading, menuLinks);
      categories.append(menu);
      menuNavigation.set(group.menuIndex, menuLinks);
    }
    const link = element('a', '', group.name);
    link.href = `#${id}`;
    menuLinks.append(link);
    const section = element('section', 'menu-section');
    section.id = id;
    section.setAttribute('aria-label', `${group.menuName} / ${group.name}`);
    section.append(element('h2', '', group.name));
    const grid = element('div', 'items');
    for (const item of items) {
      const article = element('article', 'menu-item');
      if (item.photoUrl) article.append(photo(item.photoUrl, item.name, 'item-photo'));
      article.append(element('h3', '', item.name));
      if (item.description) article.append(element('p', '', item.description));
      const footer = element('div', 'item-footer');
      const price = itemPrice(item);
      if (price) footer.append(element('strong', 'item-price', price));
      const stock = stockBadge(item.stockStatus);
      if (stock) footer.append(stock);
      if (footer.childElementCount) article.append(footer);
      if (item.modifierGroups?.length) {
        const action = element('button', 'item-options-button', 'View options');
        action.type = 'button';
        action.setAttribute('aria-label', `View options for ${item.name}`);
        action.setAttribute('aria-haspopup', 'dialog');
        const icon = element('i');
        icon.dataset.lucide = 'chevron-right';
        icon.setAttribute('aria-hidden', 'true');
        action.append(icon);
        action.addEventListener('click', () => openItem(item));
        article.append(action);
      }
      grid.append(article);
    }
    section.append(grid);
    sections.append(section);
  });
  layout.hidden = !itemCount;
  empty.hidden = Boolean(itemCount);
  document.querySelector('#empty-title').textContent = query ? 'No matching items' : 'No menu items available';
  document.querySelector('#empty-message').textContent = query ? 'Try another search.' : 'Please visit Toast for our current menu.';
  icons();
}

async function load() {
  refresh.disabled = true;
  status.textContent = 'Loading menu...';
  warning.hidden = true;
  try {
    catalog = await api('/catalog');
    search.disabled = false;
    const menuSource = catalog.sources.find(source => source.source === 'menus');
    status.textContent = `Menu updated ${dateTime(menuSource.fetchedAt)} CT`;
    const stale = catalog.sources.some(source => ['menus', 'availability', 'stock'].includes(source.source) && source.stale);
    if (stale) {
      warning.textContent = 'Some menu or stock information may have changed. Confirm availability and final pricing on Toast.';
      warning.hidden = false;
    }
    render();
  } catch {
    catalog = null;
    search.disabled = true;
    layout.hidden = true;
    empty.hidden = false;
    status.textContent = 'Online menu unavailable';
    document.querySelector('#empty-title').textContent = 'Order directly on Toast';
    document.querySelector('#empty-message').textContent = 'Our current menu, customizations, and pickup times are available on Toast.';
  } finally {
    refresh.disabled = false;
  }
}

search.addEventListener('input', () => { if (catalog) render(); });
refresh.addEventListener('click', load);
document.querySelector('#close-item-dialog').addEventListener('click', () => itemDialog.close());
itemDialog.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.preventDefault();
    itemDialog.close();
  }
});
itemDialog.addEventListener('click', event => {
  if (event.target !== itemDialog) return;
  const bounds = itemDialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) itemDialog.close();
});
itemDialog.addEventListener('close', () => {
  if (itemDialog.open) return;
  document.querySelector('#item-dialog-options').replaceChildren();
  document.querySelector('#item-dialog-photo').replaceChildren();
});
icons();
load();