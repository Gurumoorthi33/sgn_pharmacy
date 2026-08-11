"use client"

import Image from "next/image"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { HOSPITAL_NAME, SYSTEM_NAME } from "@/lib/types"
import { Volume2 } from "lucide-react"

type DisplayRow = {
  station: "entry" | "payment" | "dispatch"
  counter: number | null
  token_number: number
  called_at: string | null
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
  const [now, setNow] = useState<Date>(new Date())
  const [soundOn, setSoundOn] = useState(false)
  const lastDispatchCallRef = useRef<string | null>(null)
  const initializedRef = useRef(false)

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

  // Clock
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  // Announce a dispatched token in Tamil (twice) then English (twice).
  const announceDispatch = useCallback((tokenNumber: number) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return

    const tamil = `டோக்கன் எண் ${tokenNumber}, தயவுசெய்து மருந்து வழங்கும் கவுண்டருக்கு வரவும்.`
    const english = `Token number ${tokenNumber}, please proceed to the dispatch counter.`

    // Each phrase is spoken twice, Tamil first then English.
    const queue: { text: string; lang: string }[] = [
      { text: tamil, lang: "ta-IN" },
      { text: tamil, lang: "ta-IN" },
      { text: english, lang: "en-IN" },
      { text: english, lang: "en-IN" },
    ]

    const voices = window.speechSynthesis.getVoices()
    const pickVoice = (prefix: string) => voices.find((v) => v.lang?.toLowerCase().startsWith(prefix))

    const speakAt = (i: number) => {
      if (i >= queue.length) return
      const { text, lang } = queue[i]
      const u = new SpeechSynthesisUtterance(text)
      u.lang = lang
      u.rate = 0.85
      u.pitch = 1
      const v = pickVoice(lang.slice(0, 2))
      if (v) u.voice = v
      u.onend = () => speakAt(i + 1)
      // If a voice errors out, still advance so the sequence never stalls.
      u.onerror = () => speakAt(i + 1)
      window.speechSynthesis.speak(u)
    }

    // Play a short chime, then run the sequence.
    playChime()
    window.speechSynthesis.cancel()
    setTimeout(() => speakAt(0), 450)
  }, [])

  // Watch the dispatch counter; announce whenever it is called — a NEW token
  // OR the same token re-called ("Call again"). We key off dispatch_called_at,
  // which changes on every call and every recall.
  useEffect(() => {
    const dispatch = rows.find((r) => r.station === "dispatch")
    const current = dispatch?.token_number ?? null
    const calledAt = dispatch?.called_at ?? null

    if (!initializedRef.current) {
      // Don't announce whatever was already on screen when the board first loads.
      lastDispatchCallRef.current = calledAt
      initializedRef.current = true
      return
    }

    if (current !== null && calledAt !== null && calledAt !== lastDispatchCallRef.current) {
      if (soundOn) announceDispatch(current)
    }
    lastDispatchCallRef.current = calledAt
  }, [rows, soundOn, announceDispatch])

  const playChime = () => {
    try {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext
      const ctx = new Ctx()
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
    } catch {
      // ignore
    }
  }

  const enableSound = () => {
    setSoundOn(true)
    // Unlock speech synthesis + audio with this user gesture.
    try {
      const u = new SpeechSynthesisUtterance(" ")
      u.volume = 0
      window.speechSynthesis.speak(u)
    } catch {
      // ignore
    }
    playChime()
  }

  const t = STRINGS[lang]
  const featured = rows[0] ?? null

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
              {now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </div>
            <div className="text-sm text-black/50">
              {now.toLocaleDateString(lang === "ta" ? "ta-IN" : "en-GB", {
                weekday: "long",
                day: "numeric",
                month: "long",
              })}
            </div>
          </div>
        </div>
      </header>

      {/* Featured "Now serving" */}
      <section className="flex flex-col items-center justify-center gap-3 px-8 py-6">
        <p className="text-lg font-semibold uppercase tracking-[0.3em] text-[#1d4ed8]">{t.nowServing}</p>
        {featured ? (
          <div className="flex flex-col items-center gap-2">
            <div className="font-mono text-[10rem] font-extrabold leading-none tabular-nums text-[#15803d]">
              {featured.token_number}
            </div>
            <div className="rounded-full bg-[#1d4ed8] px-8 py-2.5 text-xl font-bold text-white">
              {stationTitle(featured.station, featured.counter)}
            </div>
          </div>
        ) : (
          <p className="max-w-2xl text-balance text-center text-2xl font-medium text-black/40">{t.idle}</p>
        )}
      </section>

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
