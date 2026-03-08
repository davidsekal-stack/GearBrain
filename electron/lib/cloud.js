/**
 * GearBrain Cloud — Supabase REST klient
 *
 * Ochrana databáze — dvouvrstvá:
 *   Vrstva 1 (klient): validateCase() před každým pushem
 *   Vrstva 2 (DB):     CHECK constraints + RLS rate limit (viz SUPABASE_SETUP.md)
 *
 * Blokování:
 *   Po 3 validačních porušeních se instalace zablokuje (uloženo v electron-store).
 *   Blokování se reportuje do tabulky gearbrain_violations → trigger pošle email.
 *
 * Idempotentní push:
 *   local_id + unique index na (installation_id, local_id) zabraňuje duplicitám.
 */

const https = require('https')
const { validateResolution } = require('./validation.js')

// ── HTTP helper ───────────────────────────────────────────────────────────────

function supabaseRequest(method, supabaseUrl, anonKey, path, body = null, timeoutMs = 8000, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url     = new URL(path, supabaseUrl)
    const payload = body ? JSON.stringify(body) : null

    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method,
      headers: {
        'apikey':        anonKey,
        'Authorization': `Bearer ${anonKey}`,
        'Content-Type':  'application/json',
        ...extraHeaders,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }

    const req = https.request(options, (res) => {
      const chunks = []
      res.on('data', c => { chunks.push(c) })
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8')
        if (!data.trim()) { resolve({ body: [], headers: res.headers }); return }
        try {
          const parsed = JSON.parse(data)
          if (parsed.code && parsed.message) {
            reject(new Error(`Supabase: ${parsed.message}`))
          } else {
            resolve({ body: parsed, headers: res.headers })
          }
        } catch {
          reject(new Error('Chyba parsování odpovědi Supabase'))
        }
      })
    })

    req.on('error', e => reject(new Error(`Síťová chyba: ${e.message}`)))
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')) })
    if (payload) req.write(payload)
    req.end()
  })
}

// ── Validace před odesláním ───────────────────────────────────────────────────

const OBD_REGEX = /^[PCBU][0-9A-F]{4}$/

/**
 * Validuje případ před odesláním do cloudové databáze.
 * Odpovídá CHECK constraints v Supabase (vrstva 1 — klient).
 *
 * @param {Object} kase - případ ve formátu GearBrain
 * @returns {{ ok: boolean, reason: string|null }}
 */
function validateCase(kase) {
  const inputs = (kase.messages ?? []).filter(m => m.type === 'input')

  const symptoms    = [...new Set(inputs.flatMap(m => m.symptoms ?? []))]
  const obdCodes    = [...new Set(inputs.flatMap(m => m.obdCodes ?? []))]
  const description = inputs.map(m => m.text ?? '').filter(Boolean).join(' ').trim()

  // ── Resolution (sdílená validace) ─────────────────────────────────────────
  const resVal = validateResolution(kase.resolution)
  if (!resVal.ok) return resVal

  // ── Diagnostické signály ────────────────────────────────────────────────────
  // Alespoň jeden z: OBD kód, příznak, nebo manuální popis (≥10 znaků)

  const hasObd      = obdCodes.length > 0
  const hasSymptom  = symptoms.length > 0
  const hasDesc     = description.length >= 10

  if (!hasObd && !hasSymptom && !hasDesc) {
    return { ok: false, reason: 'Případ musí obsahovat OBD kód, příznak nebo popis problému (alespoň 10 znaků).' }
  }

  // ── Formát OBD kódů ─────────────────────────────────────────────────────────

  for (const code of obdCodes) {
    if (!OBD_REGEX.test(code)) {
      return { ok: false, reason: `Neplatný formát OBD kódu: ${code}` }
    }
  }

  // ── Model vozidla ───────────────────────────────────────────────────────────

  if (!kase.vehicle?.model) {
    return { ok: false, reason: 'Případ musí mít vybraný model vozidla.' }
  }

  return { ok: true, reason: null }
}

// ── Transformace dat ──────────────────────────────────────────────────────────

function caseToRow(kase, installationId) {
  const inputs = kase.messages.filter(m => m.type === 'input')

  const symptoms    = [...new Set(inputs.flatMap(m => m.symptoms ?? []))]
  const obdCodes    = [...new Set(inputs.flatMap(m => m.obdCodes ?? []))]
  const description = inputs.map(m => m.text).filter(Boolean).join('\n') || null

  return {
    local_id:        kase.id,
    installation_id: installationId,
    vehicle_brand:   kase.vehicle?.brand  || null,
    vehicle_model:   kase.vehicle?.model  || null,
    mileage:         kase.vehicle?.mileage ? (parseInt(kase.vehicle.mileage, 10) ?? null) : null,
    symptoms,
    obd_codes:       obdCodes,
    description,
    resolution:      kase.resolution,
    closed_at:       kase.closedAt || new Date().toISOString(),
  }
}

function rowToCase(row) {
  return {
    id:             row.id,
    localId:        row.local_id,
    name:           `[Cloud] ${row.vehicle_brand ? row.vehicle_brand + ' ' : ''}${row.vehicle_model || 'Neznámý model'} | ${row.resolution.slice(0, 40)}`,
    status:         'uzavřený',
    createdAt:      row.created_at,
    closedAt:       row.closed_at,
    resolution:     row.resolution,
    fromCloud:      true,
    installationId: row.installation_id,
    vehicle: {
      brand:   row.vehicle_brand  || '',
      model:   row.vehicle_model  || '',
      mileage: row.mileage?.toString() || '',
    },
    messages: [
      {
        id:        row.id + '_input',
        type:      'input',
        symptoms:  row.symptoms  ?? [],
        obdCodes:  row.obd_codes ?? [],
        text:      row.description || '',
        timestamp: row.created_at,
      },
    ],
  }
}

// ── Veřejné API ───────────────────────────────────────────────────────────────

/**
 * Odešle uzavřený případ do globální Supabase databáze.
 * Validace proběhla v UI před uzavřením — zde jen druhá obranná vrstva + push.
 *
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
async function pushCase(supabaseUrl, anonKey, installationId, kase) {
  // Druhá obranná vrstva — pro případ přímého volání mimo UI
  const { ok, reason } = validateCase(kase)
  if (!ok) return { ok: false, error: reason }

  try {
    const row = caseToRow(kase, installationId)
    await supabaseRequest(
      'POST', supabaseUrl, anonKey,
      '/rest/v1/gearbrain_cases',
      row,
      8000,
      { 'Prefer': 'return=minimal,resolution=ignore-duplicates' }
    )
    return { ok: true, error: null }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/**
 * Otestuje spojení se Supabase (HEAD + Content-Range pro počet).
 */
async function testConnection(supabaseUrl, anonKey) {
  return new Promise((resolve) => {
    const url = new URL('/rest/v1/gearbrain_cases?select=id', supabaseUrl)
    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'HEAD',
      headers: {
        'apikey':        anonKey,
        'Authorization': `Bearer ${anonKey}`,
        'Prefer':        'count=exact',
      },
    }
    const req = https.request(options, (res) => {
      const range = res.headers['content-range'] ?? ''
      const match = range.match(/\/(\d+)$/)
      const count = match ? parseInt(match[1], 10) : null
      if (res.statusCode >= 400) {
        resolve({ ok: false, count: null, error: `HTTP ${res.statusCode}` })
      } else {
        resolve({ ok: true, count, error: null })
      }
    })
    req.on('error', e => resolve({ ok: false, count: null, error: e.message }))
    req.setTimeout(6000, () => { req.destroy(); resolve({ ok: false, count: null, error: 'Timeout' }) })
    req.end()
  })
}


/**
 * Zavolá Edge Function search-cases která provede RAG scoring na straně serveru.
 * Vrátí max 5 nejrelevantnějších výsledků — nikdy celou databázi.
 *
 * Anon klíč opravňuje pouze volání této funkce.
 * Přímý SELECT na tabulku gearbrain_cases je pro anon zakázán.
 *
 * @returns {Promise<{ cases: Object[], error: string|null }>}
 */
async function searchCases(supabaseUrl, anonKey, input, installationId) {
  try {
    const { body } = await supabaseRequest(
      'POST', supabaseUrl, anonKey,
      '/functions/v1/search-cases',
      { ...input, installationId },
      8000,
      { 'Prefer': '' }
    )
    const cases = Array.isArray(body?.cases) ? body.cases : []
    return { cases, error: null }
  } catch (e) {
    // Síťová chyba / timeout — offline degradation, diagnostika pokračuje bez RAG
    return { cases: [], error: e.message }
  }
}

module.exports = { pushCase, searchCases, testConnection, validateCase, validateResolution, caseToRow, rowToCase }
