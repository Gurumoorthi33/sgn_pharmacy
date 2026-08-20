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
    <header className="flex items-center justify-between gap-3 border-b border-border bg-card px-4 py-3 sm:px-5">
      <div className="flex min-w-0 items-center gap-3">
        <Image src="/sgn-logo.png" alt="SGN Pharmacy" width={120} height={48} priority className="h-8 w-auto sm:h-10" />
        <div className="min-w-0">
          <p className="hidden text-[10px] font-medium uppercase tracking-wide text-muted-foreground sm:block">
            {HOSPITAL_SHORT} &middot; {SYSTEM_NAME}
          </p>
          <h1 className="truncate text-base font-semibold leading-tight text-foreground sm:text-lg">{title}</h1>
          {subtitle ? <p className="hidden text-xs text-muted-foreground sm:block">{subtitle}</p> : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {fullName ? (
          <span className="hidden text-[11px] text-muted-foreground lg:inline">
            Signed in as <span className="font-medium text-foreground">{fullName}</span>
          </span>
        ) : null}
        <Link
          href="/display"
          target="_blank"
          rel="noopener noreferrer"
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-8 px-2.5 text-xs")}
        >
          <MonitorPlay className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          Display Board
        </Link>
        <form action={signOutAction}>
          <Button variant="outline" size="sm" type="submit" className="h-8 px-2.5 text-xs">
            <LogOut className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            Sign out
          </Button>
        </form>
      </div>
    </header>
  )
}
