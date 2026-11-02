-- Infinite Worlds — Phase 1 initial schema
-- See phase1_system_architecture.md §5 (data model) and §12 (security).
--
-- Access model: players may READ their own rows through RLS. All writes go
-- through server routes using the service-role key, which bypasses RLS. The
-- only client-side write allowed is a player updating their own display name.

-- ---------------------------------------------------------------------------
-- profiles (1:1 with auth.users)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id                      uuid primary key references auth.users (id) on delete cascade,
  display_name            text check (char_length(display_name) <= 40),
  birthdate_confirmed_18  boolean not null default false,
  plan                    text not null default 'free' check (plan in ('free', 'premium')),
  created_at              timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- campaigns (one save slot / playthrough)
-- ---------------------------------------------------------------------------
create table public.campaigns (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles (id) on delete cascade,
  world_id           text not null,
  world_version      text not null,
  origin_id          text not null,
  state              jsonb not null,
  chronicle_summary  text not null default '',
  turn_count         int  not null default 0,
  version            int  not null default 0,   -- optimistic lock
  status             text not null default 'active' check (status in ('active', 'ended', 'dead')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index campaigns_user_id_idx on public.campaigns (user_id, updated_at desc);

-- ---------------------------------------------------------------------------
-- turns (append-only)
-- ---------------------------------------------------------------------------
create table public.turns (
  id                uuid primary key default gen_random_uuid(),
  campaign_id       uuid not null references public.campaigns (id) on delete cascade,
  turn_number       int  not null,
  player_input      text not null check (char_length(player_input) <= 500),
  narration         text not null,
  choices           jsonb not null default '[]'::jsonb,
  proposed_changes  jsonb not null default '[]'::jsonb,
  applied_changes   jsonb not null default '[]'::jsonb,
  rejected_changes  jsonb not null default '[]'::jsonb,
  scene_tag         text,
  model             text not null,
  created_at        timestamptz not null default now(),
  unique (campaign_id, turn_number)
);

-- ---------------------------------------------------------------------------
-- usage_ledger (one row per LLM call, including failed attempts)
-- ---------------------------------------------------------------------------
create table public.usage_ledger (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles (id) on delete cascade,
  campaign_id         uuid references public.campaigns (id) on delete set null,
  turn_id             uuid references public.turns (id) on delete set null,
  call_type           text not null check (call_type in ('narrate', 'summarize', 'retry')),
  model               text not null,
  input_tokens        int not null default 0,
  cache_read_tokens   int not null default 0,
  cache_write_tokens  int not null default 0,
  output_tokens       int not null default 0,
  cost_usd            numeric(10, 6) not null default 0,
  latency_ms          int,
  stop_reason         text,
  created_at          timestamptz not null default now()
);

create index usage_ledger_created_at_idx on public.usage_ledger (created_at);
create index usage_ledger_user_id_idx on public.usage_ledger (user_id, created_at);

-- ---------------------------------------------------------------------------
-- turn_balances (entitlements)
-- ---------------------------------------------------------------------------
create table public.turn_balances (
  user_id            uuid primary key references public.profiles (id) on delete cascade,
  monthly_allowance  int  not null default 0,
  monthly_used       int  not null default 0,
  pack_credits       int  not null default 0,
  daily_free_used    int  not null default 0,
  daily_reset_on     date not null default current_date,
  period_start       date not null default current_date
);

-- ---------------------------------------------------------------------------
-- subscriptions (mirrors Stripe)
-- ---------------------------------------------------------------------------
create table public.subscriptions (
  user_id                 uuid primary key references public.profiles (id) on delete cascade,
  stripe_customer_id      text unique,
  stripe_subscription_id  text unique,
  status                  text,
  current_period_end      timestamptz
);

-- Idempotency for Stripe webhooks (§11)
create table public.stripe_events (
  id           text primary key,          -- Stripe event ID
  type         text not null,
  received_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- turn_feedback (👎 button, §13)
-- ---------------------------------------------------------------------------
create table public.turn_feedback (
  id          uuid primary key default gen_random_uuid(),
  turn_id     uuid not null references public.turns (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  reason      text check (char_length(reason) <= 500),
  created_at  timestamptz not null default now(),
  unique (turn_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
alter table public.profiles       enable row level security;
alter table public.campaigns      enable row level security;
alter table public.turns          enable row level security;
alter table public.usage_ledger   enable row level security;
alter table public.turn_balances  enable row level security;
alter table public.subscriptions  enable row level security;
alter table public.stripe_events  enable row level security;
alter table public.turn_feedback  enable row level security;

create policy "profiles: read own"
  on public.profiles for select to authenticated
  using ((select auth.uid()) = id);

-- Players may only change their display name; plan and age-gate columns are
-- server-controlled (enforced by column privileges below).
create policy "profiles: update own"
  on public.profiles for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

revoke update on public.profiles from authenticated;
grant update (display_name) on public.profiles to authenticated;

create policy "campaigns: read own"
  on public.campaigns for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "turns: read own"
  on public.turns for select to authenticated
  using (exists (
    select 1 from public.campaigns c
    where c.id = turns.campaign_id and c.user_id = (select auth.uid())
  ));

create policy "turn_balances: read own"
  on public.turn_balances for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "subscriptions: read own"
  on public.subscriptions for select to authenticated
  using ((select auth.uid()) = user_id);

-- usage_ledger, stripe_events and turn_feedback have RLS on and no policies:
-- only the service role can touch them.

-- ---------------------------------------------------------------------------
-- New user → profile + balance rows
-- ---------------------------------------------------------------------------
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id);
  insert into public.turn_balances (user_id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Keep campaigns.updated_at fresh
-- ---------------------------------------------------------------------------
create function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger campaigns_touch_updated_at
  before update on public.campaigns
  for each row execute function public.touch_updated_at();
