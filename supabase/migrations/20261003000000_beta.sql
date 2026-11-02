-- Weeks 7–8: closed beta. Invite codes, feedback categories, the daily spend
-- cap and the daily cost report (architecture doc §10, §13).
--
-- Every function here is SECURITY DEFINER and callable only by the service role.

-- ---------------------------------------------------------------------------
-- Invite codes. Players need one during onboarding while the beta is closed.
-- ---------------------------------------------------------------------------
create table public.invite_codes (
  code        text primary key check (code ~ '^[A-Z0-9-]{4,32}$'),
  note        text check (char_length(note) <= 200),   -- where the code was shared
  max_uses    int  not null default 1 check (max_uses > 0),
  uses        int  not null default 0 check (uses >= 0),
  expires_at  timestamptz,
  created_at  timestamptz not null default now()
);

alter table public.invite_codes enable row level security;
-- No policies: only the service role can read or change codes.

alter table public.profiles
  add column beta_access boolean not null default false,
  add column invite_code text references public.invite_codes (code) on delete set null;

-- Everyone who finished onboarding before invites existed keeps access.
update public.profiles set beta_access = true where birthdate_confirmed_18;

-- redeem_invite: grants beta access and uses up one use of the code, atomically.
-- Returns true if the player has access afterwards. A player who already has
-- access doesn't use up a code.
create function public.redeem_invite(p_user_id uuid, p_code text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
begin
  if exists (select 1 from public.profiles where id = p_user_id and beta_access) then
    return true;
  end if;

  update public.invite_codes
     set uses = uses + 1
   where code = upper(trim(p_code))
     and uses < max_uses
     and (expires_at is null or expires_at > now())
  returning code into v_code;

  if v_code is null then
    return false;
  end if;

  update public.profiles
     set beta_access = true, invite_code = v_code
   where id = p_user_id;
  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- Feedback (👎): a category next to the free-text reason, for counting.
-- ---------------------------------------------------------------------------
alter table public.turn_feedback
  add column category text not null default 'other'
    check (category in ('nonsense', 'contradiction', 'character', 'repetitive', 'too_long', 'other'));

create index turn_feedback_created_at_idx on public.turn_feedback (created_at);

-- Players can see their own flags (to show which turns they flagged); writes go
-- through a server action with the service role.
create policy "turn_feedback: read own"
  on public.turn_feedback for select to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- spend_since: total model spend since a moment. The turn route checks today's
-- spend against DAILY_SPEND_LIMIT_USD before every model call.
-- ---------------------------------------------------------------------------
create function public.spend_since(p_since timestamptz)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(cost_usd), 0) from public.usage_ledger where created_at >= p_since;
$$;

-- ---------------------------------------------------------------------------
-- daily_report: one UTC day of beta health, for scripts/costs.ts (§10 Alerts).
-- ---------------------------------------------------------------------------
create function public.daily_report(p_day date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with bounds as (
    select p_day::timestamp at time zone 'UTC' as t0, (p_day + 1)::timestamp at time zone 'UTC' as t1
  ),
  calls as (
    select u.* from public.usage_ledger u, bounds b
     where u.created_at >= b.t0 and u.created_at < b.t1
  ),
  day_turns as (
    select t.*, c.user_id from public.turns t
      join public.campaigns c on c.id = t.campaign_id, bounds b
     where t.created_at >= b.t0 and t.created_at < b.t1
  ),
  by_model as (
    select model,
           count(*) filter (where call_type in ('narrate', 'retry'))                  as calls,
           count(*) filter (where call_type = 'retry')                                as retries,
           count(*) filter (where call_type in ('narrate', 'retry') and turn_id is null) as failed_calls,
           count(distinct turn_id)                                                    as turns,
           sum(cost_usd)                                                              as cost_usd,
           sum(cost_usd) filter (where call_type = 'summarize')                       as summarize_usd,
           sum(input_tokens)       as input_tokens,
           sum(cache_read_tokens)  as cache_read_tokens,
           sum(cache_write_tokens) as cache_write_tokens,
           percentile_cont(0.5)  within group (order by latency_ms) filter (where call_type = 'narrate') as p50_ms,
           percentile_cont(0.95) within group (order by latency_ms) filter (where call_type = 'narrate') as p95_ms
      from calls
     group by model
  )
  select jsonb_build_object(
    'day', p_day,
    'spend_usd', (select coalesce(sum(cost_usd), 0) from calls),
    'month_to_date_usd', (
      select coalesce(sum(cost_usd), 0) from public.usage_ledger, bounds b
       where created_at >= date_trunc('month', p_day::timestamp) at time zone 'UTC' and created_at < b.t1
    ),
    'total_usd', (select coalesce(sum(cost_usd), 0) from public.usage_ledger, bounds b where created_at < b.t1),
    'turns', (select count(*) from day_turns),
    'players', (select count(distinct user_id) from day_turns),
    'new_players', (
      select count(*) from public.profiles p, bounds b
       where p.created_at >= b.t0 and p.created_at < b.t1 and p.beta_access
    ),
    'proposed_changes', (select coalesce(sum(jsonb_array_length(proposed_changes)), 0) from day_turns),
    'rejected_changes', (select coalesce(sum(jsonb_array_length(rejected_changes)), 0) from day_turns),
    'models', (select coalesce(jsonb_agg(to_jsonb(m) order by m.cost_usd desc), '[]'::jsonb) from by_model m),
    'feedback', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'turn_id', f.turn_id, 'category', f.category, 'reason', f.reason,
               'narration', left(t.narration, 280)) order by f.created_at), '[]'::jsonb)
        from public.turn_feedback f
        join public.turns t on t.id = f.turn_id, bounds b
       where f.created_at >= b.t0 and f.created_at < b.t1
    )
  );
$$;

revoke execute on function public.redeem_invite(uuid, text) from public, anon, authenticated;
revoke execute on function public.spend_since(timestamptz) from public, anon, authenticated;
revoke execute on function public.daily_report(date) from public, anon, authenticated;
grant execute on function public.redeem_invite(uuid, text) to service_role;
grant execute on function public.spend_since(timestamptz) to service_role;
grant execute on function public.daily_report(date) to service_role;
