import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) => supabaseResponse.cookies.set(name, value, options))
        },
      },
    },
  )

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const path = request.nextUrl.pathname
  const isPublic = path.startsWith("/auth") || path === "/" || path.startsWith("/display")

  // Never redirect Server Action POSTs or RSC navigations. Redirecting those
  // returns an HTML response to a fetch that expects an action/flight payload,
  // which surfaces as "An unexpected response was received from the server".
  // Page-level guards (requireRole) handle auth for these requests instead.
  const isServerAction = request.method === "POST" || request.headers.has("next-action")
  const isRscRequest = request.headers.has("rsc") || request.headers.has("next-router-prefetch")

  if (!user && !isPublic && !isServerAction && !isRscRequest) {
    const url = request.nextUrl.clone()
    url.pathname = "/auth/login"
    return NextResponse.redirect(url)
  }

  return supabaseResponse
}
