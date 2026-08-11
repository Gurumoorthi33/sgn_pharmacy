"use server"

import { createClient } from "@/lib/supabase/server"
import type { Token } from "@/lib/types"

export async function generateTokenAction(): Promise<{ token?: Token; error?: string }> {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: "Not authenticated." }

  const { data, error } = await supabase.rpc("generate_token")
  if (error) return { error: error.message }

  return { token: data as Token }
}
