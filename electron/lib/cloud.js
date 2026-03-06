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
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
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

  const resolution  = (kase.resolution ?? '').trim()
  const symptoms    = [...new Set(inputs.flatMap(m => m.symptoms ?? []))]
  const obdCodes    = [...new Set(inputs.flatMap(m => m.obdCodes ?? []))]
  const description = inputs.map(m => m.text ?? '').filter(Boolean).join(' ').trim()

  // ── Resolution ──────────────────────────────────────────────────────────────

  if (!resolution) {
    return { ok: false, reason: 'Chybí popis provedené opravy.' }
  }
  if (resolution.length < 10) {
    return { ok: false, reason: `Popis opravy je příliš krátký (${resolution.length} znaků, minimum 10).` }
  }
  if (resolution.length > 200) {
    return { ok: false, reason: `Popis opravy je příliš dlouhý (${resolution.length} znaků, maximum 200).` }
  }

  // Detekce opakujících se znaků — "aaaaaaa", "12312312"
  if (/(.)\1{6,}/.test(resolution)) {
    return { ok: false, reason: 'Popis opravy obsahuje opakující se znaky.' }
  }

  // Minimálně 4 unikátní slova (>2 znaky) v resolution
  const uniqueWords = new Set(
    resolution.toLowerCase().split(/\s+/).filter(w => w.length > 2)
  )
  if (uniqueWords.size < 4) {
    return { ok: false, reason: 'Popis opravy je příliš stručný — přidejte více informací.' }
  }

  // ── Diagnostické signály ────────────────────────────────────────────────────
  // Alespoň jeden z: OBD kód, příznak, nebo manuální popis (>20 znaků)

  const hasObd      = obdCodes.length > 0
  const hasSymptom  = symptoms.length > 0
  const hasDesc     = description.length >= 20

  if (!hasObd && !hasSymptom && !hasDesc) {
    return { ok: false, reason: 'Případ musí obsahovat OBD kód, příznak nebo popis problému (alespoň 20 znaků).' }
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
    mileage:         kase.vehicle?.mileage ? parseInt(kase.vehicle.mileage, 10) || null : null,
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
 *
 * Před odesláním provede klientskou validaci.
 * Pokud instalace překročila limit porušení, push se zamítne a zaloguje.
 *
 * @param {string}  supabaseUrl
 * @param {string}  anonKey
 * @param {string}  installationId
 * @param {Object}  kase
 * @param {Object}  violationState  - { count, blocked } z electron-store
 * @returns {Promise<{ ok: boolean, blocked: boolean, violation: string|null, error: string|null }>}
 */
async function pushCase(supabaseUrl, anonKey, installationId, kase, violationState = { count: 0, blocked: false }) {

  // Blokovaná instalace
  if (violationState.blocked) {
    return { ok: false, blocked: true, violation: null, error: 'Instalace je blokována kvůli opakovanému porušování pravidel.' }
  }

  // Klientská validace
  const { ok, reason } = validateCase(kase)
  if (!ok) {
    return { ok: false, blocked: false, violation: reason, error: null }
  }

  // Push do Supabase
  try {
    const row = caseToRow(kase, installationId)
    await supabaseRequest(
      'POST', supabaseUrl, anonKey,
      '/rest/v1/gearbrain_cases',
      row,
      8000,
      { 'Prefer': 'return=minimal,resolution=ignore-duplicates' }
    )
    return { ok: true, blocked: false, violation: null, error: null }
  } catch (e) {
    return { ok: false, blocked: false, violation: null, error: e.message }
  }
}

/**
 * Zaloguje porušení pravidel do Supabase.
 * Databázový trigger na této tabulce pošle email notifikaci.
 * Fire-and-forget — chyba se tiše ignoruje.
 */
async function reportViolation(supabaseUrl, anonKey, installationId, reason, violationCount) {
  try {
    await supabaseRequest(
      'POST', supabaseUrl, anonKey,
      '/rest/v1/gearbrain_violations',
      {
        installation_id:  installationId,
        reason,
        violation_count:  violationCount,
        blocked:          violationCount >= 3,
      },
      5000,
      { 'Prefer': 'return=minimal' }
    )
  } catch (_) { /* tiše ignorujeme — notifikace není kritická */ }
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
 * Stáhne celou databázi z Supabase pro lokální RAG cache.
 */
async function fetchAll(supabaseUrl, anonKey, limit = 10000) {
  try {
    const path = `/rest/v1/gearbrain_cases?select=*&order=closed_at.desc&limit=${limit}`
    const { body: rows } = await supabaseRequest('GET', supabaseUrl, anonKey, path, null, 20000)
    if (!Array.isArray(rows)) return { cases: [], count: 0, limitReached: false, error: 'Neočekávaná odpověď', fetchedAt: null }
    return {
      cases:        rows.map(rowToCase),
      count:        rows.length,
      limitReached: rows.length === limit,
      error:        null,
      fetchedAt:    new Date().toISOString(),
    }
  } catch (e) {
    return { cases: [], count: 0, limitReached: false, error: e.message, fetchedAt: null }
  }
}

module.exports = { pushCase, reportViolation, fetchAll, testConnection, validateCase, caseToRow, rowToCase }
