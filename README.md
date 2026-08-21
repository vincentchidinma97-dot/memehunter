# Meme Hunter 2026

Scores fresh meme coins from DexScreener's free public API against a 100-point model
(liquidity health 25, volume quality 25, momentum 20, age sweet spot 15, traction 15).

```bash
python3 meme_hunter.py --chain solana --min-liq 20000 --top 15
```

The score ranks candidates for research only. Before any trade, run every address through:

1. **rugcheck.xyz** — mint/freeze authority, LP lock/burn
2. **bubblemaps.io** — holder concentration and bundled wallet clusters (top 10 > 50% = walk away)
3. **gmgn.ai** — smart-money wallets, first 10 buyers, deployer history

Full playbook (workflow, kill filters, risk rules):
https://claude.ai/code/artifact/dd5640ed-395c-41c8-ac90-df8a8ab86c36

Not financial advice. ~98% of launches fail; size 0.1–0.5% of capital per token.
