// Meme Hunter scan engine — DexScreener discovery + scoring + RugCheck forensics.
// Pure functions + fetch; no DB imports so it runs in any runtime (Vercel cron, edge).

const DEX = "https://api.dexscreener.com";
const RUGCHECK = "https://api.rugcheck.xyz/v1";

export type Breakdown = {
  liquidity: number; volume: number; momentum: number; age: number; traction: number;
  sentiment: number; total: number;
};

export type Forensics = {
  verdict: "PASS" | "CAUTION" | "VETO" | "UNKNOWN";
  flags: string[];
  top10_pct?: number;
  insider_pct?: number;
  lp_locked_pct?: number;
  rugcheck_score?: number;
  creator?: string;
};

export type Candidate = {
  address: string; chain: string; symbol: string; name: string;
  score: number; breakdown: Breakdown;
  mcap: number; liquidity: number; vol24: number; price: number; ageHours: number;
  ch1: number; ch6: number; ch24: number;
  dexUrl: string;
};

async function getJSON(url: string): Promise<any> {
  const r = await fetch(url, { headers: { "User-Agent": "meme-hunter/1.0" } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

// ---- discovery ------------------------------------------------------------
export async function discover(chain: string): Promise<Set<string>> {
  const addrs = new Set<string>();
  const feeds = ["/token-boosts/latest/v1", "/token-boosts/top/v1", "/token-profiles/latest/v1"];
  for (const f of feeds) {
    try {
      const list = await getJSON(DEX + f);
      for (const t of list) if (t.chainId === chain && t.tokenAddress) addrs.add(t.tokenAddress);
    } catch (e) { console.warn("discover", f, String(e)); }
  }
  return addrs;
}

export async function fetchPairs(chain: string, addrs: string[]): Promise<any[]> {
  const best = new Map<string, any>();
  for (let i = 0; i < addrs.length; i += 30) {
    const chunk = addrs.slice(i, i + 30).join(",");
    try {
      const pairs = await getJSON(`${DEX}/tokens/v1/${chain}/${chunk}`);
      for (const p of pairs) {
        const a = p?.baseToken?.address;
        const liq = p?.liquidity?.usd ?? 0;
        if (a && liq > (best.get(a)?._liq ?? -1)) { p._liq = liq; best.set(a, p); }
      }
    } catch (e) { console.warn("fetchPairs", String(e)); }
    await new Promise((r) => setTimeout(r, 300));
  }
  return [...best.values()];
}

// Fetch live mcap+price for specific token addresses (used by mark-to-market
// so held positions are priced from DexScreener directly, not the scan feed).
export async function fetchPrices(
  chain: string, addrs: string[]
): Promise<Record<string, { mcap: number; price: number }>> {
  const out: Record<string, { mcap: number; price: number }> = {};
  if (!addrs.length) return out;
  const pairs = await fetchPairs(chain, addrs);
  for (const p of pairs) {
    const a = p.baseToken?.address;
    if (a) out[a] = { mcap: p.marketCap ?? p.fdv ?? 0, price: Number(p.priceUsd ?? 0) };
  }
  return out;
}

// ---- scoring: on-chain factors sum to 75; sentiment (25) added later ------
export function scorePair(p: any): Breakdown {
  const liq = p._liq ?? 0;
  const mcap = p.marketCap ?? p.fdv ?? 0;
  const vol24 = p.volume?.h24 ?? 0;
  const tx = p.txns ?? {};
  const sum = (k: string) => (tx.h1?.[k] ?? 0) + (tx.h6?.[k] ?? 0) + (tx.h24?.[k] ?? 0);
  const buys = sum("buys"), sells = sum("sells"), total = buys + sells;
  const ch = p.priceChange ?? {};
  const ch1 = ch.h1 ?? 0, ch6 = ch.h6 ?? 0, ch24 = ch.h24 ?? 0;
  const ageH = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 3.6e6 : null;

  // Liquidity — 20
  let liquidity = 0;
  if (liq >= 20_000) liquidity += 7;
  if (liq >= 100_000) liquidity += 3;
  if (mcap > 0) { const r = liq / mcap; if (r >= 0.10 && r <= 0.40) liquidity += 10; else if (r >= 0.05) liquidity += 5; }
  liquidity = Math.min(liquidity, 20);

  // Volume — 20
  let volume = 0;
  if (mcap > 0 && vol24 / mcap >= 0.30) volume += 10; else if (mcap > 0 && vol24 / mcap >= 0.10) volume += 5;
  if (total > 0) { const bal = buys / total; if (bal >= 0.45 && bal <= 0.70) volume += 10; else if (bal > 0.70) volume += 4; }
  volume = Math.min(volume, 20);

  // Momentum — 15
  let momentum = 0;
  if (ch1 > 0) momentum += 5;
  if (ch6 > 0) momentum += 4;
  if (ch24 > 0) momentum += 3;
  if (ch1 > 100) momentum -= 5;
  const h1tx = (tx.h1?.buys ?? 0) + (tx.h1?.sells ?? 0);
  if (h1tx >= 150) momentum += 3;
  momentum = Math.max(Math.min(momentum, 15), 0);

  // Age — 10
  let age = 0;
  if (ageH != null) { if (ageH >= 6 && ageH <= 336) age = 10; else if (ageH < 6) age = 3; else if (ageH <= 720) age = 5; else age = 2; }

  // Traction — 10 (basic social/site presence; real heat is the sentiment factor)
  let traction = 0;
  const info = p.info ?? {};
  if (info.socials?.length) traction += 4;
  if (info.websites?.length) traction += 2;
  if ((p.boosts?.active ?? 0) > 0) traction += 2;
  if (total >= 1000) traction += 2;
  traction = Math.min(traction, 10);

  // sentiment filled in by the cron (async social fetch); base total = 75 max
  const total_ = Math.round((liquidity + volume + momentum + age + traction) * 10) / 10;
  return { liquidity, volume, momentum, age, traction, sentiment: 0, total: total_ };
}

// ---- forensics (RugCheck) -------------------------------------------------
export async function safetyReport(mint: string): Promise<Forensics> {
  const out: Forensics = { verdict: "UNKNOWN", flags: [] };
  let rep: any;
  try { rep = await getJSON(`${RUGCHECK}/tokens/${mint}/report`); }
  catch (e) { out.flags.push(`rugcheck unavailable (${String(e)})`); return out; }

  const veto: string[] = [], caution: string[] = [];
  if (rep.mintAuthority) veto.push("mint authority ACTIVE");
  if (rep.freezeAuthority) veto.push("freeze authority ACTIVE");

  const holders: any[] = rep.topHolders ?? [];
  const top10 = holders.slice(0, 10).reduce((s, h) => s + (h.pct ?? 0), 0);
  const insiders = holders.filter((h) => h.insider);
  const insiderPct = insiders.reduce((s, h) => s + (h.pct ?? 0), 0);
  out.top10_pct = Math.round(top10 * 10) / 10;
  out.insider_pct = Math.round(insiderPct * 10) / 10;
  if (top10 > 50) veto.push(`top 10 hold ${top10.toFixed(0)}%`);
  else if (top10 > 30) caution.push(`top 10 hold ${top10.toFixed(0)}%`);
  if (insiderPct > 10) veto.push(`insiders hold ${insiderPct.toFixed(0)}%`);
  else if (insiderPct > 3) caution.push(`insiders hold ${insiderPct.toFixed(1)}%`);

  let lp: number | null = null;
  for (const m of rep.markets ?? []) { const p = m.lp?.lpLockedPct; if (p != null) lp = Math.max(lp ?? 0, p); }
  if (lp != null) { out.lp_locked_pct = Math.round(lp * 10) / 10; if (lp < 50) veto.push(`only ${lp.toFixed(0)}% LP locked`); else if (lp < 90) caution.push(`${lp.toFixed(0)}% LP locked`); }

  if (rep.creator) out.creator = rep.creator;
  if (Array.isArray(rep.creatorTokens) && rep.creatorTokens.length > 3) caution.push(`deployer launched ${rep.creatorTokens.length} tokens`);

  for (const r of rep.risks ?? []) {
    const lvl = (r.level ?? "").toLowerCase();
    if (lvl === "danger") veto.push(`rugcheck: ${r.name}`);
    else if (lvl === "warn" || lvl === "warning") caution.push(`rugcheck: ${r.name}`);
  }
  if (rep.score_normalised != null) out.rugcheck_score = rep.score_normalised;
  else if (rep.score != null) out.rugcheck_score = rep.score;

  out.flags = [...veto, ...caution];
  out.verdict = veto.length ? "VETO" : caution.length ? "CAUTION" : "PASS";
  return out;
}

// ---- top-level: one full scan pass ---------------------------------------
export async function runScan(chain = "solana", minLiq = 20_000): Promise<Candidate[]> {
  const addrs = await discover(chain);
  const pairs = await fetchPairs(chain, [...addrs]);
  const rows: Candidate[] = [];
  for (const p of pairs) {
    if ((p._liq ?? 0) < minLiq) continue;
    const b = scorePair(p);
    rows.push({
      address: p.baseToken.address,
      chain,
      symbol: p.baseToken.symbol ?? "?",
      name: p.baseToken.name ?? "",
      score: b.total,
      breakdown: b,
      mcap: p.marketCap ?? p.fdv ?? 0,
      liquidity: p._liq ?? 0,
      vol24: p.volume?.h24 ?? 0,
      price: Number(p.priceUsd ?? 0),
      ageHours: p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 3.6e6 : 0,
      ch1: p.priceChange?.h1 ?? 0,
      ch6: p.priceChange?.h6 ?? 0,
      ch24: p.priceChange?.h24 ?? 0,
      dexUrl: p.url ?? "",
    });
  }
  rows.sort((a, b) => b.score - a.score);
  return rows;
}
