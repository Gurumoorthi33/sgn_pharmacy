"use client"

import { useTransition } from "react"
import { useTokens } from "@/hooks/use-tokens"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { Token, TokenStatus } from "@/lib/types"
import { Check, PhoneCall } from "lucide-react"

/**
 * Reusable single-counter station for Payment and Dispatch.
 * `servingStatus` is the status of the token being served at this counter,
 * `pendingStatus` is the status of tokens waiting for this counter.
 */
export function CounterStation({
  servingStatus,
  pendingStatus,
  callNext,
  complete,
  accentClass,
  fifoKey,
}: {
  servingStatus: TokenStatus
  pendingStatus: TokenStatus
  callNext: () => Promise<{ token?: Token | null; error?: string }>
  complete: (id: string) => Promise<{ error?: string }>
  accentClass?: string
  fifoKey?: keyof Token
}) {
  const { tokens, refetch } = useTokens()
  const [pending, startTransition] = useTransition()

  const serving = tokens.find((t) => t.status === servingStatus)
  const waiting = tokens
    .filter((t) => t.status === pendingStatus)
    .sort((a, b) => {
      if (fifoKey) {
        const av = (a[fifoKey] as string | null) ?? ""
        const bv = (b[fifoKey] as string | null) ?? ""
        if (av !== bv) return av < bv ? -1 : 1
      }
      return a.token_number - b.token_number
    })
  const nextUp = waiting[0]

  function run(fn: () => Promise<{ error?: string } | { token?: Token | null; error?: string }>) {
    startTransition(async () => {
      await fn()
      refetch()
    })
  }

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6 p-6 lg:grid-cols-[1.3fr_1fr]">
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
            <span
              className={`font-mono text-[7rem] font-bold leading-none tabular-nums ${accentClass ?? "text-primary"}`}
            >
              {serving.token_number}
            </span>
          ) : (
            <span className="flex h-[7rem] items-center font-mono text-6xl font-bold leading-none tabular-nums text-muted-foreground/40">
              &mdash;
            </span>
          )}
          <div className="flex w-full max-w-sm flex-col gap-3">
            <Button size="lg" disabled={pending || !!serving || !nextUp} onClick={() => run(callNext)}>
              <PhoneCall className="mr-2 h-5 w-5" aria-hidden="true" />
              {nextUp && !serving ? `Call next (Token ${nextUp.token_number})` : "Call next token"}
            </Button>
            <Button
              size="lg"
              className="bg-success text-success-foreground hover:bg-success/90"
              disabled={pending || !serving}
              onClick={() => serving && run(() => complete(serving.id))}
            >
              <Check className="mr-2 h-5 w-5" aria-hidden="true" />
              Complete
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b border-border">
          <CardTitle className="flex items-center justify-between text-base">
            <span>Waiting queue</span>
            <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
              {waiting.length} waiting
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="py-4">
          {waiting.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No tokens waiting.</p>
          ) : (
            <ol className="flex flex-wrap gap-2">
              {waiting.map((t, i) => (
                <li
                  key={t.id}
                  title={i === 0 ? "Next to be called" : undefined}
                  className={`flex h-12 w-12 items-center justify-center rounded-lg font-mono text-lg font-semibold ${
                    i === 0
                      ? "bg-primary text-primary-foreground ring-2 ring-primary"
                      : "bg-secondary text-secondary-foreground"
                  }`}
                >
                  {t.token_number}
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
