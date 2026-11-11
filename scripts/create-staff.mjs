// Creates (or updates) staff logins + profiles in the Supabase project.
//
// Usage (from the project root, after updating .env with the NEW project):
//   cp scripts/staff.example.json scripts/staff.json   # then set real passwords
//   node --env-file=.env scripts/create-staff.mjs scripts/staff.json
//
// scripts/staff.json is git-ignored — never commit passwords.
import { readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !serviceKey) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (e.g. --env-file=.env).")
  process.exit(1)
}
const file = process.argv[2]
if (!file) {
  console.error("Usage: node --env-file=.env scripts/create-staff.mjs scripts/staff.json")
  process.exit(1)
}

const staff = JSON.parse(readFileSync(file, "utf8"))
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

// Existing users, so the script can be re-run safely.
const existing = new Map()
for (let page = 1; ; page++) {
  const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
  if (error) throw error
  for (const u of data.users) existing.set(u.email, u.id)
  if (data.users.length < 1000) break
}

let failed = 0
for (const s of staff) {
  const username = s.username.trim().toLowerCase()
  const email = `${username}@sgn.local` // must match usernameToEmail() in lib/types.ts
  try {
    if (!s.password || s.password.length < 6) throw new Error("password must be at least 6 characters")
    let id = existing.get(email)
    if (id) {
      const { error } = await admin.auth.admin.updateUserById(id, { password: s.password, email_confirm: true })
      if (error) throw error
    } else {
      const { data, error } = await admin.auth.admin.createUser({ email, password: s.password, email_confirm: true })
      if (error) throw error
      id = data.user.id
    }
    const { error: pErr } = await admin.from("profiles").upsert({
      id,
      username,
      full_name: s.full_name ?? username,
      role: s.role,
      counter: s.counter ?? null,
    })
    if (pErr) throw pErr
    console.log(`ok   ${username.padEnd(10)} ${s.role}${s.counter ? ` (counter ${s.counter})` : ""}`)
  } catch (e) {
    failed++
    console.error(`FAIL ${username}: ${e.message}`)
  }
}
process.exit(failed ? 1 : 0)
