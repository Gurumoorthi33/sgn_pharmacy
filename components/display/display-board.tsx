"use client"

import Image from "next/image"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { HOSPITAL_NAME, SYSTEM_NAME } from "@/lib/types"
import { Volume2, AlertTriangle } from "lucide-react"

type DisplayRow = {
  station: "entry" | "payment" | "dispatch"
  counter: number | null
  token_number: number
  called_at: string | null
  recalled_at: string | null
}

// One unit of work for the global FIFO audio queue.
// - dispatch: Token எண் {N}, தயவுசெய்து மருந்து வழங்கும் கவுண்டருக்கு வரவும்
// - entry:    Token எண் {N}, பதிவு கவுண்டர் {C}-க்கு வரவும்
// - payment:  Token எண் {N}, தயவுசெய்து பணம் செலுத்தும் கவுண்டருக்கு வரவும்
type QueueItem = {
  type: "dispatch" | "entry" | "payment"
  counterNumber?: number // only for entry
  tokenNumber: number
  sourceKey: string // e.g. "dispatch", "entry-1", "entry-2", "entry-3", "payment"
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
  const [ttsAvailable, setTtsAvailable] = useState<boolean | null>(null)

  // Dispatch: keyed off called_at (changes on every call AND recall)
  const lastDispatchCallRef = useRef<string | null>(null)
  const dispatchInitializedRef = useRef(false)

  // Entry: number-change trigger (one ref per counter)
  const lastEntryNumberRefs = useRef<Record<number, number | null>>({})
  const entryInitializedRef = useRef<Set<number>>(new Set())

  // Entry: recall trigger (one ref per counter — keyed off recalled_at)
  const lastEntryRecallRefs = useRef<Record<number, string | null>>({})

  // Payment: number-change trigger
  const lastPaymentNumberRef = useRef<number | null>(null)
  const paymentInitializedRef = useRef(false)

  // Payment: recall trigger (keyed off recalled_at)
  const lastPaymentRecallRef = useRef<string | null>(null)

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

  // Feature-detect Tamil TTS on mount. SpeechSynthesis voices load
  // asynchronously; we check both on mount and after voiceschanged fires.
  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      setTtsAvailable(false)
      return
    }

    const checkVoices = () => {
      const voices = speechSynthesis.getVoices()
      console.log("[tts] available voices:", voices.map((v) => `${v.name} (${v.lang})`))
      const hasTamil = voices.some((v) => v.lang.startsWith("ta"))
      console.log("[tts] Tamil voice available:", hasTamil)
      setTtsAvailable(hasTamil)
    }

    // Check immediately
    checkVoices()

    // Some browsers fire voiceschanged after the list populates
    speechSynthesis.addEventListener("voiceschanged", checkVoices)
    return () => speechSynthesis.removeEventListener("voiceschanged", checkVoices)
  }, [])

  // Speak an announcement using speechSynthesis, returning a Promise that
  // resolves when playback finishes (or errors). Never rejects — errors just
  // resolve so the queue continues.
  const speakAnnouncement = useCallback((text: string): Promise<void> => {
    return new Promise<void>((resolve) => {
      if (!("speechSynthesis" in window)) {
        console.error("[tts] speechSynthesis not available")
        resolve()
        return
      }

      console.log("[tts] speaking:", text)
      const utterance = new SpeechSynthesisUtterance(text)
      const voices = speechSynthesis.getVoices()
      const tamilVoice = voices.find((v) => v.lang.startsWith("ta"))
      if (tamilVoice) {
        console.log("[tts] using voice:", tamilVoice.name, tamilVoice.lang)
        utterance.voice = tamilVoice
      } else {
        console.warn("[tts] no Tamil voice found, using default")
      }
      utterance.lang = "ta-IN"
      utterance.rate = 0.85

      utterance.onend = () => {
        console.log("[tts] utterance ended")
        resolve()
      }
      utterance.onerror = (e) => {
        console.error("[tts] utterance error:", e)
        resolve() // never stall the queue on failure
      }

      speechSynthesis.speak(utterance)
    })
  }, [])

  // Play a two-note chime using Web Audio API (pure tones, no media element).
  const playChime = useCallback(() => {
    if (typeof window === "undefined") return

    const WebkitAudioWindow = window as Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext }
    const Ctx = window.AudioContext || WebkitAudioWindow.webkitAudioContext
    if (!Ctx) {
      console.warn("[audio] no AudioContext available")
      return
    }

    let ctx: AudioContext
    try {
      ctx = new Ctx()
    } catch (err) {
      console.error("[audio] failed to create AudioContext:", err)
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
      osc.start(start)
      osc.stop(start + 0.36)
    })
  }, [])

  // Global FIFO audio queue. Every announcement — Dispatch, Entry, AND Payment —
  // is pushed here and played strictly one-at-a-time (chime + speech as one unit).
  const processQueueRef = useRef<() => void>(() => {})
  const processQueue = useCallback(() => {
    if (isPlayingRef.current) return
    const next = audioQueueRef.current.shift()
    if (!next) return

    isPlayingRef.current = true
    console.log("[audio] processQueue: playing", next, "queue =", audioQueueRef.current.length)

    // Build the Tamil announcement text per counter type
    let text = ""
    if (next.type === "dispatch") {
      text = `Token எண் ${next.tokenNumber}, மருந்து வழங்கும் கவுண்டருக்கு வரவும்`
    } else if (next.type === "entry") {
      text = `Token எண் ${next.tokenNumber}, பதிவு கவுண்டர் ${next.counterNumber}-க்கு வரவும்`
    } else if (next.type === "payment") {
      text = `Token எண் ${next.tokenNumber}, பணம் செலுத்தும் கவுண்டருக்கு வரவும்`
    }

    console.log("[audio] announcement text:", text)

    // Chime first
    playChime()

    // Then speak after 450ms delay (matches the old MP3 timing)
    setTimeout(() => {
      speakAnnouncement(text)
        .then(() => {
          isPlayingRef.current = false
          processQueueRef.current() // process next item
        })
        .catch(() => {
          isPlayingRef.current = false
          processQueueRef.current()
        })
    }, 450)
  }, [playChime, speakAnnouncement])

  // Keep the latest processQueue closure accessible to its own async handlers.
  useEffect(() => {
    processQueueRef.current = processQueue
  }, [processQueue])

  // Push an announcement onto the global queue and kick the sequential player.
  // Coalesces by sourceKey: rapid repeated triggers from the same counter
  // replace any pending (not-yet-playing) item from that counter, keeping only
  // the newest. Manual recalls (isManualRecall=true) bypass coalescing so every
  // explicit button press always results in exactly one announcement.
  // Includes a queue-size safety cap: if the pending queue exceeds the cap,
  // drop the oldest excess entry and log a warning.
  const enqueueAnnouncement = useCallback(
    (item: QueueItem, isManualRecall = false) => {
      // Coalesce: remove any queued (not-yet-playing) item with the same sourceKey,
      // unless this is a manual recall which must never be dropped.
      if (!isManualRecall) {
        audioQueueRef.current = audioQueueRef.current.filter(
          (queued) => queued.sourceKey !== item.sourceKey,
        )
      }

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
      // Dispatch announcements are always treated as manual recalls since the
      // UI prevents rapid "Call" clicks (button is disabled while serving).
      // "Call again" presses must never be coalesced away.
      if (soundOn) enqueueAnnouncement({ type: "dispatch", tokenNumber: current, sourceKey: "dispatch" }, true)
    }
  }, [rows, soundOn, enqueueAnnouncement])

  // ─── ENTRY NUMBER-CHANGE WATCHER ─────────────────────────────────────────
  // Watch each entry counter; announce whenever its token_number changes to a
  // NEW value. This is the primary trigger (new call / held-token recall).
  useEffect(() => {
    const entryRows = rows.filter((r) => r.station === "entry" && r.counter != null)
    for (const row of entryRows) {
      const counter = Number(row.counter!)
      const current = row.token_number

      if (!entryInitializedRef.current.has(counter)) {
        lastEntryNumberRefs.current[counter] = current
        entryInitializedRef.current.add(counter)
        continue
      }

      if (current !== null && current !== lastEntryNumberRefs.current[counter]) {
        lastEntryNumberRefs.current[counter] = current
        if (soundOn) enqueueAnnouncement({ type: "entry", counterNumber: counter, tokenNumber: current, sourceKey: `entry-${counter}` })
      }
    }
  }, [rows, soundOn, enqueueAnnouncement])

  // ─── ENTRY RECALL WATCHER ────────────────────────────────────────────────
  // Watch each entry counter's recalled_at; re-announce the SAME token when
  // the staff presses "Call Again".
  useEffect(() => {
    const entryRows = rows.filter((r) => r.station === "entry" && r.counter != null)
    for (const row of entryRows) {
      const counter = Number(row.counter!)
      const current = row.token_number
      const recalledAt = row.recalled_at ?? null

      if (!entryInitializedRef.current.has(counter)) continue

      if (!(counter in lastEntryRecallRefs.current)) {
        lastEntryRecallRefs.current[counter] = recalledAt
        continue
      }

      if (
        current !== null &&
        recalledAt !== null &&
        recalledAt !== lastEntryRecallRefs.current[counter]
      ) {
        lastEntryRecallRefs.current[counter] = recalledAt
        // Manual recalls (Call Again) must never be coalesced away.
        if (soundOn) enqueueAnnouncement({ type: "entry", counterNumber: counter, tokenNumber: current, sourceKey: `entry-${counter}` }, true)
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
      lastPaymentNumberRef.current = current
      if (soundOn) enqueueAnnouncement({ type: "payment", tokenNumber: current, sourceKey: "payment" })
    }
  }, [rows, soundOn, enqueueAnnouncement])

  // ─── PAYMENT RECALL WATCHER ──────────────────────────────────────────────
  // Watch the payment counter's recalled_at; re-announce the SAME token when
  // the staff presses "Call Again".
  useEffect(() => {
    const payment = rows.find((r) => r.station === "payment")
    const current = payment?.token_number ?? null
    const recalledAt = payment?.recalled_at ?? null

    if (!paymentInitializedRef.current) return

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
      lastPaymentRecallRef.current = recalledAt
      // Manual recalls (Call Again) must never be coalesced away.
      if (soundOn) enqueueAnnouncement({ type: "payment", tokenNumber: current, sourceKey: "payment" }, true)
    }
  }, [rows, soundOn, enqueueAnnouncement])

  const enableSound = () => {
    console.log("[audio] enableSound: user gesture fired")
    setSoundOn(true)
    // Play a test chime to confirm audio works
    playChime()
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

      {/* TTS availability warning — persistent, visible if no Tamil voice detected */}
      {ttsAvailable === false && (
        <div className="flex items-center gap-3 border-b-2 border-amber-200 bg-amber-50 px-8 py-3">
          <AlertTriangle className="h-5 w-5 flex-shrink-0 text-amber-600" aria-hidden="true" />
          <p className="text-sm font-medium text-amber-900">
            Tamil voice announcements unavailable on this device. Please check browser TTS settings or use a device with
            Tamil language support installed.
          </p>
        </div>
      )}

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
