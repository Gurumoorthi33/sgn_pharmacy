export type TokenStatus =
  | "pending_entry"
  | "entry_serving"
  | "entry_waiting"
  | "pending_payment"
  | "payment_serving"
  | "payment_waiting"
  | "pending_dispatch"
  | "dispatch_serving"
  | "completed"

export type Token = {
  id: string
  token_number: number
  service_date: string
  status: TokenStatus
  entry_counter: number | null
  created_at: string
  entry_called_at: string | null
  entry_completed_at: string | null
  payment_called_at: string | null
  payment_completed_at: string | null
  dispatch_called_at: string | null
  dispatch_requeued_at: string | null
  completed_at: string | null
}

export type Role = "dispensing" | "entry" | "payment" | "dispatch" | "display" | "admin"

export const ROLE_HOME: Record<Role, string> = {
  dispensing: "/dispensing",
  entry: "/entry",
  payment: "/payment",
  dispatch: "/dispatch",
  display: "/display",
  admin: "/admin",
}

export const ROLE_LABELS: Record<Role, string> = {
  dispensing: "Dispensing (Token Generation)",
  entry: "Entry Counter",
  payment: "Payment Counter",
  dispatch: "Dispatch Counter",
  display: "Display Board",
  admin: "Administrator",
}

// Usernames log in via a synthetic email so Supabase Auth can be used unchanged.
export const USERNAME_EMAIL_DOMAIN = "sgn.local"
export const usernameToEmail = (username: string) =>
  `${username.trim().toLowerCase()}@${USERNAME_EMAIL_DOMAIN}`

export const DISPATCH_RESET_TIME = "23:40" // 11:40 PM IST daily reset
export const REPORT_RECIPIENTS = ["supervisor.trc@sgnpharmacy.com", "manager.trc@sgnpharmacy.com"]

export const HOSPITAL_NAME = "Trichy SRM Medical College Hospital and Research Centre"
export const HOSPITAL_SHORT = "Trichy SRM Medical College Hospital and Research Centre"
export const SYSTEM_NAME = "SGN Token System"
