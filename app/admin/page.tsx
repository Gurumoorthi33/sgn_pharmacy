import { requireRole } from "@/lib/get-session"
import { StationHeader } from "@/components/station-header"
import { AdminDashboard } from "@/components/admin/admin-dashboard"

export default async function AdminPage() {
  const { fullName } = await requireRole("admin")
  return (
    <div className="min-h-screen bg-secondary">
      <StationHeader title="Admin Dashboard" subtitle="Live performance and daily reports" fullName={fullName} />
      <AdminDashboard />
    </div>
  )
}
