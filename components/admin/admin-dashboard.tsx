"use client"

import { useState, useTransition } from "react"
import { useTokens } from "@/hooks/use-tokens"
import { downloadReportAction, emailReportNowAction } from "@/app/admin/actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Download, Mail, Activity, Users, CreditCard, PackageCheck } from "lucide-react"

export function AdminDashboard() {
  const { tokens } = useTokens()
  const [pending, startTransition] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)

  // Live stats computed from today's tokens.
  const total = tokens.length
  const numbers = tokens.map((t) => t.token_number)
  const firstToken = numbers.length ? Math.min(...numbers) : null
  const lastToken = numbers.length ? Math.max(...numbers) : null

  const entryCount = (c: number) =>
    tokens.filter((t) => t.entry_counter === c && t.entry_completed_at !== null).length
  const entry1 = entryCount(1)
  const entry2 = entryCount(2)
  const entry3 = entryCount(3)
  const entryDone = tokens.filter((t) => t.entry_completed_at !== null).length
  const paymentDone = tokens.filter((t) => t.payment_completed_at !== null).length
  const dispatchDone = tokens.filter((t) => t.status === "completed").length
  const inProgress = tokens.filter((t) => t.status !== "completed").length

  const maxEntry = Math.max(entry1, entry2, entry3, 1)

  function handleDownload() {
    setMsg(null)
    startTransition(async () => {
      const res = await downloadReportAction()
      if (res.error || !res.csv) {
        setMsg(res.error ?? "Failed to build report.")
        return
      }
      const blob = new Blob([res.csv], { type: "text/csv;charset=utf-8;" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `sgn-report-${res.date}.csv`
      a.click()
      URL.revokeObjectURL(url)
    })
  }

  function handleEmail() {
    setMsg(null)
    startTransition(async () => {
      const res = await emailReportNowAction()
      if (res.error) {
        setMsg(res.error)
      } else if (res.emailed) {
        setMsg("Report emailed to the configured recipients.")
      } else {
        setMsg("SMTP is not configured yet — add SMTP settings to enable email.")
      }
    })
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      {/* Top stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={<Activity className="h-5 w-5" />} label="Tokens today" value={total} accent="text-primary" />
        <StatCard
          icon={<Users className="h-5 w-5" />}
          label="Entry completed"
          value={entryDone}
          accent="text-primary"
        />
        <StatCard
          icon={<CreditCard className="h-5 w-5" />}
          label="Payment completed"
          value={paymentDone}
          accent="text-foreground"
        />
        <StatCard
          icon={<PackageCheck className="h-5 w-5" />}
          label="Dispatched"
          value={dispatchDone}
          accent="text-success"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        {/* Entry counter performance */}
        <Card>
          <CardHeader className="border-b border-border">
            <CardTitle className="text-base">Entry counter performance</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 py-6">
            {[
              { label: "Counter 1", value: entry1 },
              { label: "Counter 2", value: entry2 },
              { label: "Counter 3", value: entry3 },
            ].map((row) => (
              <div key={row.label} className="flex flex-col gap-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium text-foreground">{row.label}</span>
                  <span className="font-mono font-semibold text-foreground">{row.value}</span>
                </div>
                <div className="h-3 w-full overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${(row.value / maxEntry) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Summary + reports */}
        <Card className="flex flex-col">
          <CardHeader className="border-b border-border">
            <CardTitle className="text-base">Today&apos;s summary</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-3 py-6">
            <SummaryRow label="Token range" value={firstToken ? `${firstToken} – ${lastToken}` : "—"} />
            <SummaryRow label="In progress" value={inProgress} />
            <SummaryRow label="Pending entry" value={tokens.filter((t) => t.status === "pending_entry" || t.status === "entry_waiting").length} />
            <SummaryRow label="Pending payment" value={tokens.filter((t) => t.status === "pending_payment").length} />
            <SummaryRow label="Pending dispatch" value={tokens.filter((t) => t.status === "pending_dispatch").length} />

            <div className="mt-auto flex flex-col gap-2 pt-4">
              <Button onClick={handleDownload} disabled={pending} variant="outline" className="bg-transparent">
                <Download className="mr-2 h-4 w-4" aria-hidden="true" />
                Download CSV report
              </Button>
              <Button onClick={handleEmail} disabled={pending}>
                <Mail className="mr-2 h-4 w-4" aria-hidden="true" />
                Email report now
              </Button>
              {msg ? <p className="text-center text-xs text-muted-foreground">{msg}</p> : null}
            </div>
          </CardContent>
        </Card>
      </div>

      <p className="text-center text-xs text-muted-foreground">
        The board resets automatically every day at 11:40 PM IST and the summary is emailed to the pharmacy
        supervisors.
      </p>
    </div>
  )
}

function StatCard({
  icon,
  label,
  value,
  accent,
}: {
  icon: React.ReactNode
  label: string
  value: number
  accent: string
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 py-5">
        <div className={`flex h-11 w-11 items-center justify-center rounded-lg bg-secondary ${accent}`}>{icon}</div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className="font-mono text-2xl font-bold text-foreground">{value}</p>
        </div>
      </CardContent>
    </Card>
  )
}

function SummaryRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between border-b border-border pb-2 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono font-semibold text-foreground">{value}</span>
    </div>
  )
}
