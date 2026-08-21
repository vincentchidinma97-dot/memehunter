import { NextResponse } from "next/server";
import { admin } from "@/lib/db";
import { openPosition } from "@/lib/paper";

export const dynamic = "force-dynamic";

// Manual paper buy from the dashboard "Paper buy" button.
export async function POST(req: Request) {
  const { address, sizeUsd } = await req.json();
  if (!address) return NextResponse.json({ error: "address required" }, { status: 400 });
  const r = await openPosition(admin(), address, sizeUsd);
  return NextResponse.json(r, { status: r.ok ? 200 : 400 });
}
