"use client"

import Image from "next/image"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { HOSPITAL_NAME, SYSTEM_NAME } from "@/lib/types"
import { unlockAndPlay } from "@/lib/audio-unlock"
import { Volume2 } from "lucide-react"

type DisplayRow = {
  station: "entry" | "payment" | "dispatch"
  counter: number | null
  token_number: number
  called_at: string | null
  // Recall signals — updated by recall_entry / recall_payment / recall_dispatch
  // RPCs without changing the token number. The display watcher keys off these
  // to re-announce without duplicating the number-change trigger.
  recalled_at: string | null
}

// One unit of work for the global FIFO audio queue.
// - dispatch: /audio/ta/announcement-{N}.mp3
// - entry:    /audio/ta/entry/counter-{C}-token-{N}.mp3
// - payment:  /audio/ta/payment/token-{N}.mp3
type QueueItem = {
  type: "dispatch" | "entry" | "payment"
  counterNumber?: number // only for entry
  tokenNumber: number
}

const STRINGS = {
  en: {
    hospital: HOSPITAL_NAME,
    system: SYSTEM_NAME,
    nowServing: "Now Serving",
    entry: "Entry Counter",
    payment: "Payment Counter",
    dispatch: "Dispatch Counter",
    token: "Token",
    idle: "Please wait for your token to be called",
    waiting: "—",
  },
  ta: {
    hospital: "திருச்சி எஸ்ஆர்எம் மருத்துவக் கல்லூரி மருத்துவமனை மற்றும் ஆராய்ச்சி மையம்",
    system: "எஸ்ஜிஎன் டோக்கன் அமைப்பு",
    nowServing: "தற்போது அழைக்கப்படுகிறது",
    entry: "நுழைவு கவுண்டர்",
    payment: "கட்டண கவுண்டர்",
    dispatch: "மருந்து வழங்கும் கவுண்டர்",
    token: "டோக்கன்",
    idle: "உங்கள் டோக்கன் அழைக்கப்படும் வரை காத்திருக்கவும்",
    waiting: "—",
  },
} as const

type Lang = keyof typeof STRINGS

export function DisplayBoard() {
  const supabase = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<DisplayRow[]>([])
  const [lang, setLang] = useState<Lang>("en")
  const [now, setNow] = useState<Date | null>(null)
  const [soundOn, setSoundOn] = useState(false)

  // Dispatch: keyed off called_at (changes on every call AND recall)
  const lastDispatchCallRef = useRef<string | null>(null)
  const dispatchInitializedRef = useRef(false)

  // Entry: number-change trigger (one ref per counter)
  const lastEntryNumberRefs = useRef<Record<number, number | null>>({})
  const entryInitializedRef = useRef<Set<number>>(new Set())

  // Entry: recall trigger (one ref per counter — keyed off recalled_at)
  const lastEntryRecallRefs = useRef<Record<number, string | null>>({})

  // Payment: number-change trigger (mirrors entry pattern)
  const lastPaymentNumberRef = useRef<number | null>(null)
  const paymentInitializedRef = useRef(false)

  // Payment: recall trigger (keyed off recalled_at)
  const lastPaymentRecallRef = useRef<string | null>(null)

  const audioCtxRef = useRef<AudioContext | null>(null)
  const sharedAudioRef = useRef<HTMLAudioElement | null>(null)
  const audioQueueRef = useRef<QueueItem[]>([])
  const isPlayingRef = useRef(false)

  // Load + subscribe to the live board
  useEffect(() => {
    let active = true
    const load = async () => {
      const { data } = await supabase.rpc("display_board")
      if (active && data) setRows(data as DisplayRow[])
    }
    load()

    const channel = supabase
      .channel("display-tokens")
      .on("postgres_changes", { event: "*", schema: "public", table: "tokens" }, () => load())
      .subscribe()

    const poll = setInterval(load, 3000)
    return () => {
      active = false
      clearInterval(poll)
      supabase.removeChannel(channel)
    }
  }, [supabase])

  // Auto language switch every 7s
  useEffect(() => {
    const id = setInterval(() => setLang((l) => (l === "en" ? "ta" : "en")), 7000)
    return () => clearInterval(id)
  }, [])

  // Clock: avoid hydration mismatches by waiting until the client has mounted
  useEffect(() => {
    const updateNow = () => setNow(new Date())
    updateNow()
    const id = setInterval(updateNow, 1000)
    return () => clearInterval(id)
  }, [])

  // Lazily create or return the single AudioContext shared by the chime and
  // announcement playback.
  const getAudioContext = useCallback(() => {
    if (audioCtxRef.current) {
      console.log("[audio] getAudioContext: reusing existing ctx, state =", audioCtxRef.current.state)
      return audioCtxRef.current
    }
    const WebkitAudioWindow = window as Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext }
    const Ctx = window.AudioContext || WebkitAudioWindow.webkitAudioContext
    if (!Ctx) {
      console.error("[audio] getAudioContext: no AudioContext or webkitAudioContext available")
      return null
    }
    try {
      audioCtxRef.current = new Ctx()
      console.log("[audio] getAudioContext: created NEW ctx, state =", audioCtxRef.current.state)
    } catch (err) {
      console.error("[audio] getAudioContext: failed to create ctx:", err)
      audioCtxRef.current = null
    }
    return audioCtxRef.current
  }, [])

  // Play a two-note chime on the shared AudioContext.
  const playChime = useCallback(() => {
    const ctx = getAudioContext()
    if (!ctx) {
      console.warn("[audio] playChime: no AudioContext, aborting")
      return
    }
    console.log("[audio] playChime: ctx.state =", ctx.state, "ctx.currentTime =", ctx.currentTime)
    const notes = [880, 1174]
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = "sine"
      osc.frequency.value = freq
      osc.connect(gain)
      gain.connect(ctx.destination)
      const start = ctx.currentTime + i * 0.18
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(0.3, start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35)
      console.log("[audio] playChime: scheduling note", i, "freq =", freq, "start =", start)
      osc.start(start)
      osc.stop(start + 0.36)
    })
  }, [getAudioContext])

  // Global FIFO audio queue. Every announcement — Dispatch, Entry, AND Payment —
  // is pushed here and played strictly one-at-a-time (chime + speech as one unit).
  const processQueueRef = useRef<() => void>(() => {})
  const processQueue = useCallback(() => {
    const audio = sharedAudioRef.current
    if (isPlayingRef.current) return
    if (!audio) {
      console.error("[audio] processQueue: no shared audio element mounted")
      return
    }
    const next = audioQueueRef.current.shift()
    if (!next) return

    isPlayingRef.current = true
    console.log("[audio] processQueue: playing", next, "queue =", audioQueueRef.current.length)

    void playChime()
    setTimeout(() => {
      // Resolve the pre-generated MP3 path for each station type.
      const path =
        next.type === "dispatch"
          ? `/audio/ta/announcement-${next.tokenNumber}.mp3`
          : next.type === "payment"
            ? `/audio/ta/payment/token-${next.tokenNumber}.mp3`
            : `/audio/ta/entry/counter-${next.counterNumber}-token-${next.tokenNumber}.mp3`
      console.log("[audio] processQueue: item type =", next.type, "resolved path =", path)

      // Belt-and-suspenders: if the shared element somehow ended up mid-play,
      // defer rather than reassigning .src under a pending play() — that is
      // what causes AbortError on TV WebKit.
      if (!audio.paused) {
        console.log("[audio] processQueue: shared element busy, deferring", next)
        audioQueueRef.current.unshift(next)
        isPlayingRef.current = false
        setTimeout(() => processQueueRef.current(), 300)
        return
      }

      audio.setAttribute("src", path)
      audio.load()
      audio.play().catch((err) => {
        console.error("[audio] queue playback failed:", err)
        isPlayingRef.current = false
        processQueueRef.current()
      })

      audio.onended = () => {
        isPlayingRef.current = false
        processQueueRef.current()
      }
    }, 450)
  }, [playChime])

  // Keep the latest processQueue closure accessible to its own async handlers.
  useEffect(() => {
    processQueueRef.current = processQueue
  }, [processQueue])

  // Push an announcement onto the global queue and kick the sequential player.
  // Includes a queue-size safety cap: if the pending queue exceeds the cap,
  // drop the oldest excess entry and log a warning.
  const enqueueAnnouncement = useCallback(
    (item: QueueItem) => {
      const MAX_PENDING = 12
      while (audioQueueRef.current.length >= MAX_PENDING) {
        const dropped = audioQueueRef.current.shift()
        console.warn("[audio] queue overflow: dropping oldest announcement", dropped)
      }
      audioQueueRef.current.push(item)
      processQueue()
    },
    [processQueue],
  )

  // ─── DISPATCH WATCHER ────────────────────────────────────────────────────
  // Watch the dispatch counter; announce whenever called_at changes — a NEW
  // token OR the same token re-called ("Call again").
  useEffect(() => {
    const dispatch = rows.find((r) => r.station === "dispatch")
    const current = dispatch?.token_number ?? null
    const calledAt = dispatch?.called_at ?? null

    if (!dispatchInitializedRef.current) {
      lastDispatchCallRef.current = calledAt
      dispatchInitializedRef.current = true
      return
    }

    if (current !== null && calledAt !== null && calledAt !== lastDispatchCallRef.current) {
      lastDispatchCallRef.current = calledAt
      if (soundOn) enqueueAnnouncement({ type: "dispatch", tokenNumber: current })
    }
  }, [rows, soundOn, enqueueAnnouncement])

  // ─── ENTRY NUMBER-CHANGE WATCHER ─────────────────────────────────────────
  // Watch each entry counter; announce whenever its token_number changes to a
  // NEW value. This is the primary trigger (new call / held-token recall).
  // Does NOT update lastEntryRecallRefs — that ref is only touched by the
  // recall watcher below, so the two triggers stay independent.
  useEffect(() => {
    const entryRows = rows.filter((r) => r.station === "entry" && r.counter != null)
    console.log("[entry-watch] rows for entry stations:", entryRows)
    for (const row of entryRows) {
      const counter = Number(row.counter!)
      const current = row.token_number

      console.log(
        `[entry-watch] counter ${counter}: current=${current}, lastAnnounced=${lastEntryNumberRefs.current[counter]}`,
      )

      if (!entryInitializedRef.current.has(counter)) {
        lastEntryNumberRefs.current[counter] = current
        entryInitializedRef.current.add(counter)
        console.log(`[entry-watch] counter ${counter}: initialized, baseline=${current}`)
        continue
      }

      if (current !== null && current !== lastEntryNumberRefs.current[counter]) {
        // Synchronous ref update before enqueue — closes the realtime-vs-polling
        // duplicate-trigger race.
        lastEntryNumberRefs.current[counter] = current
        console.log(
          `[entry-watch] enqueueing:`,
          { type: "entry", counterNumber: counter, tokenNumber: current },
          "soundOn =",
          soundOn,
        )
        if (soundOn) enqueueAnnouncement({ type: "entry", counterNumber: counter, tokenNumber: current })
      }
    }
  }, [rows, soundOn, enqueueAnnouncement])

  // ─── ENTRY RECALL WATCHER ────────────────────────────────────────────────
  // Watch each entry counter's recalled_at; re-announce the SAME token when
  // the staff presses "Call Again". Keys off recalled_at (not token_number),
  // so it fires even though the number hasn't changed. Does NOT touch
  // lastEntryNumberRefs, keeping the two triggers completely independent.
  useEffect(() => {
    const entryRows = rows.filter((r) => r.station === "entry" && r.counter != null)
    for (const row of entryRows) {
      const counter = Number(row.counter!)
      const current = row.token_number
      const recalledAt = row.recalled_at ?? null

      // Skip counters we haven't initialized yet (the number-change watcher
      // handles first-sight initialization).
      if (!entryInitializedRef.current.has(counter)) continue

      // Initialize the recall ref on first sight of this counter's recalled_at.
      if (!(counter in lastEntryRecallRefs.current)) {
        lastEntryRecallRefs.current[counter] = recalledAt
        continue
      }

      if (
        current !== null &&
        recalledAt !== null &&
        recalledAt !== lastEntryRecallRefs.current[counter]
      ) {
        // Synchronous update before enqueue (same race-condition fix as the
        // number-change watcher).
        lastEntryRecallRefs.current[counter] = recalledAt
        console.log(
          `[entry-recall] counter ${counter}: re-announcing token ${current} (recalled_at=${recalledAt})`,
        )
        // Recall does NOT update lastEntryNumberRefs — the number hasn't
        // changed, so the number-change watcher should remain unaffected.
        if (soundOn) enqueueAnnouncement({ type: "entry", counterNumber: counter, tokenNumber: current })
      }
    }
  }, [rows, soundOn, enqueueAnnouncement])

  // ─── PAYMENT NUMBER-CHANGE WATCHER ───────────────────────────────────────
  // Watch the payment counter; announce whenever its token_number changes to a
  // NEW value (normal call or held-token recall from the on-hold list).
  useEffect(() => {
    const payment = rows.find((r) => r.station === "payment")
    const current = payment?.token_number ?? null

    if (!paymentInitializedRef.current) {
      lastPaymentNumberRef.current = current
      paymentInitializedRef.current = true
      return
    }

    if (current !== null && current !== lastPaymentNumberRef.current) {
      // Synchronous update before enqueue.
      lastPaymentNumberRef.current = current
      console.log(`[payment-watch] new token ${current}, enqueueing`)
      if (soundOn) enqueueAnnouncement({ type: "payment", tokenNumber: current })
    }
  }, [rows, soundOn, enqueueAnnouncement])

  // ─── PAYMENT RECALL WATCHER ──────────────────────────────────────────────
  // Watch the payment counter's recalled_at; re-announce the SAME token when
  // the staff presses "Call Again". Mirrors the Entry recall pattern exactly.
  useEffect(() => {
    const payment = rows.find((r) => r.station === "payment")
    const current = payment?.token_number ?? null
    const recalledAt = payment?.recalled_at ?? null

    if (!paymentInitializedRef.current) return // wait for number-change init first

    // Initialize the recall ref on first sight.
    if (lastPaymentRecallRef.current === null && recalledAt === null) {
      lastPaymentRecallRef.current = recalledAt
      return
    }
    if (lastPaymentRecallRef.current === null) {
      lastPaymentRecallRef.current = recalledAt
      return
    }

    if (
      current !== null &&
      recalledAt !== null &&
      recalledAt !== lastPaymentRecallRef.current
    ) {
      // Synchronous update before enqueue.
      lastPaymentRecallRef.current = recalledAt
      console.log(
        `[payment-recall] re-announcing token ${current} (recalled_at=${recalledAt})`,
      )
      if (soundOn) enqueueAnnouncement({ type: "payment", tokenNumber: current })
    }
  }, [rows, soundOn, enqueueAnnouncement])

  const enableSound = () => {
    console.log("[audio] enableSound: user gesture fired")
    const ctx = getAudioContext()
    if (ctx) {
      console.log("[audio] enableSound: ctx.state BEFORE resume =", ctx.state)
      try {
        const p = ctx.resume()
        console.log("[audio] enableSound: ctx.resume() returned promise")
        p.then(
          () => console.log("[audio] enableSound: ctx.resume() RESOLVED, state =", ctx.state),
          (err) => console.error("[audio] enableSound: ctx.resume() REJECTED:", err),
        )
      } catch (err) {
        console.error("[audio] enableSound: resume threw:", err)
      }
    } else {
      console.warn("[audio] enableSound: no AudioContext available")
    }
    playChime()

    const mediaElement = sharedAudioRef.current
    if (mediaElement) {
      void unlockAndPlay({
        audioElement: mediaElement,
        audioContext: ctx,
        sourceUrl: `/audio/ta/announcement-5.mp3`,
      })
    } else {
      console.warn("[audio] enableSound: no shared audio element mounted yet to unlock")
    }

    setSoundOn(true)
  }

  const timeText = now
    ? now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "--:--:--"
  const dateText = now
    ? now.toLocaleDateString(lang === "ta" ? "ta-IN" : "en-GB", {
        weekday: "long",
        day: "numeric",
        month: "long",
      })
    : "--"

  const t = STRINGS[lang]

  const entry1 = rows.find((r) => r.station === "entry" && r.counter === 1) ?? null
  const entry2 = rows.find((r) => r.station === "entry" && r.counter === 2) ?? null
  const entry3 = rows.find((r) => r.station === "entry" && r.counter === 3) ?? null
  const paymentRow = rows.find((r) => r.station === "payment") ?? null
  const dispatchRow = rows.find((r) => r.station === "dispatch") ?? null

  const stationTitle = (s: DisplayRow["station"], counter: number | null) => {
    if (s === "entry") return `${t.entry} ${counter ?? ""}`.trim()
    if (s === "payment") return t.payment
    return t.dispatch
  }

  return (
    <main className="flex min-h-screen flex-col bg-white text-black">
      {/* Hidden announcement player. Follows TV-browser media best practices:
          playsinline + preload=auto + crossorigin + a fallback <source> list
          (MP3 prioritized over WAV). It is intentionally NOT autoplaying — all
          audio starts from an explicit user interaction (see enableSound).
          ONE shared element serves the entire global queue: since only one
          announcement plays at a time (chime + speech), no per-counter
          elements are needed. */}
      <audio
        ref={sharedAudioRef}
        preload="auto"
        playsInline
        crossOrigin="anonymous"
        className="hidden"
      >
        {/* Static fallback sources. MP3 prioritized; processQueue overrides the
            active source at play time, so these only matter for the initial
            decode/hardware-channel bind on TVs that preload. */}
        <source src="/audio/ta/announcement-5.mp3" type="audio/mpeg" />
        <source src="/audio/ta/announcement-50.mp3" type="audio/mpeg" />
      </audio>

      {/* Header */}
      <header className="flex items-center justify-between gap-4 border-b-2 border-black/10 px-8 py-4">
        <div className="flex items-center gap-4">
          <Image src="/sgn-logo.png" alt="SGN Pharmacy" width={200} height={80} priority className="h-14 w-auto" />
          <div>
            <h1 className="text-balance text-xl font-bold leading-tight text-black lg:text-2xl">{t.hospital}</h1>
            <p className="text-sm font-medium text-[#1d4ed8]">{t.system}</p>
          </div>
        </div>
        <div className="flex items-center gap-6">
          {!soundOn ? (
            <button
              type="button"
              onClick={enableSound}
              className="flex items-center gap-2 rounded-lg bg-[#1d4ed8] px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[#1d4ed8]/90"
            >
              <Volume2 className="h-4 w-4" aria-hidden="true" />
              Enable announcements
            </button>
          ) : null}
          <div className="text-right">
            <div className="font-mono text-3xl font-bold tabular-nums text-black">
              {timeText}
            </div>
            <div className="text-sm text-black/50">{dateText}</div>
          </div>
        </div>
      </header>

      {/* Five-counter grid */}
      <section className="grid flex-1 grid-cols-2 gap-4 border-t-2 border-black/10 p-6 lg:grid-cols-5">
        <CounterTile label={stationTitle("entry", 1)} value={entry1?.token_number ?? null} accent="blue" empty={t.waiting} />
        <CounterTile label={stationTitle("entry", 2)} value={entry2?.token_number ?? null} accent="blue" empty={t.waiting} />
        <CounterTile label={stationTitle("entry", 3)} value={entry3?.token_number ?? null} accent="blue" empty={t.waiting} />
        <CounterTile label={t.payment} value={paymentRow?.token_number ?? null} accent="black" empty={t.waiting} />
        <CounterTile label={t.dispatch} value={dispatchRow?.token_number ?? null} accent="green" empty={t.waiting} highlight />
      </section>
    </main>
  )
}

function CounterTile({
  label,
  value,
  accent,
  empty,
  highlight,
}: {
  label: string
  value: number | null
  accent: "blue" | "black" | "green"
  empty: string
  highlight?: boolean
}) {
  const color = accent === "blue" ? "text-[#1d4ed8]" : accent === "green" ? "text-[#15803d]" : "text-black"
  const ring = highlight ? "border-[#15803d] bg-[#15803d]/5" : "border-black/10 bg-black/[0.02]"

  return (
    <div className={`flex flex-col items-center justify-center rounded-2xl border-2 p-5 text-center ${ring}`}>
      <div className="mb-2 text-base font-bold uppercase tracking-wide text-black/70 text-balance">{label}</div>
      {value !== null ? (
        <span className={`font-mono text-7xl font-extrabold leading-none tabular-nums ${color}`}>{value}</span>
      ) : (
        <span className="font-mono text-6xl font-bold leading-none tabular-nums text-black/20">{empty}</span>
      )}
    </div>
  )
}
