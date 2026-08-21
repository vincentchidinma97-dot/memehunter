import { NextResponse } from "next/server";
import { admin } from "@/lib/db";
import { markToMarket } from "@/lib/paper";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Lightweight, high-frequency job: re-price ONLY open positions against live
// DexScreener data and fire the stop/TP ladder. No discovery/scoring/forensics,
// so it's cheap enough to run every minute for fast stop-loss reaction.
export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const marked = await markToMarket(admin());
  return NextResponse.json({ ladder: marked.actions, at: new Date().toISOString() });
}
