import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('database enforces staff roles, MFA, private snapshots and append-only logs', async () => {
  const database = new PGlite();
  try {
    await database.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      create function auth.jwt() returns jsonb language sql stable as
        $$ select jsonb_build_object('aal', current_setting('request.jwt.claim.aal', true)) $$;
      grant usage on schema public, auth to anon, authenticated, service_role;
      grant execute on all functions in schema auth to authenticated;
      create schema storage;
      create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      create schema vault;
      create table vault.decrypted_secrets(name text unique, decrypted_secret text);
      create function vault.create_secret(secret text, secret_name text, description text) returns uuid language plpgsql as $$
        begin insert into vault.decrypted_secrets values(secret_name, secret); return gen_random_uuid(); end $$;
      create schema net;
      create table net.test_requests(id bigint generated always as identity, url text, headers jsonb);
      create function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds integer) returns bigint language plpgsql as $$
        declare request_id bigint; begin insert into net.test_requests(url, headers) values(url, headers) returning id into request_id; return request_id; end $$;
      create schema cron;
      create table cron.test_jobs(name text, schedule text, command text);
      create function cron.schedule(job_name text, expression text, command text) returns bigint language plpgsql as $$
        begin insert into cron.test_jobs values(job_name, expression, command); return 1; end $$;
    `);
    await database.exec(await readFile(new URL('../supabase/migrations/202610150001_ordering_foundation.sql', import.meta.url), 'utf8'));
    await database.exec(await readFile(new URL('../supabase/migrations/202610150002_menu_overrides.sql', import.meta.url), 'utf8'));
    await database.exec(await readFile(new URL('../supabase/migrations/202610150003_sync_control.sql', import.meta.url), 'utf8'));
    let schedulerSql = await readFile(new URL('../supabase/migrations/202610150004_sync_scheduler.sql', import.meta.url), 'utf8');
    for (const extension of ['create extension if not exists pg_cron with schema pg_catalog;', 'create extension if not exists pg_net with schema extensions;', 'create extension if not exists supabase_vault with schema vault;']) schedulerSql = schedulerSql.replace(extension, '');
    await database.exec(schedulerSql);
    const employee = '00000000-0000-4000-8000-000000000001';
    const manager = '00000000-0000-4000-8000-000000000002';
    const outsider = '00000000-0000-4000-8000-000000000003';
    await database.exec(`
      insert into auth.users values ('${employee}'), ('${manager}'), ('${outsider}');
      insert into public.staff_members(user_id, role) values ('${employee}', 'employee'), ('${manager}', 'manager');
      insert into public.orders(idempotency_key) values (gen_random_uuid());
      insert into public.order_events(order_id, event_type, summary, origin_ip)
        select id, 'test', 'Test event', '192.0.2.1' from public.orders;
      insert into public.integration_events(correlation_id, source, outcome, code)
        values(gen_random_uuid(), 'menus', 'failed', 'UPSTREAM_HTTP');
      insert into public.toast_snapshots(source, payload) values('menus', '{"restaurantGuid":"00000000-0000-4000-8000-000000000004"}');
      set role anon;
    `);
    for (const table of ['orders', 'order_events', 'toast_snapshots', 'staff_members', 'integration_events', 'menu_overrides', 'menu_change_events', 'toast_sync_state', 'toast_auth_cache']) {
      await assert.rejects(database.query(`select * from public.${table}`), /permission denied/);
    }
    await database.exec('reset role; set role authenticated;');
    async function identity(userId, aal = 'aal1') {
      await database.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.aal', $2, false)", [userId, aal]);
    }
    async function count(table) {
      return (await database.query(`select * from public.${table}`)).rows.length;
    }
    await identity(outsider);
    assert.equal(await count('orders'), 0);
    await identity(employee);
    const save = "select public.save_menu_override('00000000-0000-4000-8000-000000000004', 'item', 'ml:100', 'Online Latte', true, 'https://photos.example/latte.webp', gen_random_uuid())";
    await assert.rejects(database.query(save), /Manager MFA required/);
    assert.equal(await count('orders'), 1);
    assert.equal(await count('order_events'), 0);
    assert.equal(await count('integration_events'), 0);
    await assert.rejects(database.query("update public.staff_members set role = 'manager'"), /permission denied/);
    await assert.rejects(database.query('insert into public.orders(idempotency_key) values(gen_random_uuid())'), /permission denied/);
    await assert.rejects(database.query('select public.claim_toast_sync()'), /permission denied/);
    await assert.rejects(database.query('select public.claim_toast_worker()'), /permission denied/);
    await assert.rejects(database.query('select * from public.toast_auth_cache'), /permission denied/);
    await assert.rejects(database.query("select public.verify_toast_scheduler('not-a-secret')"), /permission denied/);
    await assert.rejects(database.query("select public.configure_toast_scheduler('https://project.supabase.co')"), /permission denied/);
    await identity(manager);
    await assert.rejects(database.query(save), /Manager MFA required/);
    assert.equal(await count('orders'), 0, 'Managers without MFA cannot access operational data');
    await identity(manager, 'aal2');
    await database.query(save);
    assert.equal(await count('menu_overrides'), 1);
    assert.equal(await count('menu_change_events'), 1);
    await database.query(save);
    assert.equal(await count('menu_change_events'), 2, 'Every save must be audited');
    await assert.rejects(database.query("update public.menu_overrides set hidden = false"), /permission denied/);
    await assert.rejects(database.query("select public.save_menu_override('00000000-0000-4000-8000-000000000099', 'item', 'ml:100', null, false, null, gen_random_uuid())"), /does not match/);
    assert.equal(await count('orders'), 1);
    assert.equal(await count('order_events'), 1);
    assert.equal(await count('integration_events'), 1);
    await database.exec(`reset role; update public.staff_members set active = false where user_id = '${employee}'; set role authenticated;`);
    await identity(employee);
    assert.equal(await count('menu_overrides'), 0);
    assert.equal(await count('menu_change_events'), 0);
    assert.equal(await count('orders'), 0);
    await database.exec('reset role; set role service_role;');
    assert.equal((await database.query('select public.claim_toast_sync() as claimed')).rows[0].claimed, true);
    assert.equal((await database.query('select public.claim_toast_sync() as claimed')).rows[0].claimed, false);
    await assert.rejects(database.query("update public.order_events set summary = 'altered'"), /permission denied/);
    await assert.rejects(database.query('delete from public.integration_events'), /permission denied/);
    await assert.rejects(database.query('truncate public.integration_events'), /permission denied/);
    await assert.rejects(database.query('update public.menu_overrides set hidden = false'), /permission denied/);
    await assert.rejects(database.query('truncate public.menu_change_events'), /permission denied/);
    await database.exec("reset role; update public.integration_control set locked_until = '-infinity'; set role service_role;");
    const lease = (await database.query('select public.claim_toast_worker() as lease')).rows[0].lease;
    assert.ok(lease);
    assert.equal((await database.query('select public.claim_toast_worker() as lease')).rows[0].lease, null, 'Workers must not overlap');
    await database.query('select public.finish_toast_worker($1)', [outsider]);
    assert.equal((await database.query('select public.claim_toast_worker() as lease')).rows[0].lease, null, 'A stale worker cannot release another lease');
    const firstSlot = (await database.query('select public.reserve_toast_request($1) as slot', [lease])).rows[0].slot;
    const secondSlot = (await database.query('select public.reserve_toast_request($1) as slot', [lease])).rows[0].slot;
    assert.ok(firstSlot.waitMs >= 0 && secondSlot.waitMs > firstSlot.waitMs, 'Requests reserve spaced time slots');
    assert.equal((await database.query('select public.claim_toast_auth($1, $2) as claimed', [lease, 'credential-hash'])).rows[0].claimed, true);
    assert.equal((await database.query('select public.claim_toast_auth($1, $2) as claimed', [lease, 'credential-hash'])).rows[0].claimed, false, 'Auth refreshes must be shared and throttled');
    assert.ok((await database.query("select public.claim_toast_source($1, 'stock') as source", [lease])).rows[0].source);
    assert.equal((await database.query("select public.claim_toast_source($1, 'stock') as source", [lease])).rows[0].source, null, 'Same source has a cooldown');
    assert.ok((await database.query("select public.claim_toast_source($1, 'availability') as source", [lease])).rows[0].source, 'A different source is independent');
    await database.query("select public.complete_toast_source($1, 'stock', '[]'::jsonb, 'SYNCED', null, 30, null, $2, 'scheduled')", [lease, manager]);
    await database.query("select public.complete_toast_source($1, 'stock', null, 'UPSTREAM_HTTP', 503, 240, null, $2, 'scheduled')", [lease, manager]);
    const stock = (await database.query("select payload from public.toast_snapshots where source = 'stock'")).rows[0];
    assert.deepEqual(stock.payload, [], 'Failures preserve the last successful snapshot');
    const retry = (await database.query("select failures, next_attempt_at > clock_timestamp() + interval '200 seconds' as backed_off from public.toast_sync_state where source = 'stock'")).rows[0];
    assert.equal(retry.failures, 1);
    assert.equal(retry.backed_off, true);
    await database.query('select public.block_toast_requests($1, 120)', [lease]);
    assert.ok((await database.query('select public.reserve_toast_request($1) as slot', [lease])).rows[0].slot.blockedSeconds > 100);
    await database.query('select public.finish_toast_worker($1)', [lease]);
    assert.equal((await database.query('select public.claim_toast_worker() as lease')).rows[0].lease, null, 'Global upstream cooldown applies to new workers');
    await assert.rejects(database.query('select public.enqueue_toast_sync()'), /permission denied/);
    assert.equal((await database.query("select public.verify_toast_scheduler('incorrect') as valid")).rows[0].valid, false);
    await database.query("select public.configure_toast_scheduler('https://project.supabase.co')");
    await database.exec("reset role; update public.integration_control set blocked_until = '-infinity';");
    const schedulerToken = (await database.query("select decrypted_secret from vault.decrypted_secrets where name = 'firehouse_toast_scheduler'")).rows[0].decrypted_secret;
    await database.exec('set role service_role;');
    assert.equal((await database.query('select public.verify_toast_scheduler($1) as valid', [schedulerToken])).rows[0].valid, true);
    await database.exec('reset role;');
    assert.ok((await database.query('select public.enqueue_toast_sync() as request')).rows[0].request);
    assert.equal((await database.query('select public.enqueue_toast_sync() as request')).rows[0].request, null, 'Duplicate minute ticks must not enqueue more requests');
    const queued = (await database.query('select url, headers from net.test_requests')).rows[0];
    assert.equal(queued.url, 'https://project.supabase.co/functions/v1/ordering-api/v1/internal/sync');
    assert.equal(queued.headers['x-sync-token'], schedulerToken);
    assert.equal((await database.query('select schedule from cron.test_jobs')).rows[0].schedule, '* * * * *');
    await database.exec('reset role;');
    await assert.rejects(database.query("update public.order_events set summary = 'altered'"), /append-only/);
    await assert.rejects(database.query('delete from public.integration_events'), /append-only/);
  } finally {
    await database.close();
  }
});