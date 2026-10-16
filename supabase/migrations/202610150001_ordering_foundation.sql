begin;

create table public.staff_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('employee', 'manager')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create function public.staff_role() returns text
language sql stable security definer set search_path = ''
as $$
  select role from public.staff_members
  where user_id = auth.uid() and active
    and (role = 'employee' or auth.jwt()->>'aal' = 'aal2')
$$;
revoke all on function public.staff_role() from public, anon;
grant execute on function public.staff_role() to authenticated;

create table public.toast_snapshots (
  source text primary key check (source in ('menus', 'diningOptions', 'schedule', 'availability', 'stock', 'restaurant', 'taxRates', 'serviceCharges')),
  payload jsonb not null,
  fetched_at timestamptz not null default now()
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  idempotency_key uuid not null unique,
  toast_order_guid uuid unique,
  status text not null default 'draft' check (status in ('draft', 'submitting', 'accepted', 'unknown', 'failed', 'cancelled')),
  payment_status text not null default 'not_started' check (payment_status in ('not_started', 'authorized', 'captured', 'voided', 'failed', 'refunded')),
  customer_name text,
  total_minor bigint not null default 0 check (total_minor >= 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  items jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index orders_created_at_idx on public.orders(created_at desc, id desc);
create index orders_status_created_at_idx on public.orders(status, created_at desc);

create table public.order_events (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id),
  occurred_at timestamptz not null default now(),
  correlation_id uuid not null default gen_random_uuid(),
  actor_user_id uuid,
  event_type text not null,
  summary text not null,
  origin_ip inet,
  user_agent text,
  provider_reference text,
  upstream_status integer check (upstream_status between 100 and 599),
  policy_version text,
  fulfillment_reference text
);
create index order_events_order_time_idx on public.order_events(order_id, occurred_at, id);

create table public.integration_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  correlation_id uuid not null,
  actor_user_id uuid,
  source text not null,
  outcome text not null check (outcome in ('success', 'failed')),
  code text not null,
  upstream_status integer check (upstream_status between 100 and 599)
);
create index integration_events_time_idx on public.integration_events(occurred_at desc, id desc);

create function public.reject_audit_change() returns trigger
language plpgsql set search_path = ''
as $$ begin raise exception 'Audit events are append-only'; end $$;
create trigger order_events_append_only before update or delete on public.order_events
for each row execute function public.reject_audit_change();
create trigger integration_events_append_only before update or delete on public.integration_events
for each row execute function public.reject_audit_change();
revoke all on function public.reject_audit_change() from public, anon, authenticated;

create table public.integration_control (
  id boolean primary key default true check (id),
  locked_until timestamptz not null default '-infinity'
);
insert into public.integration_control(id) values (true);
create function public.claim_toast_sync() returns boolean
language plpgsql security definer set search_path = ''
as $$
declare claimed boolean;
begin
  update public.integration_control set locked_until = now() + interval '2 minutes'
  where id and locked_until < now() returning true into claimed;
  return coalesce(claimed, false);
end
$$;
revoke all on function public.claim_toast_sync() from public, anon, authenticated;
grant execute on function public.claim_toast_sync() to service_role;

alter table public.staff_members enable row level security;
alter table public.toast_snapshots enable row level security;
alter table public.orders enable row level security;
alter table public.order_events enable row level security;
alter table public.integration_events enable row level security;
alter table public.integration_control enable row level security;

revoke all on public.staff_members, public.toast_snapshots, public.orders,
  public.order_events, public.integration_events, public.integration_control from anon, authenticated;
revoke all on sequence public.order_events_id_seq, public.integration_events_id_seq from anon, authenticated;
grant select on public.staff_members, public.orders, public.order_events, public.integration_events to authenticated;
grant all on public.staff_members, public.toast_snapshots, public.orders, public.integration_control to service_role;
revoke all on public.order_events, public.integration_events from service_role;
grant select, insert on public.order_events, public.integration_events to service_role;
grant usage, select on sequence public.order_events_id_seq, public.integration_events_id_seq to service_role;

create policy staff_self_read on public.staff_members for select to authenticated
using (user_id = auth.uid());
create policy staff_orders_read on public.orders for select to authenticated
using ((select public.staff_role()) in ('employee', 'manager'));
create policy manager_order_events_read on public.order_events for select to authenticated
using ((select public.staff_role()) = 'manager');
create policy manager_integration_events_read on public.integration_events for select to authenticated
using ((select public.staff_role()) = 'manager');

commit;