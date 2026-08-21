// Consensus gate: a trade fires only when multiple independent signals agree,
// not just one. RugCheck PASS is mandatory; then we need `required` of the
// remaining legs to also agree. The "social" leg is dark until sentiment keys
// are added — once they are, it becomes a real extra vote automatically.
import type { Breakdown } from "./scan";
import type { Sentiment } from "./sentiment";

export type Leg = { name: string; ok: boolean; live: boolean };
export type Consensus = { legs: Leg[]; count: number; required: number; passed: boolean; late: boolean };

export function evaluateConsensus(
  b: Breakdown,
  finalScore: number,
  minScore: number,
  verdict: string,
  sentiment: Sentiment | null,
  required: number,
  ch24: number,
  maxChasePct: number,
): Consensus {
  const rugOk = verdict === "PASS";        // mandatory: no PASS, no trade
  const late = ch24 > maxChasePct;         // mandatory: don't chase a token that already ran
  const legs: Leg[] = [
    { name: "score", ok: finalScore >= minScore, live: true },
    { name: "volume", ok: b.volume >= 14, live: true },       // strong real 2-sided flow (of 20)
    { name: "momentum", ok: b.momentum >= 8, live: true },    // trending up (of 15)
    { name: "liquidity", ok: b.liquidity >= 12, live: true }, // healthy depth to exit (of 20)
    {
      name: "social",
      ok: !!sentiment?.available && (sentiment.score ?? 0) >= 12
        && !sentiment.manipulated && sentiment.divergence !== "PRICE_LEADING",
      live: !!sentiment?.available,
    },
  ];
  const count = legs.filter((l) => l.ok).length;
  return { legs, count, required, late, passed: rugOk && !late && count >= required };
}
