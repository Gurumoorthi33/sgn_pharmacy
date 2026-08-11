import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/server"
import { emailDailyReport, todayIST, type DayStats } from "@/lib/report"

export const dynamic = "force-dynamic"
export const maxDuration = 60

// Vercel Cron hits this daily at 18:10 UTC (11:40 PM IST). It snapshots the
// day's totals, emails the summary, then clears the day's tokens.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = request.headers.get("authorization")
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }

  const date = todayIST()
  const admin = createAdminClient()

  // reset_day() logs today's totals into daily_summaries, deletes today's
  // tokens, and returns the stats snapshot.
  const { data, error } = await admin.rpc("reset_day")
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const stats = data as DayStats
  let emailed = false
  try {
    emailed = await emailDailyReport(date, stats)
  } catch (e) {
    console.log("[v0] daily report email failed:", (e as Error).message)
  }

  return NextResponse.json({ ok: true, date, emailed, stats })
}
