"use client"

import { useRef, useState, useTransition } from "react"
import { generateTokenAction } from "@/app/dispensing/actions"
import { sendToPrintBridge, printLabelsViaIframe, PRINT_BRIDGE_URL, PrintBridgeError } from "@/lib/print-bridge"
import { Button } from "@/components/ui/button"
import { HOSPITAL_SHORT } from "@/lib/types"
import { Printer } from "lucide-react"

export function DispensingPanel({ initialCount }: { initialCount: number }) {
  const [issuedToday, setIssuedToday] = useState(initialCount)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  // Ref (not state) so the deferred setTimeout callback sees the current value
  // synchronously. Prevents overlapping print jobs from Generate + Reprint or
  // rapid double-clicks: only one in-flight print at a time.
  const isPrintingRef = useRef(false)

  // Print two identical labels. Prefer the local ZD230 bridge (silent); if it is
  // configured but unreachable, fall back to an isolated print iframe (exactly
  // 2 pages) so tokens still print, and surface a warning so the kiosk can be fixed.
  // When the bridge is reachable but the printer itself failed, show the real
  // reason instead of silently falling back to a dialog that queues to the same
  // broken printer.
  async function printToken(tokenNumber: number) {
    if (isPrintingRef.current) return
    isPrintingRef.current = true
    try {
      if (PRINT_BRIDGE_URL) {
        try {
          await sendToPrintBridge(HOSPITAL_SHORT, tokenNumber, 2)
          return
        } catch (bridgeErr) {
          if (bridgeErr instanceof PrintBridgeError && bridgeErr.responded) {
            setError(
              `Printing failed: ${(bridgeErr as Error).message}. ` +
                `The ZD230 did not print - check it is powered on and connected.`,
            )
            return
          }
          setError(
            `Print bridge unreachable: ${(bridgeErr as Error).message}. ` +
              `Fell back to the browser print dialog.`,
          )
        }
      }
      await printLabelsViaIframe(HOSPITAL_SHORT, tokenNumber, 2)
    } catch (err) {
      setError(`Print failed: ${(err as Error).message}`)
    } finally {
      isPrintingRef.current = false
    }
  }

  function handleGenerate() {
    setError(null)
    startTransition(async () => {
      const res = await generateTokenAction()
      if (res.error || !res.token) {
        setError(res.error ?? "Failed to generate token.")
        return
      }
      const token = res.token
      setIssuedToday((c) => c + 1)
      // Allow the DOM to paint the new labels first, then print.
      setTimeout(() => printToken(token.token_number), 200)
    })
  }

  return (
    <div className="flex min-h-[calc(100vh-72px)] items-center justify-center px-6 py-10">
      <div className="flex w-full max-w-5xl flex-col items-center justify-center gap-8 text-center">
        <div className="flex flex-col items-center gap-3 rounded-3xl bg-white/70 px-8 py-7 shadow-sm ring-1 ring-border backdrop-blur-sm sm:px-12 lg:px-16">
          <span className="text-xl font-semibold uppercase tracking-[0.2em] text-muted-foreground sm:text-2xl">
            Tokens issued today
          </span>
          <span className="font-mono text-6xl font-black leading-none tracking-tight text-foreground md:text-8xl">
            {issuedToday}
          </span>
        </div>

        <Button
          className="w-full max-w-3xl rounded-2xl px-8 py-8 text-xl font-bold sm:text-2xl md:text-3xl"
          size="lg"
          disabled={pending}
          onClick={handleGenerate}
        >
          <Printer className="mr-3 h-6 w-6 shrink-0 sm:h-7 sm:w-7" aria-hidden="true" />
          {pending ? "Generating..." : "Generate & Print Token"}
        </Button>

        {error ? (
          <p
            className="max-w-3xl rounded-2xl bg-destructive/10 px-5 py-4 text-base font-medium text-destructive sm:text-lg"
            role="alert"
            aria-live="polite"
          >
            {error}
          </p>
        ) : null}
      </div>
    </div>
  )
}
