// Server-renderable SVG bits for the dashboard. Pure functions → JSX.
import React from "react";

export function usd(n: number): string {
  const a = Math.abs(n), s = n < 0 ? "-" : "";
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(1)}K`;
  return `${s}$${a.toFixed(0)}`;
}

// Deterministic gradient avatar disc from a ticker (gives each row identity).
export function Avatar({ symbol }: { symbol: string }) {
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = symbol.charCodeAt(i) + ((h << 5) - h);
  const hue = Math.abs(h) % 360;
  return (
    <div className="avatar" style={{ background: `linear-gradient(135deg, hsl(${hue} 85% 62%), hsl(${(hue + 40) % 360} 85% 48%))` }}>
      {(symbol[0] ?? "?").toUpperCase()}
    </div>
  );
}

export function Gauge({ score }: { score: number }) {
  const R = 19, C = 2 * Math.PI * R;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const col = score >= 85 ? "var(--mint)" : score >= 70 ? "var(--amber)" : "var(--muted)";
  return (
    <svg className="gauge" width="48" height="48" viewBox="0 0 48 48" role="img" aria-label={`score ${score}`}>
      <circle cx="24" cy="24" r={R} fill="none" stroke="#161d2b" strokeWidth="4.5" />
      <circle cx="24" cy="24" r={R} fill="none" stroke={col} strokeWidth="4.5" strokeLinecap="round"
        strokeDasharray={`${(C * pct).toFixed(1)} ${C.toFixed(1)}`} transform="rotate(-90 24 24)"
        style={{ filter: `drop-shadow(0 0 4px ${col})` }} />
      <text x="24" y="24" textAnchor="middle" dominantBaseline="central" fill={col}
        fontFamily="var(--mono)" fontSize="15" fontWeight="800">{Math.round(score)}</text>
    </svg>
  );
}

// Sparkline from the three real price-change points: 24h→6h→1h→now.
export function Spark({ price, ch1, ch6, ch24 }: { price: number; ch1: number; ch6: number; ch24: number }) {
  const now = price || 1;
  // reconstruct past price = now / (1 + ch%); guard divisor for ch <= -100%
  const past = (ch: number) => { const d = 1 + ch / 100; return d > 0.01 ? now / d : now; };
  const pts = [past(ch24), past(ch6), past(ch1), now];
  const mn = Math.min(...pts), mx = Math.max(...pts);
  const norm = pts.map((v) => (v - mn) / ((mx - mn) || 1));
  const w = 100, h = 36, step = w / (norm.length - 1);
  const d = norm.map((v, i) => `${i ? "L" : "M"}${(i * step).toFixed(1)},${(2 + (1 - v) * (h - 4)).toFixed(1)}`).join(" ");
  const col = ch24 >= 0 ? "var(--mint)" : "var(--coral)";
  return (
    <svg className="spark" viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden="true">
      <path d={`${d} L100,36 L0,36 Z`} fill={col} opacity="0.10" />
      <path d={d} fill="none" stroke={col} strokeWidth="1.8" />
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

// Bank equity curve. `hero` renders it as the full-width backdrop behind the P&L.
export function Equity({ startBank, closedPnls, hero }: { startBank: number; closedPnls: number[]; hero?: boolean }) {
  let bank = startBank; const pts = [bank];
  for (const p of closedPnls) { bank += p; pts.push(bank); }
  const w = hero ? 720 : 320, h = hero ? 110 : 46, pad = hero ? 24 : 6;
  const mn = Math.min(...pts), mx = Math.max(...pts), step = w / (pts.length - 1 || 1);
  const d = pts.map((v, i) => `${i ? "L" : "M"}${(i * step).toFixed(1)},${(h - 2 - ((v - mn) / ((mx - mn) || 1)) * (h - pad)).toFixed(1)}`).join(" ");
  const up = pts[pts.length - 1] >= pts[0];
  const col = up ? "var(--mint)" : "var(--coral)";
  return (
    <svg className={hero ? "hero-eq" : "equity"} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={`${d} L${w},${h} L0,${h} Z`} fill={col} opacity={hero ? 0.14 : 0.10} />
      <path d={d} fill="none" stroke={col} strokeWidth={hero ? 2 : 1.6} style={hero ? { filter: `drop-shadow(0 0 6px ${col})` } : undefined} />
    </svg>
  );
}
