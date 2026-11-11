"use server"

import { createClient } from "@/lib/supabase/server"
import { getUserId } from "@/lib/supabase/auth"
import type { Token } from "@/lib/types"

export async function generateTokenAction(): Promise<{ token?: Token; error?: string }> {
  const supabase = await createClient()

  if (!(await getUserId(supabase))) return { error: "Not authenticated." }

  const { data, error } = await supabase.rpc("generate_token")
  if (error) return { error: error.message }

  return { token: data as Token }
}
