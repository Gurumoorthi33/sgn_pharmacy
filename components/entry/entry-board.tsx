"use client"

import { useTransition } from "react"
import { useTokens } from "@/hooks/use-tokens"
import { EntryCounterCard } from "@/components/entry/entry-counter-card"
import { callEntryTokenAction } from "@/app/entry/actions"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"

export function EntryBoard({ counter }: { counter: number }) {
  const { tokens, refetch } = useTokens()
  const [pending, startTransition] = useTransition()

  // The token this counter is currently serving (if any).
  const serving = tokens.find((t) => t.status === "entry_serving" && t.entry_counter === counter)

  // Who the other counters are serving, for shared awareness.
  const othersServing = tokens.filter(
    (t) => t.status === "entry_serving" && t.entry_counter && t.entry_counter !== counter,
  )

  // Fresh, un-served tokens waiting in FIFO order (these feed "Call next").
  const fresh = tokens
    .filter((t) => t.status === "pending_entry")
    .sort((a, b) => a.token_number - b.token_number)

  // Held tokens (someone pressed "Wait & continue"). Clickable to recall.
  const held = tokens
    .filter((t) => t.status === "entry_waiting")
    .sort((a, b) => a.token_number - b.token_number)

  const nextUp = fresh[0]

  function callHeld(id: string) {
    startTransition(async () => {
      await callEntryTokenAction(id, counter)
      refetch()
    })
  }

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6 p-6 lg:grid-cols-[1fr_1fr]">
      <EntryCounterCard counter={counter} serving={serving} nextUp={nextUp?.token_number ?? null} onChanged={refetch} />

      <div className="flex flex-col gap-6">
        {/* Held tokens — clickable to recall to this counter */}
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
                  Tap a held token to call it back to your counter (only when your counter is free).
                </p>
                <div className="flex flex-wrap gap-2">
                  {held.map((t) => (
                    <Button
                      key={t.id}
                      variant="outline"
                      className="h-12 w-14 border-warning font-mono text-lg font-semibold text-warning-foreground hover:bg-warning/10"
                      disabled={pending || !!serving}
                      onClick={() => callHeld(t.id)}
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

            {othersServing.length > 0 ? (
              <div className="mt-6 border-t border-border pt-4">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Being served at other counters
                </p>
                <ul className="flex flex-wrap gap-2">
                  {othersServing.map((t) => (
                    <li
                      key={t.id}
                      className="flex items-center gap-1.5 rounded-lg bg-muted px-3 py-1.5 text-sm text-muted-foreground"
                    >
                      <span className="font-mono font-semibold text-foreground">{t.token_number}</span>
                      <span className="text-xs">· C{t.entry_counter}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
