"use client"

import { useTransition } from "react"
import { callNextEntryAction, completeEntryAction, waitAndNextEntryAction } from "@/app/entry/actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { Token } from "@/lib/types"
import { Check, PhoneCall, PauseCircle } from "lucide-react"

export function EntryCounterCard({
  counter,
  serving,
  nextUp,
  onChanged,
}: {
  counter: number
  serving: Token | undefined
  nextUp: number | null
  onChanged: () => void
}) {
  const [pending, startTransition] = useTransition()

  function run(fn: () => Promise<{ error?: string }>) {
    startTransition(async () => {
      await fn()
      onChanged()
    })
  }

  return (
    <Card className="flex flex-col">
      <CardHeader className="border-b border-border">
        <CardTitle className="flex items-center justify-between text-base">
          <span>Counter {counter}</span>
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
            disabled={pending || !!serving || nextUp === null}
            onClick={() => run(() => callNextEntryAction(counter))}
          >
            <PhoneCall className="mr-2 h-4 w-4" aria-hidden="true" />
            {nextUp !== null && !serving ? `Call next (Token ${nextUp})` : "Call next"}
          </Button>
          <Button
            className="w-full bg-success text-success-foreground hover:bg-success/90"
            disabled={pending || !serving}
            onClick={() => serving && run(() => completeEntryAction(serving.id))}
          >
            <Check className="mr-2 h-4 w-4 shrink-0" aria-hidden="true" />
            Complete
          </Button>
          <Button
            variant="outline"
            className="w-full bg-transparent"
            disabled={pending || !serving}
            onClick={() => serving && run(() => waitAndNextEntryAction(serving.id, counter))}
          >
            <PauseCircle className="mr-2 h-4 w-4 shrink-0" aria-hidden="true" />
            Wait &amp; continue
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
