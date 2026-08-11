"use server"

import { createClient } from "@/lib/supabase/server"
import { buildCsv, emailDailyReport, fetchDayStats, todayIST, type DayStats } from "@/lib/report"

// Ensure the caller is an authenticated admin.
async function requireAdmin() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single()
  if (profile?.role !== "admin") throw new Error("Not authorized")
  return supabase
}

export async function getStatsAction(): Promise<{ stats?: DayStats; error?: string }> {
  try {
    await requireAdmin()
    const stats = await fetchDayStats()
    return { stats }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// Return today's report as CSV text for client-side download.
export async function downloadReportAction(): Promise<{ csv?: string; date?: string; error?: string }> {
  try {
    await requireAdmin()
    const date = todayIST()
    const stats = await fetchDayStats()
    return { csv: buildCsv(date, stats), date }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// Email today's report immediately.
export async function emailReportNowAction(): Promise<{ ok?: boolean; emailed?: boolean; error?: string }> {
  try {
    await requireAdmin()
    const date = todayIST()
    const stats = await fetchDayStats()
    const emailed = await emailDailyReport(date, stats)
    return { ok: true, emailed }
  } catch (e) {
    return { error: (e as Error).message }
  }
}
