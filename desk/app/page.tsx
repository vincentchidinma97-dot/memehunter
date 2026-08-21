import type { ReactNode } from "react";
import { admin } from "@/lib/db";
import { BuyButton } from "./buy-button";
import { LiveClock } from "./live-clock";
import { usd, Avatar, Gauge, Spark, Meter, Ch, Equity, Divergence, ConsensusChip } from "@/lib/ui";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const verdictClass: Record<string, string> = { PASS: "v-pass", CAUTION: "v-caution", VETO: "v-veto", UNKNOWN: "v-unknown" };
const verdictIcon: Record<string, ReactNode> = {
  PASS: <path d="M7 1 L12 3 V7 C12 10 7 13 7 13 C7 13 2 10 2 7 V3 Z M5 7 l1.5 1.5 L9.5 5.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />,
  CAUTION: <path d="M7 1.5 L13 12 H1 Z M7 5.5 V8.5 M7 10.3 V10.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" />,
  VETO: <><circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M3.2 3.2 L10.8 10.8" stroke="currentColor" strokeWidth="1.3" /></>,
  UNKNOWN: <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.3" />,
};

export default async function Dashboard() {
  const db = admin();
  const [{ data: cands }, { data: positions }, { data: closed }, { data: cfg }] = await Promise.all([
    db.from("candidates").select("*").order("score", { ascending: false }).limit(15),
    db.from("positions").select("*").in("status", ["open", "half"]).order("opened_at", { ascending: false }),
    db.from("positions").select("*").eq("status", "closed").order("closed_at", { ascending: false }).limit(12),
    db.from("desk_config").select("*").eq("id", 1).single(),
  ]);

  const { data: sells } = await db.from("trades").select("pnl, r_multiple").eq("action", "sell");
  const realized = (sells ?? []).reduce((s, t) => s + (t.pnl ?? 0), 0);
  const wins = (sells ?? []).filter((t) => (t.pnl ?? 0) > 0).length;
  const avgR = sells?.length ? sells.reduce((s, t) => s + (t.r_multiple ?? 0), 0) / sells.length : 0;
  const bank = cfg?.starting_bank ?? 10000;
  const minScore = cfg?.min_score ?? 75;
  const openRisk = (positions ?? []).reduce((s, p) => s + p.size_usd * (p.remaining_pct / 100), 0);
  const closedPnls = (closed ?? []).map((p) => p.realized_pnl).reverse();
  // live market ticker built from the scanned candidates' 24h moves
  const ticker = (cands ?? []).slice(0, 12).map((c) => ({ sym: c.symbol as string, ch: (c.ch24 ?? 0) as number }));

  return (
    <>
      <div className="ticker">
        <div className="ticker-track mono">
          {[...ticker, ...ticker].map((t, i) => (
            <span className="tk" key={i}><b>{t.sym}</b><span className={t.ch >= 0 ? "up" : "dn"}>{t.ch >= 0 ? "+" : ""}{Math.round(t.ch)}%</span></span>
          ))}
        </div>
      </div>
      <main>
      <header className="top">
        <div className="brand">
          <svg className="mark" width="38" height="38" viewBox="0 0 40 40" fill="none" aria-hidden="true">
            <path d="M20 2 L35 11 V29 L20 38 L5 29 V11 Z" stroke="#2c3448" strokeWidth="1.5" fill="#141a26" />
            <circle cx="20" cy="20" r="10" stroke="var(--gold)" strokeWidth="1.6" fill="none" opacity="0.5" />
            <circle cx="20" cy="20" r="5.5" stroke="var(--gold)" strokeWidth="1.6" fill="none" />
            <circle cx="20" cy="20" r="1.8" fill="var(--gold)" />
          </svg>
          <div>
            <h1>Meme Hunter <span className="gold">paper desk</span></h1>
            <p className="sub">solana · scan every 30 min · simulated fills · not financial advice</p>
          </div>
        </div>
        <div className="headright">
          <LiveClock />
          <span className="live"><span className="dot" />LIVE</span>
        </div>
      </header>

      <section className="hero">
        <div className="hero-glow" />
        <Equity startBank={bank} closedPnls={closedPnls} hero />
        <div className="hero-inner">
          <div className="hcell big">
            <div className="stat-l">Paper P&amp;L</div>
            <div className={`stat-v ${realized >= 0 ? "good" : "bad"}`}>{realized >= 0 ? "+" : ""}{usd(realized)}</div>
            <div className="stat-s">on {usd(bank)} bank · net of fees + slippage</div>
          </div>
          <div className="hcell">
            <div className="stat-l">Win rate</div>
            <div className="stat-v mid">{sells?.length ? `${Math.round((wins / sells.length) * 100)}%` : "—"}</div>
            <div className="stat-s">{wins} of {sells?.length ?? 0} sells</div>
          </div>
          <div className="hcell">
            <div className="stat-l">Expectancy</div>
            <div className={`stat-v mid ${avgR >= 0 ? "good" : "bad"}`}>{avgR >= 0 ? "+" : ""}{avgR.toFixed(2)}R</div>
            <div className="stat-s">per fill · the edge</div>
          </div>
          <div className="hcell">
            <div className="stat-l">Open risk</div>
            <div className="stat-v mid">{positions?.length ?? 0}</div>
            <div className="stat-s">{usd(openRisk)} · {((openRisk / bank) * 100).toFixed(1)}% of bank</div>
          </div>
        </div>
      </section>

      <div className="shead"><h2><span className="bar" />Candidate feed</h2><span className="hint">score · forensics · sentiment · sorted by score</span></div>
      <div className="feed">
        {(cands ?? []).map((c) => {
          const blocked = c.verdict === "VETO" || c.score < minScore;
          const age = c.age_hours < 48 ? `${Math.round(c.age_hours)}h` : `${Math.round(c.age_hours / 24)}d`;
          const flag = (c.forensics?.flags ?? [])[0];
          const hot = c.sentiment?.divergence === "SOCIAL_LEADING" && !blocked;
          const sent = c.sentiment?.score;
          const sentCol = sent == null ? "var(--muted)" : sent >= 15 ? "var(--mint)" : sent >= 8 ? "var(--amber)" : "var(--muted)";
          return (
            <div className={`row ${blocked ? "blocked" : ""} ${hot ? "hot" : ""}`} key={c.address}>
              <Avatar symbol={c.symbol} />
              <Gauge score={c.score} />
              <div className="sym"><span className="n">{c.symbol}</span><span className="meta">{usd(c.mcap)} · {age} old</span></div>
              <div className="spark-cell">
                <Spark price={c.price} ch1={c.ch1 ?? 0} ch6={c.ch6 ?? 0} ch24={c.ch24 ?? 0} />
                <div className="mom"><Ch v={c.ch1 ?? 0} /><Ch v={c.ch6 ?? 0} /><Ch v={c.ch24 ?? 0} /></div>
                <Divergence s={c.sentiment} />
              </div>
              <div className="foren">
                <span className={`verdict ${verdictClass[c.verdict] ?? "v-unknown"}`}>
                  <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">{verdictIcon[c.verdict] ?? verdictIcon.UNKNOWN}</svg>
                  {c.verdict}
                </span>
                {c.forensics?.top10_pct != null && <div className="frow"><span className="lab">top10</span><Meter pct={c.forensics.top10_pct} kind="conc" /><span>{c.forensics.top10_pct}%</span></div>}
                {c.forensics?.lp_locked_pct != null && <div className="frow"><span className="lab">LP</span><Meter pct={c.forensics.lp_locked_pct} kind="lp" /><span>{c.forensics.lp_locked_pct}%</span></div>}
              </div>
              <div className="sidecol">
                {flag ? <><span className="warn">⚠ {flag}</span><br /></> : <>ins {c.forensics?.insider_pct ?? 0}%<br /></>}
                <ConsensusChip c={c.consensus} />
                <span className="sent-pill" style={{ color: sentCol, background: sent != null && sent >= 8 ? "rgba(79,208,138,.1)" : "#0c1017" }}>sent {sent != null ? `+${sent}/25` : "—"}</span>
                {(c.sentiment?.influencers?.length ?? 0) > 0 && (
                  <span className="infl" title={c.sentiment.influencers.map((i: any) => `@${i.username} (${Math.round(i.followers / 1000)}k)`).join(", ")}>
                    <i>★</i> {c.sentiment.influencers.length} KOL
                  </span>
                )}
              </div>
              <BuyButton address={c.address} symbol={c.symbol} blocked={blocked} />
            </div>
          );
        })}
        {!cands?.length && <p className="empty">No candidates yet. Trigger a scan: <code>GET /api/scan</code></p>}
      </div>

      <div className="cols">
        <div>
          <div className="shead"><h2><span className="bar" />Open positions</h2><span className="hint">flip ladder live</span></div>
          {(positions ?? []).map((p) => {
            const cur = p.current_mcap ?? p.peak_mcap ?? p.entry_mcap;
            // unrealized PnL net of fees + slippage (as if exiting now, normal not stop)
            const cost = (cfg?.fee_pct ?? 0.01) + (cfg?.slippage_pct ?? 0.015);
            const pnl = p.size_usd * ((cur / p.entry_mcap) * (1 - cost) / (1 + cost) - 1);
            const gain = (cur / p.entry_mcap - 1) * 100;
            const posPct = (m: number) => Math.min(100, ((m / p.entry_mcap) / 4) * 100);
            const nowPct = posPct(cur);
            return (
              <div className="pos" key={p.id}>
                <div className="posh"><span className="left"><Avatar symbol={p.symbol} /><span className="n">{p.symbol}{p.status === "half" && <em>half sold</em>}</span></span>
                  <span className={`pnl ${pnl >= 0 ? "good" : "bad"}`}>{pnl >= 0 ? "+" : ""}{usd(pnl)}</span></div>
                <div className="posmeta">in {usd(p.size_usd)} @ {usd(p.entry_mcap)} · now {usd(cur)} ({gain >= 0 ? "+" : ""}{gain.toFixed(0)}%)</div>
                <div className="ladder">
                  <div className="track"><div className="fill" style={{ width: `${nowPct}%` }} /></div>
                  <div className={`tick ${cur >= p.tp1_mcap ? "hit" : ""}`} style={{ left: `${posPct(p.tp1_mcap)}%` }}><div className="m" /><div className="lbl">2x</div></div>
                  <div className={`tick ${cur >= p.tp2_mcap ? "hit" : ""}`} style={{ left: `${posPct(p.tp2_mcap)}%` }}><div className="m" /><div className="lbl">4x</div></div>
                  <div className="now" style={{ left: `${nowPct}%` }} />
                </div>
                <div className="posmeta">next: {p.status === "open" ? `sell 50% at 2x ${usd(p.tp1_mcap)}` : `sell 25% at 4x ${usd(p.tp2_mcap)}`} · stop {usd(p.stop_mcap)}</div>
              </div>
            );
          })}
          {!positions?.length && <p className="empty">No open positions. Paper-buy a PASS candidate.</p>}
        </div>
        <div>
          <div className="shead"><h2><span className="bar" />Closed flips</h2><span className="hint">R = risk multiple</span></div>
          {(closed ?? []).map((p) => {
            const r = p.realized_pnl / (p.size_usd * (1 - (cfg?.stop_mult ?? 0.5)));
            return (
              <div className="closed" key={p.id}>
                <div className="left"><Avatar symbol={p.symbol} /><div><span className="s">{p.symbol}</span><small>{(p.close_reason ?? "").toUpperCase()} · {usd(p.entry_mcap)} → {usd(p.peak_mcap)}</small></div></div>
                <div className="right">
                  <span className={`amt ${p.realized_pnl >= 0 ? "good" : "bad"}`}>{p.realized_pnl >= 0 ? "+" : ""}{usd(p.realized_pnl)}</span>
                  <span className={`rbadge ${r >= 0 ? "good" : "bad"}`} style={{ background: r >= 0 ? "var(--mint-glow)" : "var(--coral-glow)" }}>{r >= 0 ? "+" : ""}{r.toFixed(1)}R</span>
                </div>
              </div>
            );
          })}
          {!closed?.length && <p className="empty">No closed flips yet.</p>}
        </div>
      </div>
    </main>
    </>
  );
}
