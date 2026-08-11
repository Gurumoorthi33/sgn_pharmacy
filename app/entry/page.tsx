import { requireRole } from "@/lib/get-session"
import { StationHeader } from "@/components/station-header"
import { EntryBoard } from "@/components/entry/entry-board"

export default async function EntryPage() {
  const { fullName, counter } = await requireRole("entry")
  // Every entry user is bound to exactly one counter (1, 2 or 3).
  const myCounter = counter ?? 1
  return (
    <div className="min-h-screen bg-secondary">
      <StationHeader
        title={`Entry Counter ${myCounter}`}
        subtitle="Call, complete or hold tokens · strict first-in first-out"
        fullName={fullName}
      />
      <EntryBoard counter={myCounter} />
    </div>
  )
}
