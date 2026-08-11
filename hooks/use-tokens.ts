"use client"

import { useCallback, useEffect, useState } from "react"
import { createClient } from "@/lib/supabase/client"
import type { Token } from "@/lib/types"

/**
 * Subscribes to today's tokens with Supabase Realtime and keeps a live list.
 * Falls back to a periodic refetch so screens stay in sync even if a realtime
 * event is missed.
 */
export function useTokens() {
  const [tokens, setTokens] = useState<Token[]>([])
  const [loading, setLoading] = useState(true)

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })

  const refetch = useCallback(async () => {
    const supabase = createClient()
    const { data } = await supabase
      .from("tokens")
      .select("*")
      .eq("service_date", today)
      .order("token_number", { ascending: true })
    if (data) setTokens(data as Token[])
    setLoading(false)
  }, [today])

  useEffect(() => {
    refetch()

    const supabase = createClient()
    const channel = supabase
      .channel("tokens-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "tokens" }, () => {
        refetch()
      })
      .subscribe()

    const interval = setInterval(refetch, 5000)

    return () => {
      supabase.removeChannel(channel)
      clearInterval(interval)
    }
  }, [refetch])

  return { tokens, loading, refetch }
}
