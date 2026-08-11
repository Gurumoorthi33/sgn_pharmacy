import { HOSPITAL_SHORT } from "@/lib/types"

/**
 * A single 30mm x 25mm thermal label for the Zebra ZD230.
 * Shows only the large token number (no barcode).
 */
export function TokenLabel({ tokenNumber }: { tokenNumber: number }) {
  return (
    <div className="token-label">
      <span className="token-label__hospital">{HOSPITAL_SHORT}</span>
      <span className="token-label__caption">TOKEN</span>
      <span className="token-label__number">{tokenNumber}</span>
    </div>
  )
}
