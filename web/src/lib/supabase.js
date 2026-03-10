import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL      = 'https://nmvjthfezyjcwuzphiuu.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5tdmp0aGZlenlqY3d1enBoaXV1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3MzcwNTAsImV4cCI6MjA4ODMxMzA1MH0.acMPCJe2asOToPXg6DQccejtLOUbD8EMx9Z9FqWo_xo'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// ── Auth helpers ────────────────────────────────────────────────────────────────

/** Registrace emailem + heslem */
export async function signUp(email, password) {
  const { data, error } = await supabase.auth.signUp({ email, password })
  if (error) throw error
  return data
}

/** Přihlášení emailem + heslem */
export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw error
  return data
}

/** Přihlášení přes Google OAuth */
export async function signInWithGoogle() {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  })
  if (error) throw error
  return data
}

/** Odhlášení */
export async function signOut() {
  const { error } = await supabase.auth.signOut()
  if (error) throw error
}

/** Aktuální session */
export async function getSession() {
  const { data: { session } } = await supabase.auth.getSession()
  return session
}

/** Aktuální user */
export async function getUser() {
  const { data: { user } } = await supabase.auth.getUser()
  return user
}
