#!/usr/bin/env python3
"""
Meme Hunter 2026 — scores fresh meme coins from DexScreener's free public API.

No API key needed. Run:  python3 meme_hunter.py [--chain solana] [--min-liq 20000]

Scoring model (0-100):
  Liquidity health   25 pts  — absolute liquidity + liq/mcap ratio (15-30% ideal)
  Volume quality     25 pts  — 24h volume vs market cap (>=30% strong), buy/sell balance
  Momentum           20 pts  — 1h/6h/24h price action, txn velocity
  Age sweet spot     15 pts  — old enough to survive snipers, young enough to run
  Traction           15 pts  — boost/profile presence, socials, txn count

The score ranks *candidates for further research*. It cannot see holder
concentration, contract safety, or dev wallets — always run the token through
RugCheck + Bubblemaps + GMGN before touching it. A high score is NOT a buy signal.
"""

import argparse
import json
import ssl
import time
import urllib.request
from datetime import datetime, timezone

API = "https://api.dexscreener.com"

try:  # macOS framework Python often lacks system CA certs
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CTX = ssl.create_default_context()


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "meme-hunter/1.0"})
    with urllib.request.urlopen(req, timeout=15, context=SSL_CTX) as r:
        return json.load(r)


def discover_tokens(chain):
    """Collect candidate token addresses from boosted + profiled feeds."""
    seen = {}
    for path in ("/token-boosts/latest/v1", "/token-boosts/top/v1",
                 "/token-profiles/latest/v1"):
        try:
            for t in get(API + path):
                if t.get("chainId") == chain:
                    seen[t["tokenAddress"]] = t
        except Exception as e:
            print(f"  warn: {path}: {e}")
    return seen


def fetch_pairs(chain, addresses):
    """Fetch market data for tokens, 30 addresses per call."""
    pairs = []
    addrs = list(addresses)
    for i in range(0, len(addrs), 30):
        chunk = ",".join(addrs[i:i + 30])
        try:
            pairs += get(f"{API}/tokens/v1/{chain}/{chunk}")
        except Exception as e:
            print(f"  warn: batch fetch: {e}")
        time.sleep(0.3)
    # keep the deepest pair per token
    best = {}
    for p in pairs:
        addr = p.get("baseToken", {}).get("address")
        liq = (p.get("liquidity") or {}).get("usd", 0) or 0
        if addr and liq > (best.get(addr, {}).get("_liq", -1)):
            p["_liq"] = liq
            best[addr] = p
    return list(best.values())


def score_pair(p):
    liq = p["_liq"]
    mcap = p.get("marketCap") or p.get("fdv") or 0
    vol24 = (p.get("volume") or {}).get("h24", 0) or 0
    tx = p.get("txns") or {}
    buys = sum((tx.get(k) or {}).get("buys", 0) for k in ("h1", "h6", "h24"))
    sells = sum((tx.get(k) or {}).get("sells", 0) for k in ("h1", "h6", "h24"))
    ch = p.get("priceChange") or {}
    ch1, ch6, ch24 = (ch.get("h1") or 0), (ch.get("h6") or 0), (ch.get("h24") or 0)
    created = p.get("pairCreatedAt")
    age_h = (time.time() * 1000 - created) / 3.6e6 if created else None

    s = {}

    # Liquidity health (25)
    pts = 0.0
    if liq >= 20_000: pts += 8
    if liq >= 100_000: pts += 4
    if mcap > 0:
        r = liq / mcap
        if 0.10 <= r <= 0.40: pts += 13
        elif r >= 0.05: pts += 6
    s["liquidity"] = min(pts, 25)

    # Volume quality (25)
    pts = 0.0
    if mcap > 0 and vol24 / mcap >= 0.30: pts += 13
    elif mcap > 0 and vol24 / mcap >= 0.10: pts += 6
    total = buys + sells
    if total > 0:
        bal = buys / total
        if 0.45 <= bal <= 0.70: pts += 12   # healthy two-sided flow, buy-leaning
        elif bal > 0.70: pts += 5           # too buy-heavy → possible bundle/bot
    s["volume"] = min(pts, 25)

    # Momentum (20)
    pts = 0.0
    if ch1 > 0: pts += 6
    if ch6 > 0: pts += 6
    if ch24 > 0: pts += 4
    if ch1 > 100: pts -= 6                  # vertical candle = chase risk
    h1tx = sum((tx.get("h1") or {}).get(k, 0) for k in ("buys", "sells"))
    if h1tx >= 150: pts += 4
    s["momentum"] = max(min(pts, 20), 0)

    # Age sweet spot (15): 6h–14d
    pts = 0.0
    if age_h is not None:
        if 6 <= age_h <= 336: pts = 15
        elif age_h < 6: pts = 5             # sniper/bundle zone
        elif age_h <= 720: pts = 8
        else: pts = 3
    s["age"] = pts

    # Traction (15)
    pts = 0.0
    info = p.get("info") or {}
    if info.get("socials"): pts += 6
    if info.get("websites"): pts += 3
    if p.get("boosts", {}).get("active", 0) > 0: pts += 3
    if total >= 1000: pts += 3
    s["traction"] = min(pts, 15)

    s["total"] = round(sum(s.values()), 1)
    return s


RUGCHECK = "https://api.rugcheck.xyz/v1"


def safety_report(mint):
    """Pull RugCheck report for a Solana mint: authorities, holders, insiders, LP.

    Returns a dict of findings + a verdict: PASS / CAUTION / VETO.
    """
    out = {"verdict": "UNKNOWN", "flags": [], "notes": []}
    try:
        rep = get(f"{RUGCHECK}/tokens/{mint}/report")
    except Exception as e:
        out["notes"].append(f"rugcheck unavailable ({e})")
        return out

    veto, caution = [], []

    if rep.get("mintAuthority"):
        veto.append("mint authority ACTIVE (dev can print supply)")
    if rep.get("freezeAuthority"):
        veto.append("freeze authority ACTIVE (dev can freeze your tokens)")

    # Top holder concentration (exclude LP/AMM accounts when flagged)
    holders = rep.get("topHolders") or []
    top10 = sum(h.get("pct", 0) for h in holders[:10])
    insiders = [h for h in holders if h.get("insider")]
    insider_pct = sum(h.get("pct", 0) for h in insiders)
    out["top10_pct"] = round(top10, 1)
    out["insider_pct"] = round(insider_pct, 1)
    if top10 > 50:
        veto.append(f"top 10 wallets hold {top10:.0f}% of supply")
    elif top10 > 30:
        caution.append(f"top 10 wallets hold {top10:.0f}%")
    if insider_pct > 10:
        veto.append(f"insider-network wallets hold {insider_pct:.0f}%")
    elif insider_pct > 3:
        caution.append(f"insider wallets hold {insider_pct:.1f}%")

    # LP lock/burn across markets
    lp_locked = None
    for m in rep.get("markets") or []:
        lp = m.get("lp") or {}
        pct = lp.get("lpLockedPct")
        if pct is not None:
            lp_locked = max(lp_locked or 0, pct)
    if lp_locked is not None:
        out["lp_locked_pct"] = round(lp_locked, 1)
        if lp_locked < 50:
            veto.append(f"only {lp_locked:.0f}% of LP locked/burned")
        elif lp_locked < 90:
            caution.append(f"{lp_locked:.0f}% LP locked")

    # Creator / dev wallet behavior
    creator = rep.get("creator")
    if creator:
        out["creator"] = creator
    ct = rep.get("creatorTokens")
    if isinstance(ct, list) and len(ct) > 3:
        caution.append(f"deployer has launched {len(ct)} tokens (serial launcher)")

    # RugCheck's own risk list — surface high-level risks verbatim
    for r in rep.get("risks") or []:
        lvl = (r.get("level") or "").lower()
        name = r.get("name", "risk")
        if lvl == "danger":
            veto.append(f"rugcheck: {name}")
        elif lvl in ("warn", "warning"):
            caution.append(f"rugcheck: {name}")

    score = rep.get("score_normalised", rep.get("score"))
    if score is not None:
        out["rugcheck_score"] = score

    out["flags"] = veto + caution
    out["verdict"] = "VETO" if veto else ("CAUTION" if caution else "PASS")
    return out


def flip_plan(entry_mcap):
    """Mechanical flip levels from an entry market cap."""
    return {
        "sell_half": entry_mcap * 2,     # 2x: pull initial, ride house money
        "sell_75": entry_mcap * 4,       # 4x: take another 25%
        "hard_stop": entry_mcap * 0.5,   # -50%: out, no averaging down
    }


def fmt_usd(x):
    if x >= 1e9: return f"${x/1e9:.2f}B"
    if x >= 1e6: return f"${x/1e6:.2f}M"
    if x >= 1e3: return f"${x/1e3:.1f}K"
    return f"${x:.0f}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chain", default="solana")
    ap.add_argument("--min-liq", type=float, default=20_000)
    ap.add_argument("--top", type=int, default=15)
    ap.add_argument("--safety", type=int, default=5,
                    help="run RugCheck wallet/holder forensics on the top N scorers (0 to skip)")
    args = ap.parse_args()

    print(f"Meme Hunter — {args.chain} — {datetime.now(timezone.utc):%Y-%m-%d %H:%M UTC}")
    tokens = discover_tokens(args.chain)
    print(f"discovered {len(tokens)} candidate tokens; fetching pair data...")
    pairs = fetch_pairs(args.chain, tokens)

    rows = []
    for p in pairs:
        if p["_liq"] < args.min_liq:
            continue
        sc = score_pair(p)
        created = p.get("pairCreatedAt")
        age_h = (time.time() * 1000 - created) / 3.6e6 if created else 0
        rows.append({
            "symbol": p["baseToken"].get("symbol", "?"),
            "score": sc["total"],
            "breakdown": sc,
            "mcap": p.get("marketCap") or p.get("fdv") or 0,
            "liq": p["_liq"],
            "vol24": (p.get("volume") or {}).get("h24", 0) or 0,
            "ch24": (p.get("priceChange") or {}).get("h24") or 0,
            "age_h": age_h,
            "url": p.get("url", ""),
            "address": p["baseToken"].get("address", ""),
        })

    rows.sort(key=lambda r: -r["score"])
    print(f"\n{'SYMBOL':<12}{'SCORE':>6}{'MCAP':>10}{'LIQ':>10}{'VOL24':>10}{'24H%':>8}{'AGE':>8}")
    print("-" * 64)
    for r in rows[:args.top]:
        age = f"{r['age_h']:.0f}h" if r["age_h"] < 48 else f"{r['age_h']/24:.0f}d"
        print(f"{r['symbol'][:11]:<12}{r['score']:>6.1f}{fmt_usd(r['mcap']):>10}"
              f"{fmt_usd(r['liq']):>10}{fmt_usd(r['vol24']):>10}{r['ch24']:>7.1f}%{age:>8}")
    if args.safety and args.chain == "solana":
        print(f"\n=== FORENSICS — top {min(args.safety, len(rows))} scorers (RugCheck) ===")
        for r in rows[:args.safety]:
            s = safety_report(r["address"])
            time.sleep(0.5)
            tag = {"PASS": "✅ PASS", "CAUTION": "⚠️  CAUTION",
                   "VETO": "⛔ VETO", "UNKNOWN": "❔ NO DATA"}[s["verdict"]]
            extras = []
            if "top10_pct" in s: extras.append(f"top10 {s['top10_pct']}%")
            if "insider_pct" in s: extras.append(f"insiders {s['insider_pct']}%")
            if "lp_locked_pct" in s: extras.append(f"LP locked {s['lp_locked_pct']}%")
            print(f"\n{r['symbol']:<12} {tag}   {' | '.join(extras)}")
            for f in s["flags"]:
                print(f"    - {f}")
            for n in s["notes"]:
                print(f"    - {n}")
            if s["verdict"] in ("PASS", "CAUTION"):
                fp = flip_plan(r["mcap"])
                print(f"    flip plan @ mcap {fmt_usd(r['mcap'])}: "
                      f"sell 50% @ {fmt_usd(fp['sell_half'])} mcap, "
                      f"sell 25% @ {fmt_usd(fp['sell_75'])}, "
                      f"hard stop @ {fmt_usd(fp['hard_stop'])}")

    print("\nAddresses (for GMGN smart-money cross-check / your TG bot):")
    for r in rows[:args.top]:
        print(f"  {r['symbol']:<12} {r['address']}  {r['url']}")


if __name__ == "__main__":
    main()
