// Sentiment engine — two-tier social signal for the sentiment sub-score (25 pts).
//   Tier 1 (fresh < 24h): direct X/Twitter recent-search on ticker + contract.
//   Tier 2 (graduated):   LunarCrush aggregate (X + Reddit + YouTube + TikTok).
// Both degrade gracefully: with no API key set, returns { available:false } and
// the desk still runs on the on-chain score alone.

const X_SEARCH = "https://api.x.com/2/tweets/search/recent";
const LUNAR = "https://lunarcrush.com/api4/public/coins";
const SORSA = "https://api.sorsa.io/v3";

export type Divergence = "SOCIAL_LEADING" | "PRICE_LEADING" | "NEUTRAL";

export type Influencer = { username: string; followers: number; verified: boolean };

export type Sentiment = {
  available: boolean;
  source: "x" | "lunarcrush" | "sorsa" | "none";
  score: number;              // 0–25 sub-score folded into the model
  divergence: Divergence;
  posts1h?: number;
  velocity?: number;          // last-hour posts / prior-hour posts
  uniqueAuthors?: number;
  authorRatio?: number;       // unique authors / posts (author diversity)
  positivePct?: number;
  manipulated?: boolean;      // anti-shill gate tripped
  influencers?: Influencer[]; // notable accounts (verified or >10k followers) that mentioned it
  galaxyScore?: number;       // Tier 2 only
  socialVolume?: number;
  note?: string;
};

const EMPTY: Sentiment = { available: false, source: "none", score: 0, divergence: "NEUTRAL" };

async function getJSON(url: string, headers: Record<string, string>) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 60)}`);
  return r.json();
}

// Naive polarity: crypto bull/bear lexicon. X v2 doesn't ship sentiment.
const BULL = ["moon", "pump", "sending", "ape", "lfg", "based", "gem", "bullish", "100x", "buy", "🚀", "🔥"];
const BEAR = ["rug", "dump", "scam", "dead", "honeypot", "bearish", "sell", "avoid", "jeet", "exit"];
function polarity(texts: string[]): number {
  if (!texts.length) return 0.5;
  let pos = 0, neg = 0;
  for (const t of texts) {
    const l = t.toLowerCase();
    for (const w of BULL) if (l.includes(w)) pos++;
    for (const w of BEAR) if (l.includes(w)) neg++;
  }
  const tot = pos + neg;
  return tot ? pos / tot : 0.5;
}

function divergence(socialHot: boolean, priceCh1: number): Divergence {
  const priceFlat = Math.abs(priceCh1) < 15;
  const priceUp = priceCh1 >= 15;
  if (socialHot && priceFlat) return "SOCIAL_LEADING";   // early — the entry
  if (priceUp && !socialHot) return "PRICE_LEADING";     // late — chase risk
  return "NEUTRAL";
}

// ---- Tier 1: direct X recent search ---------------------------------------
async function xSentiment(symbol: string, address: string, ch1: number): Promise<Sentiment> {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) return { ...EMPTY, note: "no X_BEARER_TOKEN" };

  const q = encodeURIComponent(`($${symbol} OR ${address}) -is:retweet lang:en`);
  const url = `${X_SEARCH}?query=${q}&max_results=100&tweet.fields=created_at,public_metrics&expansions=author_id&user.fields=created_at,public_metrics`;
  let data: any;
  try { data = await getJSON(url, { Authorization: `Bearer ${token}` }); }
  catch (e) { return { ...EMPTY, note: `x error: ${String(e)}` }; }

  const posts: any[] = data.data ?? [];
  const users: Record<string, any> = {};
  for (const u of data.includes?.users ?? []) users[u.id] = u;
  if (posts.length < 3) return { available: true, source: "x", score: 0, divergence: "NEUTRAL", posts1h: posts.length, note: "too few posts" };

  const now = Date.now();
  const inLast = (mins: number) => posts.filter((p) => now - new Date(p.created_at).getTime() < mins * 60000);
  const last1h = inLast(60).length;
  const prev1h = inLast(120).length - last1h;
  const velocity = prev1h > 0 ? last1h / prev1h : last1h > 0 ? 2 : 0;

  const authors = new Set(posts.map((p) => p.author_id));
  const authorRatio = authors.size / posts.length;

  // credible reach: share of authors with aged accounts + real following
  const cred = [...authors].filter((id) => {
    const u = users[id]; if (!u) return false;
    const ageD = (now - new Date(u.created_at).getTime()) / 8.64e7;
    return ageD > 90 && (u.public_metrics?.followers_count ?? 0) > 500;
  }).length / authors.size;

  // anti-shill: identical-text ratio + low author diversity
  const norm = posts.map((p) => p.text.replace(/https?:\/\/\S+/g, "").trim().toLowerCase());
  const uniqTexts = new Set(norm).size / norm.length;
  const manipulated = authorRatio < 0.4 || uniqTexts < 0.4;

  const pos = polarity(posts.map((p) => p.text));

  // sub-score build (max 25)
  let s = 0;
  s += Math.min(9, velocity >= 2 ? 9 : velocity >= 1.3 ? 6 : velocity >= 1 ? 3 : 0);
  s += Math.min(6, authorRatio >= 0.7 ? 6 : authorRatio >= 0.5 ? 4 : 2);
  s += Math.min(5, pos >= 0.6 && pos < 0.95 ? 5 : pos >= 0.5 ? 3 : 0); // skeptical of 100% euphoria
  s += Math.min(5, cred >= 0.3 ? 5 : cred >= 0.1 ? 3 : 1);
  if (manipulated) s = Math.round(s * 0.3); // gate: discount paid pumps

  const socialHot = velocity >= 1.5 && !manipulated;
  return {
    available: true, source: "x", score: Math.round(s), divergence: divergence(socialHot, ch1),
    posts1h: last1h, velocity: Math.round(velocity * 100) / 100,
    uniqueAuthors: authors.size, authorRatio: Math.round(authorRatio * 100) / 100,
    positivePct: Math.round(pos * 100), manipulated,
  };
}

// ---- Tier 2: LunarCrush aggregate -----------------------------------------
async function lunarSentiment(symbol: string, ch1: number): Promise<Sentiment> {
  const key = process.env.LUNARCRUSH_API_KEY;
  if (!key) return { ...EMPTY, note: "no LUNARCRUSH_API_KEY" };
  let data: any;
  try { data = await getJSON(`${LUNAR}/${symbol}/v1`, { Authorization: `Bearer ${key}` }); }
  catch (e) { return { ...EMPTY, note: `lunarcrush error: ${String(e)}` }; }

  const d = data.data ?? data;
  const galaxy = d.galaxy_score ?? 0;            // 0–100 composite
  const sentiment = d.sentiment ?? 50;           // % positive
  const socialVol = d.social_volume_24h ?? d.social_volume ?? 0;
  const interactions = d.interactions_24h ?? 0;

  // map galaxy + sentiment into the 25-pt sub-score
  let s = 0;
  s += Math.min(12, (galaxy / 100) * 12);
  s += Math.min(7, sentiment >= 60 && sentiment < 95 ? 7 : sentiment >= 50 ? 4 : 0);
  s += Math.min(6, socialVol > 0 ? 6 : 0);
  const socialHot = galaxy >= 55 || interactions > 50000;
  return {
    available: true, source: "lunarcrush", score: Math.round(s), divergence: divergence(socialHot, ch1),
    positivePct: Math.round(sentiment), galaxyScore: galaxy, socialVolume: socialVol,
  };
}

// ---- Tier 1 (preferred): Sorsa (api.sorsa.io) — cheap Twitter search + crypto influence
async function sorsaSentiment(symbol: string, address: string, ch1: number): Promise<Sentiment> {
  const key = process.env.SORSA_API_KEY;
  if (!key) return { ...EMPTY, note: "no SORSA_API_KEY" };

  let data: any;
  try {
    const r = await fetch(`${SORSA}/search-tweets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ApiKey: key },
      body: JSON.stringify({ query: `($${symbol} OR ${address}) lang:en -filter:retweets`, order: "latest" }),
    });
    if (!r.ok) return { ...EMPTY, note: `sorsa ${r.status}` };
    data = await r.json();
  } catch (e) { return { ...EMPTY, note: `sorsa error: ${String(e)}` }; }

  const posts: any[] = data.tweets ?? data.results ?? data.data ?? (Array.isArray(data) ? data : []);
  if (posts.length < 3) return { available: true, source: "sorsa", score: 0, divergence: "NEUTRAL", posts1h: posts.length, note: "too few posts" };

  const now = Date.now();
  const ts = (p: any) => new Date(p.created_at).getTime();
  const inLast = (mins: number) => posts.filter((p) => now - ts(p) < mins * 60000).length;
  const last1h = inLast(60), prev1h = inLast(120) - last1h;
  const velocity = prev1h > 0 ? last1h / prev1h : last1h > 0 ? 2 : 0;

  const authorOf = (p: any) => p.user?.username ?? p.username ?? "?";
  const authors = new Set(posts.map(authorOf));
  const authorRatio = authors.size / posts.length;

  // credible reach + influencer roll-up (verified or >10k followers)
  const seen = new Map<string, Influencer>();
  for (const p of posts) {
    const u = p.user ?? {};
    const name = u.username ?? p.username;
    const followers = u.followers_count ?? 0;
    const verified = !!u.verified;
    if (name && (verified || followers >= 10_000) && !seen.has(name)) seen.set(name, { username: name, followers, verified });
  }
  const influencers = [...seen.values()].sort((a, b) => b.followers - a.followers).slice(0, 5);
  const credShare = authors.size ? influencers.length / authors.size : 0;

  const texts = posts.map((p) => p.full_text ?? p.text ?? "");
  const uniqTexts = new Set(texts.map((t) => t.replace(/https?:\/\/\S+/g, "").trim().toLowerCase())).size / texts.length;
  const manipulated = authorRatio < 0.4 || uniqTexts < 0.4;
  const pos = polarity(texts);

  let s = 0;
  s += Math.min(9, velocity >= 2 ? 9 : velocity >= 1.3 ? 6 : velocity >= 1 ? 3 : 0);
  s += Math.min(6, authorRatio >= 0.7 ? 6 : authorRatio >= 0.5 ? 4 : 2);
  s += Math.min(5, pos >= 0.6 && pos < 0.95 ? 5 : pos >= 0.5 ? 3 : 0);
  s += Math.min(5, influencers.length >= 2 ? 5 : influencers.length === 1 ? 3 : credShare > 0 ? 1 : 0);
  if (manipulated) s = Math.round(s * 0.3);

  const socialHot = velocity >= 1.5 && !manipulated;
  return {
    available: true, source: "sorsa", score: Math.round(s), divergence: divergence(socialHot, ch1),
    posts1h: last1h, velocity: Math.round(velocity * 100) / 100,
    uniqueAuthors: authors.size, authorRatio: Math.round(authorRatio * 100) / 100,
    positivePct: Math.round(pos * 100), manipulated, influencers,
  };
}

// ---- router: try providers in preference order, return first with data -----
export async function fetchSentiment(
  symbol: string, address: string, ageHours: number, ch1: number
): Promise<Sentiment> {
  // Sorsa is preferred (cheap, crypto-Twitter-native, sees fresh coins).
  const providers = [
    () => sorsaSentiment(symbol, address, ch1),
    () => xSentiment(symbol, address, ch1),
    () => lunarSentiment(symbol, ch1),
  ];
  let last: Sentiment = EMPTY;
  for (const p of providers) {
    const r = await p();
    if (r.available) return r;
    last = r;
  }
  return last;
}
