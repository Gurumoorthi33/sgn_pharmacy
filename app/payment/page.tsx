import { requireRole } from "@/lib/get-session"
import { StationHeader } from "@/components/station-header"
import { PaymentBoard } from "@/components/payment/payment-board"

export default async function PaymentPage() {
  const { fullName } = await requireRole("payment")
  return (
    <div className="min-h-screen bg-secondary">
      <StationHeader title="Payment Counter" subtitle="Collect payment for entered tokens" fullName={fullName} />
      <PaymentBoard />
    </div>
  )
}
