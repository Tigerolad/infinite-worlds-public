-- Week 3: turn commit, per-campaign turn lock, intro allowance.
-- See phase1_system_architecture.md §4 (turn lifecycle) and §10 (quotas).
--
-- All functions here are SECURITY DEFINER and callable only by the service
-- role (server routes). Players can never call them directly.

-- Free Sonnet turns every new player gets once (the "first chapter", §7.1).
-- Counted per user, not per campaign, so starting new campaigns doesn't reset it.
alter table public.turn_balances
  add column intro_turns_used int not null default 0;

-- At most one in-flight turn per campaign (§10). Set when a turn starts,
-- cleared on commit or failure; expires on its own if a server crashes.
alter table public.campaigns
  add column turn_locked_until timestamptz;

-- ---------------------------------------------------------------------------
-- lock_campaign_turn: take the turn lock. Returns the campaign row, or no row
-- if it doesn't exist, isn't the user's, isn't active, or is already locked.
-- ---------------------------------------------------------------------------
create function public.lock_campaign_turn(p_campaign_id uuid, p_user_id uuid)
returns setof public.campaigns
language sql
security definer
set search_path = ''
as $$
  update public.campaigns
     set turn_locked_until = now() + interval '90 seconds'
   where id = p_campaign_id
     and user_id = p_user_id
     and status = 'active'
     and (turn_locked_until is null or turn_locked_until < now())
  returning *;
$$;

create function public.unlock_campaign_turn(p_campaign_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.campaigns set turn_locked_until = null where id = p_campaign_id;
$$;

-- ---------------------------------------------------------------------------
-- commit_turn: everything a successful turn writes, in one transaction (§4 [8]).
-- Raises 'version_conflict' or 'out_of_turns'; either rolls back all of it.
--
-- p_bucket: which allowance pays for the turn ('intro' | 'monthly' | 'pack' |
--           'daily'), chosen by lib/billing/quota.ts before the model call and
--           re-checked here atomically.
-- p_turn:   { player_input, narration, choices, proposed_changes,
--             applied_changes, rejected_changes, scene_tag, model }
-- p_calls:  usage ledger rows for every model call this turn (incl. retries)
-- ---------------------------------------------------------------------------
create function public.commit_turn(
  p_campaign_id       uuid,
  p_user_id           uuid,
  p_expected_version  int,
  p_bucket            text,
  p_intro_limit       int,
  p_daily_limit       int,
  p_state             jsonb,
  p_status            text,
  p_turn              jsonb,
  p_calls             jsonb
)
returns table (turn_id uuid, turn_number int)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_turn_number int;
  v_turn_id     uuid;
begin
  -- 1. Optimistic lock: only commit on top of the version this turn loaded.
  update public.campaigns
     set state = p_state,
         status = p_status,
         turn_count = turn_count + 1,
         version = version + 1,
         turn_locked_until = null
   where id = p_campaign_id
     and user_id = p_user_id
     and version = p_expected_version
     and status = 'active'
  returning turn_count into v_turn_number;

  if not found then
    raise exception 'version_conflict';
  end if;

  -- 2. Charge the turn to its bucket. Each guard re-checks the allowance so two
  --    campaigns racing on the same balance can't overspend it.
  if p_bucket = 'intro' then
    update public.turn_balances
       set intro_turns_used = intro_turns_used + 1
     where user_id = p_user_id and intro_turns_used < p_intro_limit;
  elsif p_bucket = 'monthly' then
    update public.turn_balances
       set monthly_used = monthly_used + 1
     where user_id = p_user_id and monthly_used < monthly_allowance;
  elsif p_bucket = 'pack' then
    update public.turn_balances
       set pack_credits = pack_credits - 1
     where user_id = p_user_id and pack_credits > 0;
  elsif p_bucket = 'daily' then
    update public.turn_balances
       set daily_free_used = case when daily_reset_on < current_date then 1 else daily_free_used + 1 end,
           daily_reset_on = current_date
     where user_id = p_user_id
       and (daily_reset_on < current_date or daily_free_used < p_daily_limit);
  else
    raise exception 'unknown bucket %', p_bucket;
  end if;

  if not found then
    raise exception 'out_of_turns';
  end if;

  -- 3. The turn itself.
  insert into public.turns (
    campaign_id, turn_number, player_input, narration, choices,
    proposed_changes, applied_changes, rejected_changes, scene_tag, model
  ) values (
    p_campaign_id, v_turn_number,
    p_turn->>'player_input', p_turn->>'narration', p_turn->'choices',
    p_turn->'proposed_changes', p_turn->'applied_changes', p_turn->'rejected_changes',
    p_turn->>'scene_tag', p_turn->>'model'
  )
  returning id into v_turn_id;

  -- 4. Usage ledger, one row per model call.
  insert into public.usage_ledger (
    user_id, campaign_id, turn_id, call_type, model, input_tokens,
    cache_read_tokens, cache_write_tokens, output_tokens, cost_usd, latency_ms, stop_reason
  )
  select p_user_id, p_campaign_id, v_turn_id, c.call_type, c.model, c.input_tokens,
         c.cache_read_tokens, c.cache_write_tokens, c.output_tokens, c.cost_usd, c.latency_ms, c.stop_reason
    from jsonb_to_recordset(p_calls) as c(
      call_type text, model text, input_tokens int, cache_read_tokens int,
      cache_write_tokens int, output_tokens int, cost_usd numeric, latency_ms int, stop_reason text
    );

  return query select v_turn_id, v_turn_number;
end;
$$;

-- Functions are executable by PUBLIC by default. These must be server-only.
revoke execute on function public.lock_campaign_turn(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.unlock_campaign_turn(uuid) from public, anon, authenticated;
revoke execute on function public.commit_turn(uuid, uuid, int, text, int, int, jsonb, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.lock_campaign_turn(uuid, uuid) to service_role;
grant execute on function public.unlock_campaign_turn(uuid) to service_role;
grant execute on function public.commit_turn(uuid, uuid, int, text, int, int, jsonb, text, jsonb, jsonb) to service_role;
