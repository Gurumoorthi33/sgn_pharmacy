import "server-only"
import nodemailer from "nodemailer"
import { createAdminClient } from "@/lib/supabase/server"
import { HOSPITAL_NAME, REPORT_RECIPIENTS } from "@/lib/types"

export type DayStats = {
  total: number
  first_token: number | null
  last_token: number | null
  entry_1: number
  entry_2: number
  entry_3: number
  entry_done: number
  payment_done: number
  dispatch_done: number
  in_progress: number
  pending_entry: number
  pending_payment: number
  pending_dispatch: number
}

export function todayIST(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })
}

// Build a CSV report for a given day's stats.
export function buildCsv(date: string, s: DayStats): string {
  const rows: [string, string | number][] = [
    ["Report Date", date],
    ["Hospital", HOSPITAL_NAME],
    ["Total tokens issued", s.total],
    ["First token", s.first_token ?? "-"],
    ["Last token", s.last_token ?? "-"],
    ["Entry Counter 1 served", s.entry_1],
    ["Entry Counter 2 served", s.entry_2],
    ["Entry Counter 3 served", s.entry_3],
    ["Entry completed (total)", s.entry_done],
    ["Payment completed", s.payment_done],
    ["Dispatch completed", s.dispatch_done],
    ["Still in progress at reset", s.in_progress],
  ]
  const escape = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`
  return rows.map(([k, v]) => `${escape(k)},${escape(v)}`).join("\n")
}

// Fetch aggregated stats for today via the admin_stats RPC.
export async function fetchDayStats(): Promise<DayStats> {
  const admin = createAdminClient()
  const { data, error } = await admin.rpc("admin_stats")
  if (error) throw new Error(error.message)
  return data as DayStats
}

function smtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD)
}

// Email the daily summary + CSV attachment. Returns false if SMTP is not configured.
export async function emailDailyReport(date: string, s: DayStats): Promise<boolean> {
  if (!smtpConfigured()) return false

  const recipients = REPORT_RECIPIENTS
  if (recipients.length === 0) return false

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT || 587) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
  })

  const csv = buildCsv(date, s)
  const html = `
    <h2>SGN Pharmacy — Daily Token Report</h2>
    <p><strong>${HOSPITAL_NAME}</strong></p>
    <p>Date: ${date}</p>
    <table cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif">
      <tr><td>Total tokens issued</td><td><strong>${s.total}</strong></td></tr>
      <tr><td>Token range</td><td>${s.first_token ?? "-"} – ${s.last_token ?? "-"}</td></tr>
      <tr><td>Entry Counter 1</td><td>${s.entry_1}</td></tr>
      <tr><td>Entry Counter 2</td><td>${s.entry_2}</td></tr>
      <tr><td>Entry Counter 3</td><td>${s.entry_3}</td></tr>
      <tr><td>Payment completed</td><td>${s.payment_done}</td></tr>
      <tr><td>Dispatch completed</td><td>${s.dispatch_done}</td></tr>
    </table>
  `

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: recipients.join(","),
    subject: `SGN Daily Token Report — ${date}`,
    html,
    attachments: [{ filename: `sgn-report-${date}.csv`, content: csv }],
  })

  return true
}
