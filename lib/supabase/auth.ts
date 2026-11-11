import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * Returns the signed-in user's id, or null.
 *
 * Uses getClaims(), which verifies the session JWT locally against the
 * project's (cached) signing keys instead of calling the Auth server on every
 * request like getUser() does — noticeably faster for every page load and
 * button press. It refreshes the session first if the token is about to expire.
 */
export async function getUserId(supabase: SupabaseClient): Promise<string | null> {
  try {
    const { data, error } = await supabase.auth.getClaims()
    if (error) return null
    return (data?.claims?.sub as string | undefined) ?? null
  } catch {
    return null
  }
}
