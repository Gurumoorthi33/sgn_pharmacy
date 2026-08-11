"use server"

import { createClient } from "@/lib/supabase/server"
import type { Token } from "@/lib/types"

async function client() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")
  return supabase
}

export async function callNextEntryAction(counter: number): Promise<{ token?: Token | null; error?: string }> {
  try {
    const supabase = await client()
    const { data, error } = await supabase.rpc("call_next_entry", { p_counter: counter })
    if (error) return { error: error.message }
    return { token: data as Token | null }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export async function completeEntryAction(id: string): Promise<{ error?: string }> {
  const supabase = await client()
  const { error } = await supabase.rpc("complete_entry", { p_id: id })
  return error ? { error: error.message } : {}
}

// Hold the currently-serving token AND immediately call the next fresh token.
export async function waitAndNextEntryAction(
  id: string,
  counter: number,
): Promise<{ token?: Token | null; error?: string }> {
  try {
    const supabase = await client()
    const { data, error } = await supabase.rpc("wait_and_next_entry", { p_id: id, p_counter: counter })
    if (error) return { error: error.message }
    return { token: data as Token | null }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// Recall a specific held token to this counter (only if the counter is free).
export async function callEntryTokenAction(
  id: string,
  counter: number,
): Promise<{ token?: Token | null; error?: string }> {
  try {
    const supabase = await client()
    const { data, error } = await supabase.rpc("call_entry_token", { p_id: id, p_counter: counter })
    if (error) return { error: error.message }
    return { token: data as Token | null }
  } catch (e) {
    return { error: (e as Error).message }
  }
}
