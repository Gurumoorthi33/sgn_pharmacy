import Link from "next/link"
import { AuthShell } from "@/components/auth/auth-shell"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export default function AuthErrorPage() {
  return (
    <AuthShell title="Authentication error" description="Something went wrong while signing you in.">
      <Link href="/auth/login" className={cn(buttonVariants(), "w-full")}>
        Back to sign in
      </Link>
    </AuthShell>
  )
}
