/**
 * GearBrain — Edge Function: search-cases
 *
 * Přijme diagnostický vstup, provede RAG scoring nad gearbrain_cases
 * a vrátí max 5 nejrelevantnějších výsledků.
 *
 * Anon role nemá přímý SELECT na tabulku — veškerý přístup k datům
 * prochází touto funkcí která nikdy nevrátí více než 5 záznamů.
 *
 * POST /functions/v1/search-cases
 * Body: { vehicle, symptoms, obdCodes, text, installationId }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Scoring konstanty (shodné s src/lib/rag.js) ───────────────────────────────
const OWN_THRESHOLD   = 6
const OTHER_THRESHOLD = 10
const MAX_TEXT_SCORE  = 2

function computeSimilarity(row: any, input: any): number {
  const allText = [
    ...(row.symptoms  ?? []),
    ...(row.obd_codes ?? []),
    row.description ?? '',
  ].join(' ').toLowerCase()

  let score = 0

  if (input.vehicle?.brand && row.vehicle_brand === input.vehicle.brand) score += 2
  if (input.vehicle?.model && row.vehicle_model === input.vehicle.model) score += 3

  for (const code of input.obdCodes ?? []) {
    if (allText.includes(code.toLowerCase())) score += 4
  }
  for (const sym of input.symptoms ?? []) {
    if (allText.includes(sym.toLowerCase())) score += 1.5
  }

  let textScore = 0
  for (const word of (input.text ?? '').toLowerCase().split(/\s+/).filter((w: string) => w.length > 4)) {
    if (allText.includes(word)) {
      textScore = Math.min(textScore + 0.3, MAX_TEXT_SCORE)
      if (textScore >= MAX_TEXT_SCORE) break
    }
  }
  score += textScore

  return score
}

function rowToCase(row: any) {
  return {
    id:             row.id,
    localId:        row.local_id,
    name:           `[Cloud] ${row.vehicle_model || 'Transit'} | ${row.resolution.slice(0, 40)}`,
    status:         'uzavřený',
    createdAt:      row.created_at,
    closedAt:       row.closed_at,
    resolution:     row.resolution,
    fromCloud:      true,
    installationId: row.installation_id,
    vehicle: {
      brand:   row.vehicle_brand  || 'Ford',
      model:   row.vehicle_model  || '',
      mileage: row.mileage?.toString() || '',
    },
    messages: [{
      id:        row.id + '_input',
      type:      'input',
      symptoms:  row.symptoms  ?? [],
      obdCodes:  row.obd_codes ?? [],
      text:      row.description || '',
      timestamp: row.created_at,
    }],
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  // CORS pro Electron (file:// origin)
  const corsHeaders = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { vehicle, symptoms, obdCodes, text, installationId } = await req.json()

    // Service role klient — má přístup k tabulce i přes zakázaný anon SELECT
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } }
    )

    // Předfiltrování na DB úrovni — kandidáti podle OBD kódů nebo modelu
    // (max 200 kandidátů, scoring proběhne zde)
    let query = supabase
      .from('gearbrain_cases')
      .select('*')
      .order('closed_at', { ascending: false })
      .limit(200)

    if (obdCodes?.length > 0) {
      query = query.overlaps('obd_codes', obdCodes)
    } else if (vehicle?.model) {
      query = query.eq('vehicle_model', vehicle.model)
    }

    const { data: rows, error } = await query

    if (error) throw error

    const input = { vehicle, symptoms, obdCodes, text }

    // Scoring + filtrování + řazení
    const scored = (rows ?? []).map((row: any) => {
      const score     = computeSimilarity(row, input)
      const isOwn     = row.installation_id === installationId
      const threshold = isOwn ? OWN_THRESHOLD : OTHER_THRESHOLD
      return { row, score, isOwn, passes: score >= threshold }
    })

    const results = scored
      .filter((x: any) => x.passes)
      .sort((a: any, b: any) =>
        b.score - a.score ||
        (a.isOwn && !b.isOwn ? -1 : !a.isOwn && b.isOwn ? 1 : 0)
      )
      .slice(0, 5)
      .map((x: any) => ({ ...rowToCase(x.row), ragScore: x.score, ragIsOwn: x.isOwn }))

    return new Response(
      JSON.stringify({ cases: results, count: results.length }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (e: any) {
    return new Response(
      JSON.stringify({ cases: [], count: 0, error: e.message }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      // 200 i při chybě — aplikace tiše pokračuje bez RAG
    )
  }
})
