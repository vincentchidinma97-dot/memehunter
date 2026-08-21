-- Meme Hunter paper desk — schema
-- Apply via Supabase MCP apply_migration or the SQL editor.

-- One row per token the scanner has ever seen; refreshed each scan.
create table if not exists candidates (
  address        text primary key,
  chain          text not null default 'solana',
  symbol         text,
  name           text,
  score          numeric not null default 0,
  breakdown      jsonb,                      -- {liquidity, volume, momentum, age, traction, sentiment}
  verdict        text,                       -- PASS | CAUTION | VETO | UNKNOWN
  forensics      jsonb,                      -- top10_pct, insider_pct, lp_locked_pct, flags[]
  sentiment      jsonb,                      -- {source, score, divergence, velocity, authorRatio, positivePct, manipulated}
  mcap           numeric,
  liquidity      numeric,
  vol24          numeric,
  price          numeric,                    -- USD, for mark-to-market
  ch1            numeric,                    -- % price change 1h / 6h / 24h
  ch6            numeric,
  ch24           numeric,
  age_hours      numeric,
  dex_url        text,
  first_seen_at  timestamptz not null default now(),
  last_scan_at   timestamptz not null default now()
);
create index if not exists candidates_score_idx on candidates (score desc);
create index if not exists candidates_scan_idx  on candidates (last_scan_at desc);

-- Simulated positions. entry_* frozen at buy; the rest updated by the mark job.
create table if not exists positions (
  id             uuid primary key default gen_random_uuid(),
  address        text not null references candidates(address),
  symbol         text,
  status         text not null default 'open',   -- open | half | closed
  size_usd       numeric not null,               -- notional risked at entry
  remaining_pct  numeric not null default 100,   -- % of original still held
  entry_mcap     numeric not null,
  entry_price    numeric not null,
  entry_score    numeric,
  entry_verdict  text,
  -- flip ladder targets, frozen at entry
  tp1_mcap       numeric not null,               -- 2x  -> sell 50%
  tp2_mcap       numeric not null,               -- 4x  -> sell 25%
  stop_mcap      numeric not null,               -- -50% -> exit remainder
  realized_pnl   numeric not null default 0,
  peak_mcap      numeric,
  current_mcap   numeric,                        -- live mcap from last mark-to-market
  current_price  numeric,
  opened_at      timestamptz not null default now(),
  closed_at      timestamptz,
  close_reason   text                            -- tp1|tp2|stop|manual|stale
);
create index if not exists positions_status_idx on positions (status);

-- Immutable log of every fill (partial or full). Stats derive from this.
create table if not exists trades (
  id            uuid primary key default gen_random_uuid(),
  position_id   uuid not null references positions(id),
  symbol        text,
  action        text not null,      -- buy | sell
  reason        text,               -- entry | tp1 | tp2 | stop | stale | manual
  pct_of_orig   numeric,            -- portion of original position this fill covers
  mcap          numeric,
  price         numeric,
  pnl           numeric,            -- realized on this fill (sells only)
  r_multiple    numeric,            -- pnl / initial risk, for expectancy
  created_at    timestamptz not null default now()
);
create index if not exists trades_created_idx on trades (created_at desc);

-- Single-row desk config so the model's rules live in the DB, tunable without redeploy.
create table if not exists desk_config (
  id             int primary key default 1,
  starting_bank  numeric not null default 10000,
  risk_per_trade numeric not null default 0.005,  -- 0.5% of bank
  min_score      numeric not null default 75,
  block_veto     boolean not null default true,
  auto_paper_buy boolean not null default true,   -- if true, cron opens positions on PASS >= min_score
  max_open_positions int not null default 20,     -- cap concurrent autonomous positions
  tp1_mult       numeric not null default 2.0,
  tp1_sell_pct   numeric not null default 50,
  tp2_mult       numeric not null default 4.0,
  tp2_sell_pct   numeric not null default 25,
  stop_mult      numeric not null default 0.5,
  stale_hours    numeric not null default 8,
  constraint single_row check (id = 1)
);
insert into desk_config (id) values (1) on conflict (id) do nothing;

-- Convenience view: current desk performance.
create or replace view desk_stats as
select
  (select starting_bank from desk_config where id = 1)                             as starting_bank,
  coalesce(sum(pnl), 0)                                                            as realized_pnl,
  count(*) filter (where action = 'sell' and reason = 'entry')                     as ignore_me,
  count(distinct position_id) filter (where action = 'sell')                       as closed_flips,
  count(*) filter (where action = 'sell' and pnl > 0)                              as winning_fills,
  count(*) filter (where action = 'sell')                                          as total_sell_fills,
  coalesce(avg(r_multiple) filter (where action = 'sell'), 0)                      as avg_r
from trades;
