import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { ROLE_HOME, type Role } from "@/lib/types"

export default async function Home() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect("/auth/login")

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle()
  const role = profile?.role as Role | undefined
  // No token-system profile (e.g. an account from another app): no station.
  if (!role || !(role in ROLE_HOME)) redirect("/auth/login")
  redirect(ROLE_HOME[role])
}
