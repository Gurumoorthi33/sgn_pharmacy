"use server"

import { createClient } from "@/lib/supabase/server"
import { ROLE_HOME, usernameToEmail, type Role } from "@/lib/types"
import { redirect } from "next/navigation"

export async function loginAction(_prev: unknown, formData: FormData) {
  const username = String(formData.get("username") || "").trim()
  const password = String(formData.get("password") || "")

  if (!username || !password) {
    return { error: "Username and password are required." }
  }

  const email = usernameToEmail(username)
  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) {
    return { error: "Invalid username or password." }
  }

  const {
    data: { user },
  } = await supabase.auth.getUser()

  let role: Role = "entry"
  if (user) {
    const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single()
    if (profile?.role) role = profile.role as Role
  }

  redirect(ROLE_HOME[role])
}

export async function signOutAction() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect("/auth/login")
}
