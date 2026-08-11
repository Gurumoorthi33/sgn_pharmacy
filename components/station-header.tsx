import Link from "next/link"
import Image from "next/image"
import { signOutAction } from "@/app/auth/actions"
import { Button, buttonVariants } from "@/components/ui/button"
import { HOSPITAL_SHORT, SYSTEM_NAME } from "@/lib/types"
import { LogOut, MonitorPlay } from "lucide-react"
import { cn } from "@/lib/utils"

export function StationHeader({
  title,
  subtitle,
  fullName,
}: {
  title: string
  subtitle?: string
  fullName?: string
}) {
  return (
    <header className="flex items-center justify-between gap-4 border-b border-border bg-card px-6 py-4">
      <div className="flex items-center gap-3">
        <Image src="/sgn-logo.png" alt="SGN Pharmacy" width={120} height={48} priority className="h-10 w-auto" />
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {HOSPITAL_SHORT} &middot; {SYSTEM_NAME}
          </p>
          <h1 className="text-lg font-semibold leading-tight text-foreground text-balance">{title}</h1>
          {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
        </div>
      </div>
      <div className="flex items-center gap-3">
        {fullName ? (
          <span className="hidden text-sm text-muted-foreground sm:inline">
            Signed in as <span className="font-medium text-foreground">{fullName}</span>
          </span>
        ) : null}
        <Link
          href="/display"
          target="_blank"
          rel="noopener noreferrer"
          className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
        >
          <MonitorPlay className="mr-1.5 h-4 w-4" aria-hidden="true" />
          Display Board
        </Link>
        <form action={signOutAction}>
          <Button variant="outline" size="sm" type="submit">
            <LogOut className="mr-1.5 h-4 w-4" aria-hidden="true" />
            Sign out
          </Button>
        </form>
      </div>
    </header>
  )
}
