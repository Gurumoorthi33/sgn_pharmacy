import { requireRole } from "@/lib/get-session"
import { createClient } from "@/lib/supabase/server"
import { StationHeader } from "@/components/station-header"
import { DispensingPanel } from "@/components/dispensing/dispensing-panel"

export default async function DispensingPage() {
  const { fullName } = await requireRole("dispensing")

  const supabase = await createClient()
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })
  const { count } = await supabase
    .from("tokens")
    .select("id", { count: "exact", head: true })
    .eq("service_date", today)

  return (
    <div className="min-h-screen bg-secondary">
      <StationHeader title="Dispensing Station" subtitle="Token generation & label printing" fullName={fullName} />
      <DispensingPanel initialCount={count ?? 0} />
    </div>
  )
}
