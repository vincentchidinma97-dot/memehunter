// Paper-trading engine: open simulated positions and resolve them against
// live market cap using the frozen flip ladder. No real orders anywhere.
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchPrices } from "./scan";

type Config = {
  starting_bank: number; risk_per_trade: number; min_score: number; block_veto: boolean;
  auto_paper_buy: boolean; tp1_mult: number; tp1_sell_pct: number; tp2_mult: number;
  tp2_sell_pct: number; stop_mult: number; stale_hours: number; max_open_positions: number;
  consensus_min: number; fee_pct: number; slippage_pct: number; stop_slippage_pct: number;
};

export async function getConfig(db: SupabaseClient): Promise<Config> {
  const { data } = await db.from("desk_config").select("*").eq("id", 1).single();
  return data as Config;
}

// Open a paper position from a candidate row. Rejects VETO and sub-threshold.
export async function openPosition(
  db: SupabaseClient, address: string, sizeUsd?: number
): Promise<{ ok: boolean; reason?: string; id?: string }> {
  const cfg = await getConfig(db);
  const { data: c } = await db.from("candidates").select("*").eq("address", address).single();
  if (!c) return { ok: false, reason: "candidate not found" };
  if (cfg.block_veto && c.verdict === "VETO") return { ok: false, reason: "blocked: VETO forensics" };
  if (c.score < cfg.min_score) return { ok: false, reason: `score ${c.score} below min ${cfg.min_score}` };
  if (!c.price || !c.mcap) return { ok: false, reason: "no live price" };

  const size = sizeUsd ?? cfg.starting_bank * cfg.risk_per_trade;
  const { data: pos, error } = await db.from("positions").insert({
    address: c.address, symbol: c.symbol, size_usd: size,
    entry_mcap: c.mcap, entry_price: c.price, entry_score: c.score, entry_verdict: c.verdict,
    tp1_mcap: c.mcap * cfg.tp1_mult, tp2_mcap: c.mcap * cfg.tp2_mult, stop_mcap: c.mcap * cfg.stop_mult,
    peak_mcap: c.mcap, current_mcap: c.mcap, current_price: c.price,
  }).select("id").single();
  if (error) return { ok: false, reason: error.message };

  await db.from("trades").insert({
    position_id: pos!.id, symbol: c.symbol, action: "buy", reason: "entry",
    pct_of_orig: 100, mcap: c.mcap, price: c.price, pnl: 0, r_multiple: 0,
  });
  return { ok: true, id: pos!.id };
}

// Re-price every open position against LIVE DexScreener data (not the scan
// feed, which may not include a held token) and fire the flip ladder.
export async function markToMarket(db: SupabaseClient): Promise<{ actions: string[] }> {
  const cfg = await getConfig(db);
  const actions: string[] = [];
  const { data: open } = await db.from("positions").select("*").in("status", ["open", "half"]);
  if (!open?.length) return { actions };

  // Price all held tokens directly from DexScreener in one batched call.
  const live = await fetchPrices("solana", [...new Set(open.map((p) => p.address))]);

  for (const p of open) {
    const l = live[p.address];
    // Fall back to the last-known current price if DexScreener has no pair now.
    const mcap = l?.mcap || p.current_mcap || p.entry_mcap;
    const price = l?.price ?? p.current_price ?? p.entry_price;
    const peak = Math.max(p.peak_mcap ?? p.entry_mcap, mcap);
    // Always persist the live current price so the dashboard shows the truth.
    await db.from("positions").update({ current_mcap: mcap, current_price: price, peak_mcap: peak }).eq("id", p.id);

    // initial risk = size * (1 - stop_mult); used to normalize R.
    const risk = p.size_usd * (1 - cfg.stop_mult);
    // Cost-aware realized gain: you pay fee+slippage buying (cost basis is
    // inflated) and again selling (proceeds are shaved); stops slip extra.
    const entryCost = cfg.fee_pct + cfg.slippage_pct;
    const exitCost = (reason: string) =>
      cfg.fee_pct + cfg.slippage_pct + (reason === "stop" ? cfg.stop_slippage_pct : 0);
    const gain = (m: number, reason: string) =>
      (m / p.entry_mcap) * (1 - exitCost(reason)) / (1 + entryCost) - 1;

    // stop first (protect capital)
    if (mcap <= p.stop_mcap) {
      const pnl = p.size_usd * (p.remaining_pct / 100) * gain(mcap, "stop");
      await sell(db, p, p.remaining_pct, "stop", mcap, price, pnl, pnl / risk);
      await db.from("positions").update({ status: "closed", remaining_pct: 0, closed_at: new Date().toISOString(), close_reason: "stop" }).eq("id", p.id);
      actions.push(`${p.symbol}: STOP hit, closed`);
      continue;
    }
    // tp2 (only after tp1 already taken)
    if (p.status === "half" && mcap >= p.tp2_mcap) {
      const pnl = p.size_usd * (cfg.tp2_sell_pct / 100) * gain(mcap, "tp2");
      const remain = p.remaining_pct - cfg.tp2_sell_pct;
      await sell(db, p, cfg.tp2_sell_pct, "tp2", mcap, price, pnl, pnl / risk);
      await db.from("positions").update({ remaining_pct: remain }).eq("id", p.id);
      actions.push(`${p.symbol}: TP2 (4x), sold ${cfg.tp2_sell_pct}%`);
      continue;
    }
    // tp1
    if (p.status === "open" && mcap >= p.tp1_mcap) {
      const pnl = p.size_usd * (cfg.tp1_sell_pct / 100) * gain(mcap, "tp1");
      await sell(db, p, cfg.tp1_sell_pct, "tp1", mcap, price, pnl, pnl / risk);
      await db.from("positions").update({ status: "half", remaining_pct: p.remaining_pct - cfg.tp1_sell_pct }).eq("id", p.id);
      actions.push(`${p.symbol}: TP1 (2x), sold ${cfg.tp1_sell_pct}% — principal recovered`);
      continue;
    }
    // stale exit (flip, don't hold)
    const ageH = (Date.now() - new Date(p.opened_at).getTime()) / 3.6e6;
    if (ageH >= cfg.stale_hours) {
      const pnl = p.size_usd * (p.remaining_pct / 100) * gain(mcap, "stale");
      await sell(db, p, p.remaining_pct, "stale", mcap, price, pnl, pnl / risk);
      await db.from("positions").update({ status: "closed", remaining_pct: 0, closed_at: new Date().toISOString(), close_reason: "stale" }).eq("id", p.id);
      actions.push(`${p.symbol}: stale >${cfg.stale_hours}h, flipped out`);
    }
  }
  return { actions };
}

async function sell(
  db: SupabaseClient, p: any, pct: number, reason: string,
  mcap: number, price: number, pnl: number, r: number
) {
  await db.from("trades").insert({
    position_id: p.id, symbol: p.symbol, action: "sell", reason,
    pct_of_orig: pct, mcap, price, pnl: Math.round(pnl * 100) / 100, r_multiple: Math.round(r * 100) / 100,
  });
  await db.from("positions").update({ realized_pnl: (p.realized_pnl ?? 0) + pnl }).eq("id", p.id);
}
