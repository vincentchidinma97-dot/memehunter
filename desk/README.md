# Meme Hunter — paper desk

A hosted dashboard that scans Solana meme launches, scores them (0–100), runs
RugCheck forensics, and **paper-trades** the flip model against live prices — so
you can measure win rate and expectancy before risking real money.

Simulated fills only. Nothing here places real orders or touches a wallet.
Not financial advice.

## Architecture

```
Vercel cron (every 30 min)  →  scans DexScreener + RugCheck, scores, upserts
        │                       auto-resolves open paper positions vs live price
        ▼
Supabase Postgres           →  candidates · positions · trades · desk_config
        ▼
Next.js dashboard (Vercel)  →  feed, open positions, closed flips, stats
```

The flip ladder is enforced automatically on every scan:
sell 50% at 2x → sell 25% at 4x → hard stop at −50% → stale exit after N hours.
VETO tokens (mint authority on, top-10 > 50%, etc.) cannot be bought.

## Scoring model (100 pts)

On-chain factors (75) are computed synchronously in `lib/scan.ts`:
liquidity 20 · volume 20 · momentum 15 · age 10 · traction 10.
The sentiment sub-score (25) is fetched per top-scorer in the cron (`lib/sentiment.ts`).

### Sentiment layer — two tiers

Memes run on social heat, so 25 of the 100 points come from it:

- **Tier 1 (fresh < 24h): direct X/Twitter search** on ticker + contract address.
  Scores mention *velocity* (not raw volume), unique-author diversity, polarity,
  and credible reach. Needs `X_BEARER_TOKEN` (pay-per-use in 2026).
- **Tier 2 (graduated): LunarCrush aggregate** (X + Reddit + YouTube + TikTok),
  using Galaxy Score + sentiment %. Needs `LUNARCRUSH_API_KEY` (monthly).

Both are **optional** — with no keys set, the desk runs on the 75-pt on-chain
score alone and the sentiment sub-score is 0.

**Anti-shill gate:** a spike from low-follower accounts, copy-paste text, or poor
author diversity discounts the sub-score ×0.3 — paid pumps don't get rewarded.

**Divergence signal** (the real edge), shown as a badge on each candidate:
- `social leading` — social velocity rising while price is flat = early, the entry.
- `price leading` — price already up while social is flat = late, chase risk.

## Live deployment (2026-08-21)

- App: https://meme-hunter-desk.vercel.app (Vercel project `meme-hunter-desk`)
- Supabase project: `meme-hunter-desk` (ref `guxlmcerrdbdiaznynae`), isolated from vincent-platform.
- Scheduler: **Supabase pg_cron** job `meme-hunter-scan`, every 30 min, calls
  `/api/scan` with the `CRON_SECRET` bearer. (Vercel Hobby caps crons at daily,
  so `vercel.json` no longer defines one — pg_cron drives the loop instead.)
- RLS is enabled on all tables with no policies: only the server's service_role
  key can read/write. The dashboard and cron both run server-side.

Remaining one-time step: set `SUPABASE_SERVICE_ROLE_KEY` in Vercel (the MCP can't
read the secret). See "Finish the deploy" below.

## Deploy (needs Supabase + Vercel connected)

Do this from an interactive `claude` session with the Supabase and Vercel
connectors authorized (claude.ai connector settings, or `/mcp`).

1. **Create the Supabase project**, then apply `supabase/schema.sql`
   (MCP `apply_migration`, or paste into the SQL editor).
2. **Set env vars** (see `.env.example`): `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`. Add the same three in Vercel.
3. **Deploy to Vercel.** `vercel.json` registers the 30-min cron on `/api/scan`.
   Vercel automatically sends `Authorization: Bearer $CRON_SECRET` to cron routes.
4. **Seed the first scan** manually:
   `curl -H "Authorization: Bearer $CRON_SECRET" https://YOUR-APP.vercel.app/api/scan`
5. Open the app. `auto_paper_buy` defaults to **true**, so the cron opens paper
   positions on every PASS candidate above `min_score` on its own — hands-off.
   Set it to `false` in `desk_config` if you'd rather open positions manually via
   the **Paper buy** button.

## Tuning the model

Everything lives in the `desk_config` row — edit it in Supabase, no redeploy:
`min_score`, `risk_per_trade`, `tp1_mult` / `tp1_sell_pct`, `tp2_*`, `stop_mult`,
`stale_hours`, `auto_paper_buy`, `block_veto`.

## Local dev

```bash
cd desk && npm install
cp .env.example .env.local   # fill in Supabase creds
npm run dev
```

The scoring/forensics logic is a TypeScript port of the standalone
`../meme_hunter.py` screener and stays in sync with it.
