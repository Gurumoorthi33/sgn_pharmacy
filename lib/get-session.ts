import { createClient } from "@/lib/supabase/server"
import { ROLE_HOME, type Role } from "@/lib/types"
import { redirect } from "next/navigation"

export async function requireRole(expected: Role) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect("/auth/login")

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, role, username, counter")
    .eq("id", user.id)
    .single()

  const role = (profile?.role ?? "entry") as Role

  // Send users to their own station if they hit the wrong one.
  if (role !== expected) redirect(ROLE_HOME[role])

  return {
    user,
    role,
    fullName: profile?.full_name ?? "",
    username: profile?.username ?? "",
    counter: (profile?.counter ?? null) as number | null,
  }
}
