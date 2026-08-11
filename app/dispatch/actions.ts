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

// Manually call a specific token to the dispatch counter (no auto FIFO).
export async function callDispatchAction(id: string): Promise<{ token?: Token | null; error?: string }> {
  try {
    const supabase = await client()
    const { data, error } = await supabase.rpc("call_dispatch", { p_id: id })
    if (error) return { error: error.message }
    return { token: data as Token | null }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export async function completeDispatchAction(id: string): Promise<{ error?: string }> {
  const supabase = await client()
  const { error } = await supabase.rpc("complete_dispatch", { p_id: id })
  return error ? { error: error.message } : {}
}

// Person didn't show up: park the token back in the queue (at the back) and move on.
export async function skipDispatchAction(id: string): Promise<{ error?: string }> {
  const supabase = await client()
  const { error } = await supabase.rpc("skip_dispatch", { p_id: id })
  return error ? { error: error.message } : {}
}

// Re-announce the token currently being served (fresh dispatch_called_at re-triggers the voice).
export async function recallDispatchAction(id: string): Promise<{ token?: Token | null; error?: string }> {
  try {
    const supabase = await client()
    const { data, error } = await supabase.rpc("recall_dispatch", { p_id: id })
    if (error) return { error: error.message }
    return { token: data as Token | null }
  } catch (e) {
    return { error: (e as Error).message }
  }
}
