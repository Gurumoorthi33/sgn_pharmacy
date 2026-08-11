import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { ROLE_HOME, type Role } from "@/lib/types"

export default async function Home() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect("/auth/login")

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single()
  const role = (profile?.role ?? "entry") as Role
  redirect(ROLE_HOME[role])
}
