"use server"

import { createClient } from "@/lib/supabase/server"
import { ROLE_HOME, usernameToEmail, type Role } from "@/lib/types"
import { redirect } from "next/navigation"

type AuthErrorLike = { status?: number; code?: string; message?: string }

function describeAuthError(error: unknown): string {
  const err = error as AuthErrorLike | null
  const message = String(err?.message ?? error ?? "")

  if (
    err?.status === 402 ||
    /exceed_egress_quota|egress quota|restricted due to the following violations/i.test(message)
  ) {
    return "Sign-in is unavailable: this Supabase project is suspended because it exceeded its egress quota. The project owner must upgrade the plan or remove the spend cap in the Supabase dashboard, then try again."
  }

  if (/email not confirmed/i.test(message)) {
    return "This account's email is not confirmed. Confirm the user in Supabase Dashboard > Authentication > Users, then try again."
  }

  if (
    /invalid login credentials|invalid_credentials|invalid password|user not found/i.test(message)
  ) {
    return "Invalid username or password."
  }

  if (err instanceof TypeError || /fetch|network|ECONN|Failed to fetch/i.test(message)) {
    return "Could not reach the authentication service. Check the Supabase URL and keys, then try again."
  }

  if (message) return `Sign-in failed: ${message}`
  return "Invalid username or password."
}

export async function loginAction(_prev: unknown, formData: FormData) {
  const username = String(formData.get("username") || "").trim()
  const password = String(formData.get("password") || "")

  if (!username || !password) {
    return { error: "Username and password are required." }
  }

  const email = usernameToEmail(username)
  const supabase = await createClient()

  let error: unknown = null
  try {
    const result = await supabase.auth.signInWithPassword({ email, password })
    error = result.error
  } catch (thrown) {
    error = thrown
  }

  if (error) {
    return { error: describeAuthError(error) }
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
