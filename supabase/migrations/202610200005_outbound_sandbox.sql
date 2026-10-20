begin;

create schema toast_sandbox;
revoke all on schema toast_sandbox from public, anon, authenticated;
grant usage on schema toast_sandbox to service_role;

create table toast_sandbox.restaurants (
  id uuid primary key default gen_random_uuid(),
  toast_restaurant_guid uuid not null unique,
  name text not null,
  enabled boolean not null default false,
  created_at timestamptz not null default now()
);

create table toast_sandbox.gift_cards (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references toast_sandbox.restaurants(id),
  identifier_hash text not null check (identifier_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'inactive' check (status in ('inactive', 'active', 'closed')),
  balance_minor bigint not null default 0 check (balance_minor >= 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default now(),
  unique (restaurant_id, identifier_hash)
);

create table toast_sandbox.gift_card_transactions (
  id uuid primary key default gen_random_uuid(),
  gift_card_id uuid not null references toast_sandbox.gift_cards(id),
  toast_transaction_guid uuid not null,
  operation text not null check (operation in ('GIFTCARD_ACTIVATE', 'GIFTCARD_ADD_VALUE', 'GIFTCARD_GET_BALANCE', 'GIFTCARD_REDEEM', 'GIFTCARD_REVERSE')),
  amount_minor bigint check (amount_minor >= 0),
  outcome text not null default 'rejected' check (outcome in ('rejected', 'pending', 'applied', 'reversed')),
  created_at timestamptz not null default now(),
  unique (toast_transaction_guid, gift_card_id)
);

create table toast_sandbox.loyalty_accounts (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references toast_sandbox.restaurants(id),
  external_reference uuid not null default gen_random_uuid(),
  points_balance bigint not null default 0 check (points_balance >= 0),
  active boolean not null default false,
  created_at timestamptz not null default now(),
  unique (restaurant_id, external_reference)
);

create table toast_sandbox.loyalty_transactions (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references toast_sandbox.restaurants(id),
  loyalty_account_id uuid references toast_sandbox.loyalty_accounts(id),
  toast_transaction_guid uuid not null,
  operation text not null check (operation in ('LOYALTY_INQUIRE', 'LOYALTY_SEARCH', 'LOYALTY_SIGNUP', 'LOYALTY_REDEEM', 'LOYALTY_ACCRUE', 'LOYALTY_REVERSE', 'LOYALTY_TRANSFER')),
  points_delta bigint,
  outcome text not null default 'rejected' check (outcome in ('rejected', 'pending', 'applied', 'reversed')),
  created_at timestamptz not null default now(),
  unique nulls not distinct (restaurant_id, toast_transaction_guid, loyalty_account_id)
);

alter table toast_sandbox.restaurants enable row level security;
alter table toast_sandbox.gift_cards enable row level security;
alter table toast_sandbox.gift_card_transactions enable row level security;
alter table toast_sandbox.loyalty_accounts enable row level security;
alter table toast_sandbox.loyalty_transactions enable row level security;
revoke all on all tables in schema toast_sandbox from public, anon, authenticated, service_role;
grant select, insert, update, delete on toast_sandbox.restaurants, toast_sandbox.gift_cards, toast_sandbox.loyalty_accounts to service_role;
grant select, insert on toast_sandbox.gift_card_transactions, toast_sandbox.loyalty_transactions to service_role;

create trigger sandbox_gift_transactions_append_only before update or delete on toast_sandbox.gift_card_transactions
for each row execute function public.reject_audit_change();
create trigger sandbox_loyalty_transactions_append_only before update or delete on toast_sandbox.loyalty_transactions
for each row execute function public.reject_audit_change();

do $$
begin
  if not exists(select 1 from vault.decrypted_secrets where name = 'firehouse_toast_giftcards_sandbox_key') then
    perform vault.create_secret(gen_random_uuid()::text || gen_random_uuid()::text, 'firehouse_toast_giftcards_sandbox_key', 'Sandbox outbound gift-card API authentication; share securely with Toast');
  end if;
  if not exists(select 1 from vault.decrypted_secrets where name = 'firehouse_toast_loyalty_sandbox_key') then
    perform vault.create_secret(gen_random_uuid()::text || gen_random_uuid()::text, 'firehouse_toast_loyalty_sandbox_key', 'Sandbox outbound loyalty API authentication; share securely with Toast');
  end if;
end $$;

create function public.verify_toast_sandbox_key(p_provider text, p_key text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(length(p_key) between 32 and 255 and exists(
    select 1 from vault.decrypted_secrets
    where name = case p_provider
      when 'giftcards' then 'firehouse_toast_giftcards_sandbox_key'
      when 'loyalty' then 'firehouse_toast_loyalty_sandbox_key'
      else null end
      and decrypted_secret = p_key
  ), false)
$$;
revoke all on function public.verify_toast_sandbox_key(text, text) from public, anon, authenticated;
grant execute on function public.verify_toast_sandbox_key(text, text) to service_role;

commit;