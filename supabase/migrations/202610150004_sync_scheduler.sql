create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;

begin;

do $$
begin
  if not exists(select 1 from vault.decrypted_secrets where name = 'firehouse_toast_scheduler') then
    perform vault.create_secret(gen_random_uuid()::text || gen_random_uuid()::text, 'firehouse_toast_scheduler', 'Internal Toast sync scheduler authentication');
  end if;
end $$;

create function public.configure_toast_scheduler(p_project_url text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_project_url !~ '^https?://[A-Za-z0-9.:-]+$' then raise exception 'Invalid project URL'; end if;
  update public.integration_control set project_url = p_project_url where id and project_url is distinct from p_project_url;
end $$;

create function public.verify_toast_scheduler(p_token text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(length(p_token) >= 64 and exists(
    select 1 from vault.decrypted_secrets where name = 'firehouse_toast_scheduler' and decrypted_secret = p_token
  ), false)
$$;

create function public.enqueue_toast_sync() returns bigint
language plpgsql security definer set search_path = '' as $$
declare target text; secret text; request_id bigint;
begin
  update public.integration_control set last_tick_at = clock_timestamp()
  where id and project_url is not null and blocked_until <= clock_timestamp() and locked_until <= clock_timestamp()
    and (last_tick_at is null or last_tick_at < date_trunc('minute', clock_timestamp()))
  returning project_url into target;
  if target is null then return null; end if;
  select decrypted_secret into strict secret from vault.decrypted_secrets where name = 'firehouse_toast_scheduler';
  select net.http_post(
    url := target || '/functions/v1/ordering-api/v1/internal/sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-token', secret),
    body := '{}'::jsonb, timeout_milliseconds := 65000
  ) into request_id;
  return request_id;
end $$;

revoke all on function public.configure_toast_scheduler(text), public.verify_toast_scheduler(text), public.enqueue_toast_sync() from public, anon, authenticated, service_role;
grant execute on function public.configure_toast_scheduler(text), public.verify_toast_scheduler(text) to service_role;

select cron.schedule('firehouse-toast-sync', '* * * * *', 'select public.enqueue_toast_sync();');

commit;