"use client"

import { useTransition } from "react"
import { useTokens } from "@/hooks/use-tokens"
import {
  callDispatchAction,
  completeDispatchAction,
  skipDispatchAction,
  recallDispatchAction,
} from "@/app/dispatch/actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { Token } from "@/lib/types"
import { Check, Volume2, Clock, RotateCcw } from "lucide-react"

export function DispatchBoard() {
  const { tokens, refetch } = useTokens()
  const [pending, startTransition] = useTransition()

  const serving = tokens.find((t) => t.status === "dispatch_serving")

  // Tokens ready for dispatch, FIFO. Waited (requeued) tokens go to the back
  // by their requeue time, matching the pending_dispatch_list RPC ordering.
  const ready = tokens
    .filter((t) => t.status === "pending_dispatch")
    .sort((a, b) => {
      const av = a.dispatch_requeued_at ?? a.payment_completed_at ?? ""
      const bv = b.dispatch_requeued_at ?? b.payment_completed_at ?? ""
      if (av !== bv) return av < bv ? -1 : 1
      return a.token_number - b.token_number
    })

  function run(fn: () => Promise<{ error?: string } | { token?: Token | null; error?: string }>) {
    startTransition(async () => {
      await fn()
      refetch()
    })
  }

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6 p-6 lg:grid-cols-[1.2fr_1fr]">
      {/* Now serving */}
      <Card>
        <CardHeader className="border-b border-border">
          <CardTitle className="flex items-center justify-between text-base">
            <span>Now serving</span>
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                serving ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"
              }`}
            >
              {serving ? "In progress" : "Idle"}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-6 py-10">
          {serving ? (
            <span className="font-mono text-[7rem] font-bold leading-none tabular-nums text-success">
              {serving.token_number}
            </span>
          ) : (
            <span className="flex h-[7rem] items-center font-mono text-6xl font-bold leading-none tabular-nums text-muted-foreground/40">
              &mdash;
            </span>
          )}
          <div className="flex w-full max-w-sm flex-col gap-2">
            <p className="text-center text-sm text-muted-foreground">
              {serving
                ? "Announcing on the display board in Tamil and English."
                : "Select a token from the list to call it to this counter."}
            </p>
            <Button
              size="lg"
              className="bg-success text-success-foreground hover:bg-success/90"
              disabled={pending || !serving}
              onClick={() => serving && run(() => completeDispatchAction(serving.id))}
            >
              <Check className="mr-2 h-5 w-5" aria-hidden="true" />
              Complete &amp; hand over
            </Button>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                disabled={pending || !serving}
                onClick={() => serving && run(() => recallDispatchAction(serving.id))}
              >
                <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
                Call again
              </Button>
              <Button
                variant="outline"
                disabled={pending || !serving}
                onClick={() => serving && run(() => skipDispatchAction(serving.id))}
              >
                <Clock className="mr-2 h-4 w-4" aria-hidden="true" />
                Wait &amp; proceed
              </Button>
            </div>
            <p className="text-center text-xs text-muted-foreground">
              {"Call again re-announces the token. Wait & proceed sends it to the back of the queue so you can call the next patient."}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Ready for dispatch (manual pick) */}
      <Card className="flex flex-col">
        <CardHeader className="border-b border-border">
          <CardTitle className="flex items-center justify-between text-base">
            <span>Ready for dispatch</span>
            <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
              {ready.length} ready
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex-1 py-4">
          {ready.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No tokens ready for dispatch.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {ready.map((t, i) => (
                <li key={t.id}>
                  <button
                    type="button"
                    disabled={pending || !!serving}
                    onClick={() => run(() => callDispatchAction(t.id))}
                    className="flex w-full items-center justify-between rounded-lg border border-border bg-card px-4 py-3 text-left transition-colors hover:border-primary hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className="flex items-center gap-3">
                      <span className="font-mono text-2xl font-bold tabular-nums text-foreground">
                        {t.token_number}
                      </span>
                      {i === 0 ? (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                          Next in line
                        </span>
                      ) : null}
                    </span>
                    <span className="flex items-center gap-1.5 text-sm font-medium text-primary">
                      <Volume2 className="h-4 w-4" aria-hidden="true" />
                      Call
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
