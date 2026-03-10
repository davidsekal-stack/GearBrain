/**
 * Web storage layer — CRUD pro případy přes Supabase
 *
 * Tabulka: gearbrain_web_sessions
 *   - id (UUID, PK)
 *   - user_id (UUID, FK → auth.users)
 *   - data (JSONB — celý case objekt)
 *   - status ('open' | 'closed')
 *   - created_at, updated_at
 *
 * Při uzavření případu se navíc pushne normalizovaný záznam do gearbrain_cases
 * (pro RAG — stejný formát jako Electron verze).
 */

import { supabase } from './supabase.js'

const TABLE = 'gearbrain_web_sessions'

// ── Load all cases for current user ────────────────────────────────────────────

export async function loadCases() {
  const { data, error } = await supabase
    .from(TABLE)
    .select('id, data, status, created_at, updated_at')
    .order('created_at', { ascending: false })

  if (error) throw error
  return (data ?? []).map(row => ({
    ...row.data,
    _rowId: row.id,
    _status: row.status,
  }))
}

// ── Create a new case ──────────────────────────────────────────────────────────

export async function createCase(caseData) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Nepřihlášen')

  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      user_id: user.id,
      data: caseData,
      status: 'open',
    })
    .select('id')
    .single()

  if (error) throw error
  return data.id
}

// ── Update an existing case ────────────────────────────────────────────────────

export async function updateCase(caseId, caseData, status = 'open') {
  const { error } = await supabase
    .from(TABLE)
    .update({
      data: caseData,
      status,
      updated_at: new Date().toISOString(),
    })
    .eq('data->>id', caseId)

  if (error) throw error
}

// ── Delete a case ──────────────────────────────────────────────────────────────

export async function deleteCase(caseId) {
  const { error } = await supabase
    .from(TABLE)
    .delete()
    .eq('data->>id', caseId)

  if (error) throw error
}

// ── Push closed case to RAG database ───────────────────────────────────────────

export async function pushClosedCase(kase) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Nepřihlášen' }

  const inputs = (kase.messages ?? []).filter(m => m.type === 'input')
  const symptoms  = [...new Set(inputs.flatMap(m => m.symptoms ?? []))]
  const obdCodes  = [...new Set(inputs.flatMap(m => m.obdCodes ?? []))]
  const texts     = inputs.map(m => m.text).filter(Boolean)

  const mileage = parseInt(kase.vehicle?.mileage, 10)

  const row = {
    local_id:        kase.id,
    user_id:         user.id,
    installation_id: user.id,  // web uses user_id as installation_id
    vehicle_brand:   kase.vehicle?.brand || null,
    vehicle_model:   kase.vehicle?.model || null,
    mileage:         Number.isFinite(mileage) ? mileage : null,
    engine_power:    kase.vehicle?.enginePower || null,
    symptoms,
    obd_codes:       obdCodes,
    description:     texts.join(' ') || null,
    resolution:      kase.resolution,
    closed_at:       kase.closedAt || new Date().toISOString(),
  }

  const { error } = await supabase
    .from('gearbrain_cases')
    .upsert(row, { onConflict: 'installation_id,local_id' })

  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

// ── Supabase Edge Function URL + auth headers ────────────────────────────────

const FUNCTIONS_URL = 'https://nmvjthfezyjcwuzphiuu.supabase.co/functions/v1'

async function edgeFetch(fnName, body) {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  const res = await fetch(`${FUNCTIONS_URL}/${fnName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5tdmp0aGZlenlqY3d1enBoaXV1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3MzcwNTAsImV4cCI6MjA4ODMxMzA1MH0.acMPCJe2asOToPXg6DQccejtLOUbD8EMx9Z9FqWo_xo',
    },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok && data.error) throw new Error(data.error.message || `Edge Function ${fnName}: HTTP ${res.status}`)
  return data
}

// ── Call Claude via Edge Function ──────────────────────────────────────────────

export async function callClaude({ systemPrompt, userMessage, maxTokens = 4000, model = 'claude-sonnet-4-6' }) {
  const { data: { user } } = await supabase.auth.getUser()

  return edgeFetch('anthropic-proxy', {
    model,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
    max_tokens: maxTokens,
    installation_id: user?.id ?? 'web-anonymous',
  })
}

// ── Search cases via Edge Function ─────────────────────────────────────────────

export async function searchCases(ragInput) {
  const { data: { user } } = await supabase.auth.getUser()

  try {
    return await edgeFetch('search-cases', {
      vehicle:        ragInput.vehicle,
      symptoms:       ragInput.symptoms,
      obdCodes:       ragInput.obdCodes,
      text:           ragInput.text,
      installationId: user?.id ?? 'web-anonymous',
    })
  } catch {
    return { cases: [], count: 0 }
  }
}
