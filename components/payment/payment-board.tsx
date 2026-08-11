"use client"

import { useTransition } from "react"
import { useTokens } from "@/hooks/use-tokens"
import {
  callNextPaymentAction,
  completePaymentAction,
  waitAndNextPaymentAction,
  callPaymentTokenAction,
} from "@/app/payment/actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Check, PhoneCall, PauseCircle } from "lucide-react"

export function PaymentBoard() {
  const { tokens, refetch } = useTokens()
  const [pending, startTransition] = useTransition()

  const serving = tokens.find((t) => t.status === "payment_serving")

  // Fresh tokens waiting, FIFO by entry completion (these feed "Call next").
  const fresh = tokens
    .filter((t) => t.status === "pending_payment")
    .sort((a, b) => {
      const av = a.entry_completed_at ?? ""
      const bv = b.entry_completed_at ?? ""
      if (av !== bv) return av < bv ? -1 : 1
      return a.token_number - b.token_number
    })

  // Held tokens (someone pressed "Wait & continue"). Clickable to recall.
  const held = tokens
    .filter((t) => t.status === "payment_waiting")
    .sort((a, b) => a.token_number - b.token_number)

  const nextUp = fresh[0]

  function run(fn: () => Promise<unknown>) {
    startTransition(async () => {
      await fn()
      refetch()
    })
  }

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6 p-6 lg:grid-cols-[1fr_1fr]">
      {/* Serving / actions */}
      <Card className="flex flex-col">
        <CardHeader className="border-b border-border">
          <CardTitle className="flex items-center justify-between text-base">
            <span>Payment Counter</span>
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                serving ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"
              }`}
            >
              {serving ? "Serving" : "Idle"}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col items-center gap-5 py-6">
          <div className="flex flex-col items-center">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">Now serving</span>
            <span className="font-mono text-6xl font-bold tabular-nums text-foreground">
              {serving ? serving.token_number : "--"}
            </span>
          </div>

          <div className="grid w-full gap-2">
            <Button
              size="lg"
              disabled={pending || !!serving || !nextUp}
              onClick={() => run(callNextPaymentAction)}
            >
              <PhoneCall className="mr-2 h-4 w-4" aria-hidden="true" />
              {nextUp && !serving ? `Call next (Token ${nextUp.token_number})` : "Call next"}
            </Button>
            <Button
              className="w-full bg-success text-success-foreground hover:bg-success/90"
              disabled={pending || !serving}
              onClick={() => serving && run(() => completePaymentAction(serving.id))}
            >
              <Check className="mr-2 h-4 w-4 shrink-0" aria-hidden="true" />
              Complete
            </Button>
            <Button
              variant="outline"
              className="w-full bg-transparent"
              disabled={pending || !serving}
              onClick={() => serving && run(() => waitAndNextPaymentAction(serving.id))}
            >
              <PauseCircle className="mr-2 h-4 w-4 shrink-0" aria-hidden="true" />
              Wait &amp; continue
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-6">
        {/* Held tokens — clickable to recall */}
        <Card className="flex flex-col">
          <CardHeader className="border-b border-border">
            <CardTitle className="flex items-center justify-between text-base">
              <span>On hold</span>
              <span className="rounded-full bg-warning/20 px-2.5 py-0.5 text-xs font-medium text-warning-foreground">
                {held.length} held
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="py-4">
            {held.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">No tokens on hold.</p>
            ) : (
              <>
                <p className="mb-3 text-xs text-muted-foreground">
                  Tap a held token to call it back (only when the counter is free).
                </p>
                <div className="flex flex-wrap gap-2">
                  {held.map((t) => (
                    <Button
                      key={t.id}
                      variant="outline"
                      className="h-12 w-14 border-warning font-mono text-lg font-semibold text-warning-foreground hover:bg-warning/10"
                      disabled={pending || !!serving}
                      onClick={() => run(() => callPaymentTokenAction(t.id))}
                      title={serving ? "Finish the current token first" : `Call token ${t.token_number}`}
                    >
                      {t.token_number}
                    </Button>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Fresh FIFO waiting queue */}
        <Card className="flex flex-col">
          <CardHeader className="border-b border-border">
            <CardTitle className="flex items-center justify-between text-base">
              <span>Waiting queue (FIFO)</span>
              <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                {fresh.length} waiting
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex-1 py-4">
            {fresh.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No tokens waiting.</p>
            ) : (
              <ol className="flex flex-wrap gap-2">
                {fresh.map((t, i) => (
                  <li
                    key={t.id}
                    className={`flex h-12 w-12 items-center justify-center rounded-lg font-mono text-lg font-semibold ${
                      i === 0
                        ? "bg-primary text-primary-foreground ring-2 ring-primary"
                        : "bg-secondary text-secondary-foreground"
                    }`}
                    title={i === 0 ? "Next to be called" : "Waiting"}
                  >
                    {t.token_number}
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
