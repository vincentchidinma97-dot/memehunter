"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function BuyButton({ address, symbol, blocked }: { address: string; symbol: string; blocked: boolean }) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function buy() {
    setBusy(true);
    const res = await fetch("/api/paper-buy", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    });
    const j = await res.json();
    setBusy(false);
    if (!j.ok) alert(`Can't paper-buy ${symbol}: ${j.reason}`);
    else router.refresh();
  }

  if (blocked) return <button className="buy" disabled>Blocked</button>;
  return <button className="buy" onClick={buy} disabled={busy}>{busy ? "…" : "Paper buy"}</button>;
}
