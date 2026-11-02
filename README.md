# Infinite Worlds — Phase 1

AI-narrated interactive fiction. Flagship world: *The Sundered Crown*.
Design: [`phase1_system_architecture.md`](phase1_system_architecture.md)

## Setup

1. **Install dependencies**
   ```bash
   npm install
   npm install @supabase/supabase-js @supabase/ssr zod server-only @anthropic-ai/sdk
   npm install -D vitest
   ```
2. **Create a Supabase project** (free tier) at supabase.com.
   - Run each file in `supabase/migrations/` in order in the SQL editor (or `npx supabase db push` if you use the CLI).
   - Authentication → URL Configuration: set Site URL to `http://localhost:3000` and add `http://localhost:3000/auth/callback` to Redirect URLs.
3. **Environment:** `cp .env.example .env.local` and fill in the keys.
4. **Run:** `npm run dev`, then open http://localhost:3000.

## Checks

```bash
npm test            # unit tests: world files, engine, narrator, quotas, art, golden set
npm run typecheck
npm run lint
```

## Golden turns (real API)

30 fixed scenarios in `evals/golden/sundered-crown.json` covering openings, secret-keeping,
movement and money rules, protected characters, prompt injection, IP bait and content limits.
Run them whenever the prompt, lore or model changes (~$0.30 on Sonnet):

```bash
npm run golden                    # Sonnet as configured
npm run golden -- --free          # Haiku
npm run golden -- --thinking      # Sonnet with adaptive thinking, to compare quality/latency/cost
npm run golden -- --only inject-gold,move-too-far
```

Each run prints pass/fail and writes a report to `evals/results/` with every narration for a
manual quality read.

## Visual novel art

The story screen is a visual novel: a background, up to two character sprites, and the narration in a
text box (click, Space, Enter or → to advance). Each turn the narrator picks the background, who is on
stage with which expression, and occasionally a full-screen CG. `worlds/sundered-crown/art.json` lists
30 backgrounds, 16 CGs and 8 characters × 4 expressions, in one painterly style made with Midjourney.

```bash
npm run art -- --prompts          # Midjourney prompts for missing images → art-inbox/sundered-crown/PROMPTS.md
npm run art -- --import           # convert images saved in art-inbox/sundered-crown/ into public/scenes/
npm run art                       # status; updates art_manifest.json (also runs before dev and build)
```

Save each download in `art-inbox/sundered-crown/` named after its target (`capital-market.png`,
`regent-osric-angry.png`). Remove sprite backgrounds first (Finder → Quick Actions → Remove Background).
Missing art degrades gracefully: default background, neutral expression, or a nameplate.

## Closed beta

**Invite codes.** While `BETA_INVITE_ONLY` isn't `false`, new players need a code at onboarding.

```bash
npm run invites                                       # list codes and how often each was used
npm run invites -- create 10                          # 10 single-use codes, each with its invite link
npm run invites -- create 1 --uses 25 --note discord --expires 2026-11-30
```

The invite link (`/onboarding?code=…`) signs the player in and fills the code in.

**Feedback.** Players can 👎 any turn, choosing a category and optionally adding a note. Flags land in `turn_feedback` and
show up in the daily report next to the narration.

**Analytics.** PostHog, sent from the server only, when `POSTHOG_KEY` is set. Events: `signed_in`, `onboarded`,
`story_started`, `turn_played` (model, cost, latency, rejected changes…), `turn_failed` (with the error code) and
`turn_flagged`. The distinct id is the Supabase user id; no email is sent. Use `turn_played` for retention.

**Daily cost checks.**
- `npm run costs` reports yesterday (UTC): spend against the cap and the budget, cost per turn, cache hit rate,
  latency, retries, failures, rejected changes and flagged turns. `-- --today` reports today so far.
- It exits with code 1 when something crosses a threshold (`lib/billing/report.ts`).
- `.github/workflows/daily-costs.yml` runs it every day at 07:00 UTC. A failed run means alerts, and GitHub emails you.
- **Kill switch:** once today's spend reaches `DAILY_SPEND_LIMIT_USD` (default $15), new turns pause until 00:00 UTC and
  nobody is charged a turn.

## Play in the terminal (real API, no database)

Needs `ANTHROPIC_API_KEY` in `.env.local`, and `npm install -D tsx` once.

```bash
npm run play                  # Sonnet 5.5 narrator (~1–2¢ per turn)
npm run play -- --free        # Haiku 4.5 narrator
```

Each turn prints the narration, choices, the state changes the engine applied (+) or rejected (✗), and tokens/cost.

## Layout

```
app/                 Next.js routes: /login, /auth/callback, /onboarding (18+ gate, invite code), /play, /play/[id], /api/turn
lib/supabase/        Browser, server, admin (service-role) clients + session proxy
lib/worlds/          World file schemas (zod) and loader with cross-file validation
lib/engine/          State engine: change ops, per-turn caps, validation (§7.3)
lib/narrator/        Model config/pricing, prompt + context builder, output schema, IP filter, narrate()
lib/turn/run.ts      Turn orchestrator: lock, quota, narrate, engine, commit (§4)
lib/turn/chronicle.ts  Background chronicle refresh after a turn (Haiku)
lib/evals/           Golden-turn scenario format and checks
lib/billing/         Turn allowances (intro → monthly → packs → free daily), daily spend cap, daily report checks
lib/beta/            Invite-only access check and code format
lib/feedback/        👎 categories
lib/analytics.ts     Server-side PostHog events
lib/art/             Visual-novel staging: checks the narrator's stage, resolves images with fallbacks
scripts/play.ts      Terminal play loop for testing the narrator
scripts/golden.ts    Golden-turn runner
scripts/art.ts       Art status, Midjourney prompts, image import
scripts/invites.ts   Create and list invite codes
scripts/costs.ts     Daily cost report and alerts
.github/workflows/   Scheduled daily cost check
evals/golden/        Golden-turn scenarios
worlds/<id>/         World content: lore, cast, locations, origins, scene tags, banned terms
supabase/migrations/ Schema + row-level security
tests/               Vitest suites
proxy.ts             Refreshes auth session; guards /play and /onboarding
```

Status: weeks 1–8 of the build plan (§16), plus the visual-novel presentation. Beta tooling is in; next is running
the closed beta, then payments (weeks 9–10).
