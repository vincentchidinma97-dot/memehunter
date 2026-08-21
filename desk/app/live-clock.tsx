"use client";
import { useEffect, useState } from "react";

// Live UTC clock + next-scan countdown. Cosmetic; the real scan is the Vercel cron.
export function LiveClock() {
  const [now, setNow] = useState<string>("--:--:--");
  const [cd, setCd] = useState<string>("--:--");

  useEffect(() => {
    let secs = (30 - (new Date().getMinutes() % 30)) * 60 - new Date().getSeconds();
    const id = setInterval(() => {
      const d = new Date();
      setNow(d.toUTCString().slice(17, 25) + " UTC");
      secs = secs <= 0 ? 30 * 60 : secs - 1;
      setCd(`${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="clock">
      <div className="t mono">{now}</div>
      <div className="c">next scan in <span className="mono">{cd}</span></div>
    </div>
  );
}
