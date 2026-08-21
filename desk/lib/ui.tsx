// Server-renderable SVG bits for the dashboard. Pure functions → JSX.
import React from "react";

export function usd(n: number): string {
  const a = Math.abs(n), s = n < 0 ? "-" : "";
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(1)}K`;
  return `${s}$${a.toFixed(0)}`;
}

export function Gauge({ score }: { score: number }) {
  const R = 18, C = 2 * Math.PI * R;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const col = score >= 85 ? "var(--mint)" : score >= 70 ? "var(--amber)" : "var(--muted)";
  return (
    <svg className="gauge" viewBox="0 0 46 46" role="img" aria-label={`score ${score}`}>
      <circle cx="23" cy="23" r={R} fill="none" stroke="#1a2130" strokeWidth="4" />
      <circle cx="23" cy="23" r={R} fill="none" stroke={col} strokeWidth="4" strokeLinecap="round"
        strokeDasharray={`${(C * pct).toFixed(1)} ${C.toFixed(1)}`} transform="rotate(-90 23 23)" />
      <text x="23" y="23" textAnchor="middle" dominantBaseline="central" fill={col}
        fontFamily="var(--mono)" fontSize="14" fontWeight="700">{Math.round(score)}</text>
    </svg>
  );
}

// Sparkline from the three real price-change points: 24h→6h→1h→now.
export function Spark({ price, ch1, ch6, ch24 }: { price: number; ch1: number; ch6: number; ch24: number }) {
  const now = price || 1;
  const pts = [now / (1 + ch24 / 100), now / (1 + ch6 / 100), now / (1 + ch1 / 100), now];
  const mn = Math.min(...pts), mx = Math.max(...pts);
  const norm = pts.map((v) => (v - mn) / ((mx - mn) || 1));
  const w = 100, h = 34, step = w / (norm.length - 1);
  const d = norm.map((v, i) => `${i ? "L" : "M"}${(i * step).toFixed(1)},${(2 + (1 - v) * (h - 4)).toFixed(1)}`).join(" ");
  const col = ch24 >= 0 ? "var(--mint)" : "var(--coral)";
  return (
    <svg className="spark" viewBox="0 0 100 34" preserveAspectRatio="none" aria-hidden="true">
      <path d={`${d} L100,34 L0,34 Z`} fill={col} opacity="0.08" />
      <path d={d} fill="none" stroke={col} strokeWidth="1.6" />
    </svg>
  );
}

export function Meter({ pct, kind }: { pct: number; kind: "conc" | "lp" }) {
  let col = "var(--mint)";
  if (kind === "conc") col = pct > 50 ? "var(--coral)" : pct > 30 ? "var(--amber)" : "var(--mint)";
  if (kind === "lp") col = pct >= 90 ? "var(--mint)" : pct >= 50 ? "var(--amber)" : "var(--coral)";
  return <span className="meter"><i style={{ width: `${Math.min(100, pct)}%`, background: col }} /></span>;
}

export function Ch({ v }: { v: number }) {
  return <span className={v > 0 ? "pos" : v < 0 ? "neg" : ""}>{v > 0 ? "+" : ""}{Math.round(v)}%</span>;
}

// Divergence badge: the social-vs-price edge. Leading=early, lagging=chase risk.
export function Divergence({ s }: { s: any }) {
  if (!s?.available) return <span className="diverge d-none">no social</span>;
  if (s.manipulated) return <span className="diverge d-shill">⚠ shill spike</span>;
  if (s.divergence === "SOCIAL_LEADING") return <span className="diverge d-lead">social leading</span>;
  if (s.divergence === "PRICE_LEADING") return <span className="diverge d-lag">price leading</span>;
  return <span className="diverge d-neutral">social neutral</span>;
}

export function Equity({ startBank, closedPnls }: { startBank: number; closedPnls: number[] }) {
  let bank = startBank; const pts = [bank];
  for (const p of closedPnls) { bank += p; pts.push(bank); }
  const mn = Math.min(...pts), mx = Math.max(...pts), w = 320, h = 46, step = w / (pts.length - 1 || 1);
  const d = pts.map((v, i) => `${i ? "L" : "M"}${(i * step).toFixed(1)},${(h - 2 - ((v - mn) / ((mx - mn) || 1)) * (h - 6)).toFixed(1)}`).join(" ");
  const up = pts[pts.length - 1] >= pts[0];
  const col = up ? "var(--mint)" : "var(--coral)";
  return (
    <svg className="equity" viewBox="0 0 320 46" preserveAspectRatio="none" aria-hidden="true">
      <path d={`${d} L320,46 L0,46 Z`} fill={col} opacity="0.10" />
      <path d={d} fill="none" stroke={col} strokeWidth="1.6" />
    </svg>
  );
}
