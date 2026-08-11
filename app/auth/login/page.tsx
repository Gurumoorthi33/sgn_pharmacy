import Link from "next/link"
import { AuthShell } from "@/components/auth/auth-shell"
import { LoginForm } from "@/components/auth/login-form"

export default function LoginPage() {
  return (
    <AuthShell
      title="Staff sign in"
      description="Sign in to your station to manage the pharmacy token queue."
      footer={
        <div className="flex flex-col items-center gap-2">
          <Link
            href="/display"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            Open the public Display Board
          </Link>
        </div>
      }
    >
      <LoginForm />
    </AuthShell>
  )
}
