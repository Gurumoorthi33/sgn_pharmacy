import { requireRole } from "@/lib/get-session"
import { StationHeader } from "@/components/station-header"
import { DispatchBoard } from "@/components/dispatch/dispatch-board"

export default async function DispatchPage() {
  const { fullName } = await requireRole("dispatch")
  return (
    <div className="min-h-screen bg-secondary">
      <StationHeader title="Dispatch Counter" subtitle="Hand over medicines to patients" fullName={fullName} />
      <DispatchBoard />
    </div>
  )
}
