import type { ReactNode } from "react"
import Image from "next/image"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { HOSPITAL_NAME, SYSTEM_NAME } from "@/lib/types"

export function AuthShell({
  title,
  description,
  children,
  footer,
}: {
  title: string
  description: string
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-secondary px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center text-center">
          <Image
            src="/sgn-logo.png"
            alt="SGN Pharmacy"
            width={200}
            height={80}
            priority
            className="mb-3 h-auto w-44"
          />
          <h1 className="text-xl font-semibold text-foreground">{SYSTEM_NAME}</h1>
          <p className="mt-1 text-sm text-muted-foreground text-balance">{HOSPITAL_NAME}</p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {children}
            {footer}
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
