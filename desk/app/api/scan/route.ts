import { NextResponse } from "next/server";
import { admin } from "@/lib/db";
import { runScan, safetyReport } from "@/lib/scan";
import { fetchSentiment } from "@/lib/sentiment";
import { markToMarket, getConfig, openPosition } from "@/lib/paper";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Vercel cron hits this every 30 min (see vercel.json). Also runnable manually.
// Protected by CRON_SECRET so randoms can't trigger scans.
export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = admin();
  const cfg = await getConfig(db);

  // 1. scan + score
  const candidates = await runScan("solana", 20_000);

  // 2. forensics + sentiment on the top scorers (both slow/metered; cap the calls)
  const TOP = 8;
  const top = candidates.slice(0, TOP);
  const [forensics, sentiments] = await Promise.all([
    Promise.all(top.map((c) => safetyReport(c.address).catch(() => null))),
    Promise.all(top.map((c) => fetchSentiment(c.symbol, c.address, c.ageHours, c.ch1).catch(() => null))),
  ]);

  // 3. fold sentiment sub-score into final score, then upsert
  const now = new Date().toISOString();
  const rows = candidates.map((c, i) => {
    const f = i < TOP ? forensics[i] : null;
    const s = i < TOP ? sentiments[i] : null;
    const sentPts = s?.score ?? 0;
    const breakdown = { ...c.breakdown, sentiment: sentPts };
    const finalScore = Math.round((c.breakdown.total + sentPts) * 10) / 10;
    return {
      address: c.address, chain: c.chain, symbol: c.symbol, name: c.name,
      score: finalScore, breakdown,
      verdict: f?.verdict ?? "UNKNOWN", forensics: f ?? null,
      sentiment: s ?? null,
      mcap: c.mcap, liquidity: c.liquidity, vol24: c.vol24, price: c.price,
      ch1: c.ch1, ch6: c.ch6, ch24: c.ch24,
      age_hours: c.ageHours, dex_url: c.dexUrl, last_scan_at: now,
    };
  });
  await db.from("candidates").upsert(rows, { onConflict: "address" });

  // 4. optional auto paper-buy of fresh PASS candidates above threshold
  const opened: string[] = [];
  if (cfg.auto_paper_buy) {
    for (let i = 0; i < TOP; i++) {
      const f = forensics[i];
      const finalScore = top[i].breakdown.total + (sentiments[i]?.score ?? 0);
      if (f?.verdict === "PASS" && finalScore >= cfg.min_score) {
        // skip if already holding this token
        const { data: existing } = await db.from("positions")
          .select("id").eq("address", top[i].address).in("status", ["open", "half"]).maybeSingle();
        if (!existing) {
          const r = await openPosition(db, top[i].address);
          if (r.ok) opened.push(top[i].symbol);
        }
      }
    }
  }

  // 5. resolve open paper positions against fresh prices
  const marked = await markToMarket(db);

  return NextResponse.json({
    scanned: candidates.length, forensics: top.length,
    autoBought: opened, ladder: marked.actions, at: now,
  });
}
