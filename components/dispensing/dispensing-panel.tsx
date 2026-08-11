"use client"

import { useRef, useState, useTransition } from "react"
import { generateTokenAction } from "@/app/dispensing/actions"
import { TokenLabel } from "@/components/dispensing/token-label"
import { sendToPrintBridge, printLabelsViaIframe, PRINT_BRIDGE_URL } from "@/lib/print-bridge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { HOSPITAL_SHORT, type Token } from "@/lib/types"
import { Printer, Ticket } from "lucide-react"

export function DispensingPanel({ initialCount }: { initialCount: number }) {
  const [current, setCurrent] = useState<Token | null>(null)
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
  async function printToken(tokenNumber: number) {
    if (isPrintingRef.current) return
    isPrintingRef.current = true
    try {
      if (PRINT_BRIDGE_URL) {
        try {
          await sendToPrintBridge(HOSPITAL_SHORT, tokenNumber, 2)
          return
        } catch (bridgeErr) {
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
      setCurrent(token)
      setIssuedToday((c) => c + 1)
      // Allow the DOM to paint the new labels first, then print.
      setTimeout(() => printToken(token.token_number), 200)
    })
  }

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6 p-6 lg:grid-cols-[1.1fr_1fr]">
      {/* Controls */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Ticket className="h-5 w-5 text-primary" aria-hidden="true" />
            Generate patient token
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <p className="text-sm leading-relaxed text-muted-foreground">
            Pressing the button issues the next token and prints it automatically on the Zebra ZD230 &mdash; the same
            token number is printed twice (one for the patient, one for the prescription bag).
          </p>

          <div className="flex items-baseline justify-between rounded-lg bg-secondary px-4 py-3">
            <span className="text-sm font-medium text-secondary-foreground">Tokens issued today</span>
            <span className="font-mono text-2xl font-bold text-foreground">{issuedToday}</span>
          </div>

          <Button className="w-full" size="lg" disabled={pending} onClick={handleGenerate}>
            <Printer className="mr-2 h-5 w-5" aria-hidden="true" />
            {pending ? "Generating..." : "Generate & Print Token"}
          </Button>

          {current ? (
            <Button
              variant="outline"
              className="self-start bg-transparent"
              onClick={() => printToken(current.token_number)}
            >
              <Printer className="mr-2 h-4 w-4" aria-hidden="true" />
              Reprint token {current.token_number}
            </Button>
          ) : null}

          {error ? (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}

          <p className="rounded-md bg-accent/40 px-3 py-2 text-xs leading-relaxed text-accent-foreground">
            Tip: to skip the print dialog entirely, launch Chrome with{" "}
            <code className="font-mono">--kiosk-printing</code> so tokens print silently on the ZD230. If the
            bridge is down, start it on the printer PC: <code className="font-mono">cd printer-bridge && python app.py</code>,
            then check <code className="font-mono">http://localhost:5000/health</code>.
          </p>
        </CardContent>
      </Card>

      {/* Preview */}
      <Card>
        <CardHeader>
          <CardTitle>Label preview</CardTitle>
        </CardHeader>
        <CardContent>
          {current ? (
            <div className="label-preview flex flex-wrap items-center justify-center gap-4">
              <TokenLabel tokenNumber={current.token_number} />
              <TokenLabel tokenNumber={current.token_number} />
            </div>
          ) : (
            <div className="flex h-48 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
              Generate a token to preview the labels
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
