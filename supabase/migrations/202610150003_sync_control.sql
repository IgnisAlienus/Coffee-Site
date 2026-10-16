begin;

alter table public.integration_control
  add column lease_id uuid,
  add column next_request_at timestamptz not null default '-infinity',
  add column blocked_until timestamptz not null default '-infinity',
  add column project_url text,
  add column last_tick_at timestamptz;

alter table public.integration_events add column trigger_type text not null default 'manual'
  check (trigger_type in ('manual', 'scheduled'));

create table public.toast_sync_state (
  source text primary key check (source in ('menus', 'diningOptions', 'schedule', 'availability', 'stock', 'restaurant', 'taxRates', 'serviceCharges')),
  last_attempt_at timestamptz,
  next_attempt_at timestamptz not null default '-infinity',
  failures integer not null default 0 check (failures >= 0),
  last_code text,
  last_outcome text
);
insert into public.toast_sync_state(source) select unnest(array['menus','diningOptions','schedule','availability','stock','restaurant','taxRates','serviceCharges']);

create table public.toast_auth_cache (
  cache_key text primary key,
  ciphertext text,
  expires_at timestamptz,
  last_attempt_at timestamptz
);
alter table public.toast_sync_state enable row level security;
alter table public.toast_auth_cache enable row level security;
revoke all on public.toast_sync_state, public.toast_auth_cache from anon, authenticated, service_role;
grant select on public.toast_sync_state to service_role;
grant select, insert, update on public.toast_auth_cache to service_role;

create function public.claim_toast_worker() returns uuid
language plpgsql security definer set search_path = '' as $$
declare token uuid;
begin
  update public.integration_control set lease_id = gen_random_uuid(), locked_until = clock_timestamp() + interval '90 seconds'
  where id and locked_until <= clock_timestamp() and blocked_until <= clock_timestamp()
  returning lease_id into token;
  return token;
end $$;

create function public.finish_toast_worker(p_lease uuid) returns void
language sql security definer set search_path = '' as $$
  update public.integration_control set lease_id = null, locked_until = '-infinity' where id and lease_id = p_lease
$$;

create function public.reserve_toast_request(p_lease uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare control public.integration_control; slot timestamptz;
begin
  select * into control from public.integration_control where id for update;
  if control.lease_id is distinct from p_lease or control.locked_until <= clock_timestamp() then
    raise exception 'Sync lease expired' using errcode = '42501';
  end if;
  if control.blocked_until > clock_timestamp() then
    return jsonb_build_object('blockedSeconds', ceil(extract(epoch from control.blocked_until - clock_timestamp())));
  end if;
  slot := greatest(clock_timestamp(), control.next_request_at);
  update public.integration_control set next_request_at = slot + interval '1100 milliseconds' where id;
  return jsonb_build_object('waitMs', greatest(0, ceil(extract(epoch from slot - clock_timestamp()) * 1000)));
end $$;

create function public.block_toast_requests(p_lease uuid, p_seconds integer) returns void
language sql security definer set search_path = '' as $$
  update public.integration_control set blocked_until = greatest(blocked_until, clock_timestamp() + make_interval(secs => greatest(1, p_seconds)))
  where id and lease_id = p_lease and locked_until > clock_timestamp()
$$;

create function public.claim_toast_auth(p_lease uuid, p_cache_key text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare claimed boolean;
begin
  if not exists(select 1 from public.integration_control where id and lease_id = p_lease and locked_until > clock_timestamp()) then
    raise exception 'Sync lease expired' using errcode = '42501';
  end if;
  insert into public.toast_auth_cache(cache_key) values(p_cache_key) on conflict do nothing;
  update public.toast_auth_cache set last_attempt_at = clock_timestamp()
  where cache_key = p_cache_key and (last_attempt_at is null or last_attempt_at <= clock_timestamp() - interval '30 minutes')
  returning true into claimed;
  return coalesce(claimed, false);
end $$;

create function public.claim_toast_source(p_lease uuid, p_source text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare entry public.toast_sync_state;
begin
  if not exists(select 1 from public.integration_control where id and lease_id = p_lease and locked_until > clock_timestamp() and blocked_until <= clock_timestamp()) then
    return null;
  end if;
  update public.toast_sync_state set last_attempt_at = clock_timestamp(), next_attempt_at = clock_timestamp() + interval '30 seconds'
  where source = p_source and next_attempt_at <= clock_timestamp() returning * into entry;
  return case when entry.source is null then null else to_jsonb(entry) end;
end $$;

create function public.complete_toast_source(
  p_lease uuid, p_source text, p_payload jsonb, p_code text, p_status integer,
  p_retry_seconds integer, p_actor uuid, p_request_id uuid, p_trigger text
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.integration_control where id and lease_id = p_lease and locked_until > clock_timestamp() for update;
  if not found then
    raise exception 'Sync lease expired' using errcode = '42501';
  end if;
  if p_code = 'SYNCED' then
    insert into public.toast_snapshots(source, payload, fetched_at) values(p_source, p_payload, clock_timestamp())
    on conflict(source) do update set payload = excluded.payload, fetched_at = excluded.fetched_at;
  end if;
  update public.toast_sync_state set failures = case when p_code = 'SYNCED' then 0 else failures + 1 end,
    next_attempt_at = clock_timestamp() + make_interval(secs => case when p_code = 'SYNCED' then 30 else greatest(60, p_retry_seconds) end),
    last_code = p_code, last_outcome = case when p_code = 'SYNCED' then 'success' else 'failed' end
  where source = p_source;
  insert into public.integration_events(correlation_id, actor_user_id, source, outcome, code, upstream_status, trigger_type)
  values(p_request_id, p_actor, p_source, case when p_code = 'SYNCED' then 'success' else 'failed' end, p_code, p_status, p_trigger);
end $$;

revoke all on function public.claim_toast_worker(), public.finish_toast_worker(uuid), public.reserve_toast_request(uuid),
  public.block_toast_requests(uuid, integer), public.claim_toast_auth(uuid, text), public.claim_toast_source(uuid, text),
  public.complete_toast_source(uuid, text, jsonb, text, integer, integer, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_toast_worker(), public.finish_toast_worker(uuid), public.reserve_toast_request(uuid),
  public.block_toast_requests(uuid, integer), public.claim_toast_auth(uuid, text), public.claim_toast_source(uuid, text),
  public.complete_toast_source(uuid, text, jsonb, text, integer, integer, uuid, uuid, text) to service_role;

commit;