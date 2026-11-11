"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js"
import { createClient } from "@/lib/supabase/client"
import type { Token } from "@/lib/types"

/**
 * Live list of today's tokens.
 *
 * Egress-conscious design:
 *  - One fetch of only the columns the UI reads, filtered to today (and, by
 *    default, to tokens that are still in the queue).
 *  - Supabase Realtime events are APPLIED to local state (insert/update/delete)
 *    instead of triggering a full refetch.
 *  - A full re-sync only happens on (re)connect, when the tab becomes visible
 *    again, and as a slow safety net every few minutes.
 *  - Fast polling only runs while the realtime connection is down, and is
 *    paused while the tab is hidden.
 */

// Columns the station boards and admin dashboard actually read.
const COLUMNS =
  "id, token_number, service_date, status, entry_counter, entry_completed_at, payment_completed_at, dispatch_requeued_at"

const TIMESTAMP_FIELDS = [
  "created_at",
  "entry_called_at",
  "entry_recalled_at",
  "entry_completed_at",
  "payment_called_at",
  "payment_recalled_at",
  "payment_completed_at",
  "dispatch_called_at",
  "dispatch_requeued_at",
  "completed_at",
] as const

const SAFETY_RESYNC_MS = 5 * 60_000 // while realtime is healthy
const FALLBACK_POLL_MS = 10_000 // only while realtime is down
const ACTION_CONFIRM_MS = 2_500 // after a button press, fetch only if no realtime event arrived
const MAX_ROWS = 5000

const todayIST = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })

// REST and Realtime serialise timestamps slightly differently; the boards sort
// by comparing timestamp strings, so normalise both sources to the same format.
function normalize(row: Record<string, unknown>): Token {
  const out: Record<string, unknown> = { ...row }
  for (const f of TIMESTAMP_FIELDS) {
    const v = out[f]
    if (typeof v === "string" && v) {
      const d = new Date(v.includes("T") || v.endsWith("Z") ? v : v.replace(" ", "T"))
      if (!Number.isNaN(d.getTime())) out[f] = d.toISOString()
    }
  }
  return out as Token
}

const byNumber = (a: Token, b: Token) => a.token_number - b.token_number

type Options = {
  /** Keep completed tokens too (needed for the admin day statistics). */
  includeCompleted?: boolean
}

export function useTokens({ includeCompleted = false }: Options = {}) {
  const [tokens, setTokens] = useState<Token[]>([])
  const [loading, setLoading] = useState(true)
  const [today, setToday] = useState(todayIST)

  const liveRef = useRef(false) // realtime channel currently SUBSCRIBED
  const lastEventAtRef = useRef(0)
  const fetchRef = useRef<() => Promise<void>>(async () => {})
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Roll over to the new service date at midnight (local check, no network).
  useEffect(() => {
    const id = setInterval(() => {
      const d = todayIST()
      setToday((prev) => (prev === d ? prev : d))
    }, 60_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const supabase = createClient()
    let active = true
    let inFlight = false
    let again = false // a re-sync was requested while one was in flight
    // Realtime events that arrive while a snapshot fetch is in flight are
    // re-applied on top of the snapshot so nothing is lost.
    let buffered: RealtimePostgresChangesPayload<Record<string, unknown>>[] | null = null

    const keep = (t: Token) => t.service_date === today && (includeCompleted || t.status !== "completed")

    const apply = (list: Token[], p: RealtimePostgresChangesPayload<Record<string, unknown>>): Token[] => {
      if (p.eventType === "DELETE") {
        const id = (p.old as { id?: string }).id
        return id ? list.filter((t) => t.id !== id) : list
      }
      const row = normalize(p.new)
      const rest = list.filter((t) => t.id !== row.id)
      if (!keep(row)) return rest
      return [...rest, row].sort(byNumber)
    }

    const fetchSnapshot = async (): Promise<void> => {
      if (inFlight) {
        again = true
        return
      }
      inFlight = true
      again = false
      buffered = []
      let query = supabase.from("tokens").select(COLUMNS).eq("service_date", today)
      if (!includeCompleted) query = query.neq("status", "completed")
      const { data, error } = await query.order("token_number", { ascending: true }).limit(MAX_ROWS)
      const pending = buffered
      buffered = null
      inFlight = false
      if (!active) return
      if (!error && data) {
        let list = (data as unknown as Record<string, unknown>[]).map(normalize)
        for (const p of pending) list = apply(list, p)
        setTokens(list)
      }
      setLoading(false)
      if (again) return fetchSnapshot()
    }
    fetchRef.current = fetchSnapshot

    const onChange = (p: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
      lastEventAtRef.current = Date.now()
      if (buffered) buffered.push(p)
      setTokens((list) => apply(list, p))
    }

    fetchSnapshot()

    let timer: ReturnType<typeof setTimeout> | null = null
    // Assigned below; called whenever the connection state changes.
    let schedule = () => {}

    const channel = supabase
      .channel(`tokens-${today}-${includeCompleted ? "all" : "active"}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "tokens", filter: `service_date=eq.${today}` },
        onChange,
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "tokens", filter: `service_date=eq.${today}` },
        onChange,
      )
      // DELETE payloads only carry the primary key, so they can't be filtered
      // by date; they only happen at the nightly reset.
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "tokens" }, onChange)
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          const wasLive = liveRef.current
          liveRef.current = true
          // (Re)connected: re-sync once to cover anything missed while down.
          if (!wasLive) fetchSnapshot()
        } else {
          liveRef.current = false
        }
        if (active) schedule()
      })

    // Timers: slow safety re-sync while live, faster polling only while down.
    // Everything pauses while the tab is hidden.
    schedule = () => {
      if (timer) clearTimeout(timer)
      timer = null
      if (document.visibilityState !== "visible") return
      timer = setTimeout(
        () => {
          fetchSnapshot().finally(() => active && schedule())
        },
        liveRef.current ? SAFETY_RESYNC_MS : FALLBACK_POLL_MS,
      )
    }
    schedule()

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        fetchSnapshot()
        schedule()
      } else if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
    document.addEventListener("visibilitychange", onVisibility)

    return () => {
      active = false
      liveRef.current = false
      if (timer) clearTimeout(timer)
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
      document.removeEventListener("visibilitychange", onVisibility)
      supabase.removeChannel(channel)
    }
  }, [today, includeCompleted])

  // Called by the boards after a button press. With realtime healthy the change
  // arrives as an event within milliseconds, so only fetch if it doesn't.
  const refetch = useCallback(() => {
    if (!liveRef.current) {
      void fetchRef.current()
      return
    }
    const calledAt = Date.now()
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
    confirmTimerRef.current = setTimeout(() => {
      if (lastEventAtRef.current < calledAt) void fetchRef.current()
    }, ACTION_CONFIRM_MS)
  }, [])

  return { tokens, loading, refetch }
}
