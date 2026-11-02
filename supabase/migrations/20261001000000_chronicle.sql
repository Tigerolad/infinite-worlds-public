-- Week 6: chronicle summaries (architecture doc §6).
-- chronicle_summary covers turns 1..chronicle_through. Turns after that are
-- sent to the narrator verbatim until the next summary refresh folds them in.

alter table public.campaigns
  add column if not exists chronicle_through int not null default 0
  check (chronicle_through >= 0);
