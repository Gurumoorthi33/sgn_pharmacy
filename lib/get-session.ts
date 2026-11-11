import { createClient } from "@/lib/supabase/server"
import { getUserId } from "@/lib/supabase/auth"
import { ROLE_HOME, type Role } from "@/lib/types"
import { redirect } from "next/navigation"

export async function requireRole(expected: Role) {
  const supabase = await createClient()
  const userId = await getUserId(supabase)
  if (!userId) redirect("/auth/login")

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, role, username, counter")
    .eq("id", userId)
    .maybeSingle()

  const role = profile?.role as Role | undefined
  // No token-system profile (e.g. an account from another app): no station.
  if (!role || !(role in ROLE_HOME)) redirect("/auth/login")

  // Send users to their own station if they hit the wrong one.
  if (role !== expected) redirect(ROLE_HOME[role])

  return {
    userId,
    role,
    fullName: profile?.full_name ?? "",
    username: profile?.username ?? "",
    counter: (profile?.counter ?? null) as number | null,
  }
}
