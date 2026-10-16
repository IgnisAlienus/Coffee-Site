begin;

create table public.menu_overrides (
  restaurant_guid uuid not null,
  entity_type text not null check (entity_type in ('menu', 'group', 'item', 'modifierGroup', 'modifier')),
  entity_id text not null check (entity_id ~ '^(ml|guid):[A-Za-z0-9-]{1,100}$'),
  display_name text check (display_name is null or (length(display_name) between 1 and 100 and display_name !~ '[[:cntrl:]]')),
  hidden boolean not null default false,
  photo_url text check (photo_url is null or (length(photo_url) <= 2048 and photo_url ~ '^https://')),
  updated_at timestamptz not null default now(),
  updated_by uuid not null,
  primary key (restaurant_guid, entity_type, entity_id),
  check (photo_url is null or entity_type in ('item', 'modifier'))
);

create table public.menu_change_events (
  id bigint generated always as identity primary key,
  restaurant_guid uuid not null,
  entity_type text not null,
  entity_id text not null,
  occurred_at timestamptz not null default now(),
  actor_user_id uuid not null,
  correlation_id uuid not null,
  previous_value jsonb,
  new_value jsonb not null
);
create index menu_change_events_time_idx on public.menu_change_events(occurred_at desc, id desc);
create trigger menu_change_events_append_only before update or delete on public.menu_change_events
for each row execute function public.reject_audit_change();

alter table public.menu_overrides enable row level security;
alter table public.menu_change_events enable row level security;
revoke all on public.menu_overrides, public.menu_change_events from anon, authenticated, service_role;
revoke all on sequence public.menu_change_events_id_seq from anon, authenticated, service_role;
grant select on public.menu_overrides, public.menu_change_events to authenticated, service_role;
create policy manager_menu_overrides_read on public.menu_overrides for select to authenticated
using ((select public.staff_role()) = 'manager');
create policy manager_menu_changes_read on public.menu_change_events for select to authenticated
using ((select public.staff_role()) = 'manager');

create function public.save_menu_override(
  p_restaurant_guid uuid, p_entity_type text, p_entity_id text, p_display_name text,
  p_hidden boolean, p_photo_url text, p_request_id uuid
) returns void
language plpgsql security definer set search_path = ''
as $$
declare previous jsonb; updated jsonb;
begin
  if public.staff_role() is distinct from 'manager' then
    raise exception 'Manager MFA required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.toast_snapshots where source = 'menus'
      and payload->>'restaurantGuid' = p_restaurant_guid::text
  ) then raise exception 'Restaurant does not match imported menu'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_restaurant_guid::text || ':' || p_entity_type || ':' || p_entity_id, 0));
  select to_jsonb(existing) into previous from public.menu_overrides existing
    where restaurant_guid = p_restaurant_guid and entity_type = p_entity_type and entity_id = p_entity_id;
  insert into public.menu_overrides(restaurant_guid, entity_type, entity_id, display_name, hidden, photo_url, updated_by)
  values(p_restaurant_guid, p_entity_type, p_entity_id, nullif(trim(p_display_name), ''), p_hidden, p_photo_url, auth.uid())
  on conflict (restaurant_guid, entity_type, entity_id) do update set
    display_name = excluded.display_name, hidden = excluded.hidden, photo_url = excluded.photo_url,
    updated_by = excluded.updated_by, updated_at = now()
  returning to_jsonb(menu_overrides.*) into updated;
  insert into public.menu_change_events(restaurant_guid, entity_type, entity_id, actor_user_id, correlation_id, previous_value, new_value)
  values(p_restaurant_guid, p_entity_type, p_entity_id, auth.uid(), p_request_id, previous, updated);
end
$$;
revoke all on function public.save_menu_override(uuid, text, text, text, boolean, text, uuid) from public, anon, service_role;
grant execute on function public.save_menu_override(uuid, text, text, text, boolean, text, uuid) to authenticated;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values('menu-photos', 'menu-photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = 5242880,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

commit;