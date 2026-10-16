import { api, auth, clearAuth, dateTime, element, icons, money, showError } from '../assets/api.mjs';
import { createMenuEditor } from './menu.mjs';

const select = selector => document.querySelector(selector);
let staff;
let factorId;
let tab = 'orders';
let orderPage = 0;
let logPage = 0;
let eventPage = 0;
let selectedOrder;
let loadSequence = 0;
let syncBusy = false;
let sourceRetryTimer;
const sourceNames = { menus: 'Menus', diningOptions: 'Dining Options', schedule: 'Ordering Schedule', availability: 'Availability', stock: 'Stock', restaurant: 'Restaurant', taxRates: 'Tax Rates', serviceCharges: 'Service Charges' };
const menuEditor = createMenuEditor({ request, active: () => staff?.role === 'manager' });

async function request(path, options) {
  const client = await auth();
  const { data } = await client.auth.getSession();
  if (!data.session) throw new Error('Sign in to continue.');
  return api(path, { ...options, token: data.session.access_token });
}

function badge(value) {
  const error = ['failed', 'unknown', 'cancelled', 'voided'].includes(value);
  const good = ['accepted', 'captured', 'success'].includes(value);
  return element('span', `badge ${error ? 'badge-error' : good ? 'badge-good' : 'badge-warning'}`, String(value).replaceAll('_', ' '));
}

function pairs(values) {
  const details = element('dl');
  for (const [label, value] of values) {
    details.append(element('dt', '', label), element('dd', '', value ?? 'Not recorded'));
  }
  return details;
}

async function finishSignIn() {
  staff = await request('/staff/me');
  select('#login').hidden = true;
  select('#staff-session').hidden = false;
  select('#staff-role').textContent = staff.role;
  if (staff.mfaRequired) {
    select('#mfa').hidden = false;
    const client = await auth();
    const { data, error } = await client.auth.mfa.listFactors();
    if (error) throw new Error('Unable to load authenticators. Please sign out and try again.');
    factorId = data.totp.find(factor => factor.status === 'verified')?.id;
    select('#enroll').hidden = Boolean(factorId);
    select('#mfa-form').hidden = !factorId;
    if (factorId) select('#mfa-code').focus();
    return;
  }
  select('#mfa').hidden = true;
  select('#mfa-qr').removeAttribute('src');
  select('#workspace').hidden = false;
  select('#integration-tab').hidden = staff.role !== 'manager';
  select('#menu-tab').hidden = staff.role !== 'manager';
  await loadView();
}

async function signOut() {
  try { const client = await auth(); await client.auth.signOut({ scope: 'local' }); } catch {}
  await clearAuth();
  menuEditor.reset();
  clearTimeout(sourceRetryTimer);
  staff = undefined;
  factorId = undefined;
  selectedOrder = undefined;
  loadSequence++;
  tab = 'orders';
  orderPage = logPage = eventPage = 0;
  for (const id of ['#workspace', '#mfa', '#staff-session', '#mfa-qr', '#login-error', '#mfa-error']) select(id).hidden = true;
  for (const id of ['#order-rows', '#integration-rows', '#order-detail', '#order-events', '#sources', '#restaurant-rows']) select(id).replaceChildren();
  select('#restaurant-results').hidden = true;
  select('#discovery-status').textContent = '';
  select('#mfa-qr').removeAttribute('src');
  select('#mfa-code').value = '';
  select('#password').value = '';
  select('#login').hidden = false;
  select('#order-dialog').close();
  select('#orders-tab').setAttribute('aria-selected', 'true');
  select('#integration-tab').setAttribute('aria-selected', 'false');
  select('#menu-tab').setAttribute('aria-selected', 'false');
  select('#orders-view').hidden = false;
  select('#integration-view').hidden = true;
  select('#menu-view').hidden = true;
  select('#email').focus();
}

select('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  select('#sign-in').disabled = true;
  select('#login-error').hidden = true;
  try {
    const client = await auth();
    const { error } = await client.auth.signInWithPassword({ email: select('#email').value.trim(), password: select('#password').value });
    select('#password').value = '';
    if (error) throw new Error('Sign-in failed. Check your email and password.');
    await finishSignIn();
  } catch (error) {
    await signOut();
    showError(select('#login-error'), error);
  } finally { select('#sign-in').disabled = false; }
});

select('#enroll').addEventListener('click', async () => {
  select('#enroll').disabled = true;
  select('#mfa-error').hidden = true;
  try {
    const client = await auth();
    const { data: factors, error: listError } = await client.auth.mfa.listFactors();
    if (listError) throw new Error('Unable to load authenticators.');
    for (const factor of factors.all.filter(factor => factor.factor_type === 'totp' && factor.status === 'unverified')) {
      const { error } = await client.auth.mfa.unenroll({ factorId: factor.id });
      if (error) throw new Error('Unable to restart authenticator enrollment.');
    }
    const { data, error } = await client.auth.mfa.enroll({ factorType: 'totp', issuer: 'Firehouse Coffee Co.' });
    if (error) throw new Error('Unable to set up your authenticator.');
    factorId = data.id;
    const qrCode = data.totp.qr_code;
    select('#mfa-qr').src = qrCode.startsWith('data:image/svg+xml')
      ? qrCode : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrCode)}`;
    select('#mfa-qr').hidden = false;
    select('#mfa-form').hidden = false;
    select('#enroll').hidden = true;
    select('#mfa-code').focus();
  } catch (error) { showError(select('#mfa-error'), error); }
  finally { select('#enroll').disabled = false; }
});

select('#mfa-form').addEventListener('submit', async event => {
  event.preventDefault();
  select('#verify').disabled = true;
  select('#mfa-error').hidden = true;
  try {
    const client = await auth();
    const { error } = await client.auth.mfa.challengeAndVerify({ factorId, code: select('#mfa-code').value.trim() });
    select('#mfa-code').value = '';
    if (error) throw new Error('Verification failed. Enter a fresh authenticator code.');
    await finishSignIn();
  } catch (error) { showError(select('#mfa-error'), error); }
  finally { select('#verify').disabled = false; }
});

async function loadView() {
  const sequence = ++loadSequence;
  select('#refresh').disabled = true;
  select('#workspace-error').hidden = true;
  select('#workspace-status').textContent = 'Loading...';
  try {
    if (tab === 'orders') {
      const result = await request(`/staff/orders?page=${orderPage}&status=${encodeURIComponent(select('#status-filter').value)}`);
      if (sequence !== loadSequence || !staff) return;
      const rows = select('#order-rows');
      rows.replaceChildren();
      for (const order of result.orders) {
        const row = element('tr');
        const cell = element('td');
        const button = element('button', 'data-code', order.id.slice(0, 8));
        button.title = `View order ${order.id}`;
        button.addEventListener('click', () => openOrder(order.id));
        cell.append(button);
        row.append(cell, element('td', '', dateTime(order.created_at)), element('td', '', order.customer_name || 'Guest'));
        for (const value of [order.status, order.payment_status]) { const cell = element('td'); cell.append(badge(value)); row.append(cell); }
        row.append(element('td', '', money(Number(order.total_minor) / 100, order.currency)));
        rows.append(row);
      }
      select('#orders-empty').hidden = result.orders.length > 0;
      select('#orders-prev').disabled = orderPage === 0;
      select('#orders-next').disabled = (orderPage + 1) * result.pageSize >= result.total;
      select('#orders-page').textContent = `Page ${orderPage + 1}`;
      select('#workspace-status').textContent = `${result.total} order${result.total === 1 ? '' : 's'}`;
    } else if (tab === 'menu') {
      const message = await menuEditor.load();
      if (sequence === loadSequence && staff) select('#workspace-status').textContent = message;
    } else {
      const result = await request(`/staff/integrations?page=${logPage}`);
      if (sequence !== loadSequence || !staff) return;
      const sources = select('#sources');
      sources.replaceChildren();
      clearTimeout(sourceRetryTimer);
      const retryTimes = [];
      for (const source of result.sources) {
        const node = element('div', 'source');
        const heading = element('div', 'source-heading');
        const button = element('button', 'icon-button source-sync');
        button.type = 'button';
        button.title = `Sync ${sourceNames[source.source] || source.source}`;
        button.setAttribute('aria-label', button.title);
        button.dataset.syncSource = source.source;
        button.dataset.retryAt = source.next_attempt_at || '';
        const retryAt = Date.parse(source.next_attempt_at);
        button.disabled = syncBusy || retryAt > Date.now();
        const icon = element('i'); icon.dataset.lucide = 'refresh-cw'; icon.setAttribute('aria-hidden', 'true'); button.append(icon);
        button.addEventListener('click', () => syncSource(source.source));
        heading.append(element('strong', '', sourceNames[source.source] || source.source), button);
        node.append(heading, element('span', `badge ${source.stale ? 'badge-warning' : 'badge-good'}`, source.fetchedAt ? source.stale ? 'Stale' : 'Fresh' : 'Not synced'), element('small', '', source.fetchedAt ? `${dateTime(source.fetchedAt)} CT` : 'No successful sync'));
        node.append(element('small', '', ['stock', 'availability'].includes(source.source) ? 'Every minute' : 'Daily / 2:00 AM Central'));
        if (retryAt > Date.now()) { node.append(element('small', '', `Available after ${dateTime(source.next_attempt_at)} CT`)); retryTimes.push(retryAt); }
        if (source.last_outcome === 'failed') node.append(element('small', 'source-error', source.last_code));
        sources.append(node);
      }
      if (retryTimes.length) sourceRetryTimer = setTimeout(() => {
        if (staff && tab === 'integration' && !syncBusy) loadView();
      }, Math.max(1000, Math.min(...retryTimes) - Date.now() + 100));
      const schedule = result.schedule;
      select('#schedule-status').textContent = schedule
        ? `${schedule.ready ? 'Automatic sync enabled.' : 'Automatic sync awaiting setup.'} Daily: 2:00 AM Central. Stock and availability: every minute.${schedule.blockedUntil && Date.parse(schedule.blockedUntil) > Date.now() ? ` Toast cooldown until ${dateTime(schedule.blockedUntil)} CT.` : ''}${schedule.lastTickAt ? ` Last scheduler tick: ${dateTime(schedule.lastTickAt)} CT.` : ''}` : '';
      icons();
      const rows = select('#integration-rows');
      rows.replaceChildren();
      for (const event of result.events) {
        const row = element('tr');
        const sourceCell = element('td', 'data-code', event.source);
        sourceCell.append(element('small', 'muted', event.trigger_type === 'scheduled' ? 'Scheduled' : 'Manual'));
        row.append(element('td', '', dateTime(event.occurred_at)), sourceCell);
        const outcome = element('td'); outcome.append(badge(event.outcome)); row.append(outcome);
        row.append(element('td', 'data-code', event.code), element('td', '', event.upstream_status ?? '-'), element('td', 'data-code', event.correlation_id));
        rows.append(row);
      }
      select('#integration-empty').hidden = result.events.length > 0;
      select('#logs-prev').disabled = logPage === 0;
      select('#logs-next').disabled = result.events.length < result.pageSize;
      select('#logs-page').textContent = `Page ${logPage + 1}`;
      select('#workspace-status').textContent = 'Read-only Toast connection';
    }
  } catch (error) {
    if (sequence === loadSequence) {
      select('#workspace-status').textContent = 'Unable to refresh';
      showError(select('#workspace-error'), error);
    }
  } finally { if (sequence === loadSequence) select('#refresh').disabled = false; }
}

async function openOrder(id) {
  selectedOrder = id;
  eventPage = 0;
  select('#detail-error').hidden = true;
  select('#order-evidence').hidden = true;
  select('#order-detail').textContent = 'Loading order...';
  select('#order-dialog').showModal();
  try {
    const order = await request(`/staff/orders/${id}`);
    if (!staff || selectedOrder !== id || !select('#order-dialog').open) return;
    const detail = select('#order-detail');
    detail.replaceChildren(pairs([
      ['Order ID', order.id], ['Toast ID', order.toast_order_guid], ['Created (CT)', dateTime(order.created_at)],
      ['Customer', order.customer_name || 'Guest'], ['Status', order.status], ['Payment', order.payment_status],
      ['Total', money(Number(order.total_minor) / 100, order.currency)],
    ]));
    detail.append(element('h3', '', 'Items'));
    const items = element('ul');
    for (const item of order.items) items.append(element('li', '', `${item.quantity ?? 1} x ${item.name ?? 'Item'}`));
    detail.append(items);
    if (staff.role === 'manager') { select('#order-evidence').hidden = false; await loadEvents(); }
  } catch (error) { showError(select('#detail-error'), error); }
}

async function loadEvents() {
  const id = selectedOrder;
  select('#detail-error').hidden = true;
  select('#order-events').textContent = 'Loading timeline...';
  try {
    const result = await request(`/staff/orders/${id}/events?page=${eventPage}`);
    if (!staff || selectedOrder !== id || !select('#order-dialog').open) return;
    const container = select('#order-events');
    container.replaceChildren();
    if (!result.events.length) container.append(element('p', 'muted', 'No events recorded.'));
    for (const event of result.events) {
      const node = element('article', 'event');
      node.append(element('h3', '', event.event_type), element('p', 'muted', `${dateTime(event.occurred_at)} CT`), element('p', '', event.summary));
      node.append(pairs([
        ['Correlation ID', event.correlation_id], ['Origin IP', event.origin_ip], ['User agent', event.user_agent],
        ['Provider reference', event.provider_reference], ['Upstream HTTP', event.upstream_status],
        ['Policy version', event.policy_version], ['Fulfillment', event.fulfillment_reference], ['Staff actor', event.actor_user_id],
      ]));
      container.append(node);
    }
    select('#events-prev').disabled = eventPage === 0;
    select('#events-next').disabled = result.events.length < result.pageSize;
    select('#events-page').textContent = `Page ${eventPage + 1}`;
  } catch (error) { showError(select('#detail-error'), error); }
}

select('#discover-restaurants').addEventListener('click', async () => {
  select('#discover-restaurants').disabled = true;
  select('#discovery-status').textContent = 'Finding Toast restaurants...';
  select('#restaurant-results').hidden = true;
  select('#restaurant-rows').replaceChildren();
  select('#workspace-error').hidden = true;
  const session = staff;
  try {
    const result = await request('/staff/restaurants');
    if (!staff || staff !== session) return;
    const rows = select('#restaurant-rows');
    for (const restaurant of result.restaurants) {
      const row = element('tr');
      row.append(element('td', '', restaurant.restaurantName || 'Restaurant'), element('td', '', restaurant.locationName || '-'), element('td', 'data-code', restaurant.restaurantGuid));
      rows.append(row);
    }
    select('#restaurant-results').hidden = result.restaurants.length === 0;
    select('#discovery-status').textContent = result.restaurants.length === 0
      ? 'No accessible Toast restaurants found.'
      : result.configuredRestaurantGuid ? `Configured restaurant: ${result.configuredRestaurantGuid}`
      : result.restaurants.length === 1 ? 'One restaurant found. Sync will use this location automatically.'
      : 'Multiple restaurants found. Set TOAST_RESTAURANT_GUID in Supabase secrets to the GUID for this store.';
    await loadView();
  } catch (error) {
    if (staff === session) {
      select('#discovery-status').textContent = 'Restaurant lookup did not complete.';
      await loadView();
      showError(select('#workspace-error'), error);
    }
  } finally { select('#discover-restaurants').disabled = false; }
});

function setSyncBusy(value) {
  syncBusy = value;
  select('#sync').disabled = value;
  for (const button of document.querySelectorAll('[data-sync-source]')) button.disabled = value || Date.parse(button.dataset.retryAt) > Date.now();
}

async function syncSource(source = 'all') {
  if (syncBusy) return;
  setSyncBusy(true);
  select('#sync-status').textContent = `Syncing ${source === 'all' ? 'all sources' : sourceNames[source] || source} from Toast...`;
  select('#workspace-error').hidden = true;
  const session = staff;
  try {
    const result = await request(`/staff/sync?source=${encodeURIComponent(source)}`, { method: 'POST' });
    if (!staff || staff !== session) return;
    const failures = result.results.filter(result => result.outcome !== 'success');
    select('#sync-status').textContent = result.message || (failures.length ? failures[0].message || 'Some sources were not synced. Review the connection logs.' : `${source === 'all' ? 'All sources' : sourceNames[source] || source} synced.`);
    logPage = 0;
    await loadView();
  } catch (error) {
    if (staff === session) { select('#sync-status').textContent = 'Sync did not complete.'; showError(select('#workspace-error'), error); }
  } finally { setSyncBusy(false); }
}
select('#sync').addEventListener('click', () => syncSource());

for (const name of ['orders', 'menu', 'integration']) {
  select(`#${name}-tab`).addEventListener('click', () => {
    tab = name;
    for (const current of ['orders', 'menu', 'integration']) {
      select(`#${current}-tab`).setAttribute('aria-selected', String(current === name));
      select(`#${current}-view`).hidden = current !== name;
    }
    loadView();
  });
}
for (const [id, direction] of [['orders-prev', -1], ['orders-next', 1]]) select(`#${id}`).addEventListener('click', () => { orderPage += direction; loadView(); });
for (const [id, direction] of [['logs-prev', -1], ['logs-next', 1]]) select(`#${id}`).addEventListener('click', () => { logPage += direction; loadView(); });
for (const [id, direction] of [['events-prev', -1], ['events-next', 1]]) select(`#${id}`).addEventListener('click', () => { eventPage += direction; loadEvents(); });
select('#status-filter').addEventListener('change', () => { orderPage = 0; loadView(); });
select('#refresh').addEventListener('click', loadView);
select('#sign-out').addEventListener('click', signOut);
select('#close-dialog').addEventListener('click', () => select('#order-dialog').close());
select('#order-dialog').addEventListener('close', () => { selectedOrder = undefined; select('#order-detail').replaceChildren(); select('#order-events').replaceChildren(); });
icons();