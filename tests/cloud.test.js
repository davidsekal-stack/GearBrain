/**
 * Unit testy pro electron/lib/cloud.js
 *
 * Testuje pouze čistou logiku (transformace dat).
 * Síťové volání supabaseRequest se netestuje (vyžaduje živé Supabase).
 *
 * Spuštění: node tests/cloud.test.js
 */

const assert = require('assert')
const { caseToRow, rowToCase } = require('../electron/lib/cloud.js')

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e.message}`)
    failed++
  }
}

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  assert.strictEqual(a, e, msg || `got ${a}, expected ${e}`)
}

// ── Testovací fixtures ────────────────────────────────────────────────────────

const INSTALL_ID = 'test-uuid-1234'

const FULL_CASE = {
  id:         'case-abc',
  name:       'Transit 2.2 TDCi | EGR chyba',
  status:     'uzavřený',
  createdAt:  '2025-01-15T10:00:00Z',
  closedAt:   '2025-01-16T14:30:00Z',
  resolution: 'Vyměněn EGR ventil, kód P0401 vymazán.',
  vehicle: {
    brand:   'Ford',
    model:   'Transit 2.2 TDCi (2006–2014)',
    mileage: '185000',
  },
  messages: [
    {
      id:        'msg-1',
      type:      'input',
      symptoms:  ['Ztráta výkonu', 'Černý kouř'],
      obdCodes:  ['P0401', 'P0403'],
      text:      'Přešel do nouzového režimu při vyšším výkonu.',
      timestamp: '2025-01-15T10:05:00Z',
    },
    {
      id:        'msg-2',
      type:      'diagnosis',
      result:    { závady: [] },
      timestamp: '2025-01-15T10:06:00Z',
    },
    {
      id:        'msg-3',
      type:      'input',
      symptoms:  ['Kouř z výfuku'],
      obdCodes:  ['P2563'],
      text:      'Po testu EGR průtoku nulový průtok.',
      timestamp: '2025-01-15T11:00:00Z',
    },
  ],
}

const MINIMAL_CASE = {
  id:         'case-min',
  status:     'uzavřený',
  createdAt:  '2025-02-01T08:00:00Z',
  closedAt:   '2025-02-01T09:00:00Z',
  resolution: 'Vyměněn filtr DPF.',
  vehicle:    { brand: '', model: '', mileage: '' },
  messages:   [],
}

// ── caseToRow ─────────────────────────────────────────────────────────────────

console.log('\n── caseToRow ─────────────────────────────────────────────────────')

test('Extrahuje installation_id', () => {
  const row = caseToRow(FULL_CASE, INSTALL_ID)
  eq(row.installation_id, INSTALL_ID)
})

test('Extrahuje vehicle_model a vehicle_brand', () => {
  const row = caseToRow(FULL_CASE, INSTALL_ID)
  eq(row.vehicle_brand, 'Ford')
  eq(row.vehicle_model, 'Transit 2.2 TDCi (2006–2014)')
})

test('Převede mileage na integer', () => {
  const row = caseToRow(FULL_CASE, INSTALL_ID)
  eq(row.mileage, 185000)
  assert(typeof row.mileage === 'number', 'mileage má být number')
})

test('Spojí příznaky ze všech vstupních zpráv a deduplikuje', () => {
  const row = caseToRow(FULL_CASE, INSTALL_ID)
  // Příznaky z msg-1 a msg-3 (msg-2 je diagnosis, ne input)
  assert(row.symptoms.includes('Ztráta výkonu'), 'chybí Ztráta výkonu')
  assert(row.symptoms.includes('Černý kouř'), 'chybí Černý kouř')
  assert(row.symptoms.includes('Kouř z výfuku'), 'chybí Kouř z výfuku')
  eq(row.symptoms.length, 3) // žádné duplicity
})

test('Spojí OBD kódy ze všech vstupních zpráv a deduplikuje', () => {
  const row = caseToRow(FULL_CASE, INSTALL_ID)
  assert(row.obd_codes.includes('P0401'), 'chybí P0401')
  assert(row.obd_codes.includes('P0403'), 'chybí P0403')
  assert(row.obd_codes.includes('P2563'), 'chybí P2563')
  eq(row.obd_codes.length, 3)
})

test('Spojí texty z input zpráv do description', () => {
  const row = caseToRow(FULL_CASE, INSTALL_ID)
  assert(row.description.includes('nouzového režimu'), 'chybí první text')
  assert(row.description.includes('EGR průtoku'), 'chybí druhý text')
})

test('Ukládá resolution', () => {
  const row = caseToRow(FULL_CASE, INSTALL_ID)
  eq(row.resolution, 'Vyměněn EGR ventil, kód P0401 vymazán.')
})

test('closedAt se mapuje správně', () => {
  const row = caseToRow(FULL_CASE, INSTALL_ID)
  eq(row.closed_at, '2025-01-16T14:30:00Z')
})

test('Minimální případ — prázdné pole pro symptoms a obd_codes', () => {
  const row = caseToRow(MINIMAL_CASE, INSTALL_ID)
  eq(row.symptoms,  [])
  eq(row.obd_codes, [])
})

test('Minimální případ — null pro brand/model při prázdném stringu', () => {
  const row = caseToRow(MINIMAL_CASE, INSTALL_ID)
  eq(row.vehicle_brand, null)
  eq(row.vehicle_model, null)
})

test('Minimální případ — null pro mileage při prázdném stringu', () => {
  const row = caseToRow(MINIMAL_CASE, INSTALL_ID)
  eq(row.mileage, null)
})

test('Minimální případ — null pro description při žádném textu', () => {
  const row = caseToRow(MINIMAL_CASE, INSTALL_ID)
  eq(row.description, null)
})

test('Mileage "abc" (nečíslo) → null, nevyhazuje výjimku', () => {
  const badCase = { ...MINIMAL_CASE, vehicle: { mileage: 'abc' } }
  const row = caseToRow(badCase, INSTALL_ID)
  eq(row.mileage, null)
})

test('Neuložuje id případu (generuje ho Supabase)', () => {
  const row = caseToRow(FULL_CASE, INSTALL_ID)
  assert(!('id' in row), 'row nesmí obsahovat id')
})

// ── rowToCase ─────────────────────────────────────────────────────────────────

console.log('\n── rowToCase ─────────────────────────────────────────────────────')

const SUPABASE_ROW = {
  id:            'uuid-cloud-1',
  installation_id: 'uuid-install-99',
  vehicle_brand: 'Ford',
  vehicle_model: 'Transit 2.2 TDCi (2006–2014)',
  mileage:       210000,
  symptoms:      ['Ztráta výkonu', 'Černý kouř'],
  obd_codes:     ['P0401'],
  description:   'Přešel do nouzového režimu.',
  resolution:    'Vyměněn EGR ventil.',
  created_at:    '2025-01-10T08:00:00Z',
  closed_at:     '2025-01-11T12:00:00Z',
}

test('Vrátí status "uzavřený"', () => {
  const c = rowToCase(SUPABASE_ROW)
  eq(c.status, 'uzavřený')
})

test('Nastaví fromCloud: true', () => {
  const c = rowToCase(SUPABASE_ROW)
  eq(c.fromCloud, true)
})

test('Zachová id z Supabase', () => {
  const c = rowToCase(SUPABASE_ROW)
  eq(c.id, 'uuid-cloud-1')
})

test('Vytvoří syntetickou input zprávu', () => {
  const c = rowToCase(SUPABASE_ROW)
  const inputs = c.messages.filter(m => m.type === 'input')
  eq(inputs.length, 1)
})

test('Input zpráva obsahuje symptoms a obd_codes', () => {
  const c = rowToCase(SUPABASE_ROW)
  const input = c.messages.find(m => m.type === 'input')
  eq(input.symptoms, ['Ztráta výkonu', 'Černý kouř'])
  eq(input.obdCodes, ['P0401'])
})

test('Input zpráva obsahuje description jako text', () => {
  const c = rowToCase(SUPABASE_ROW)
  const input = c.messages.find(m => m.type === 'input')
  eq(input.text, 'Přešel do nouzového režimu.')
})

test('vehicle objekt správně namapován', () => {
  const c = rowToCase(SUPABASE_ROW)
  eq(c.vehicle.brand, 'Ford')
  eq(c.vehicle.model, 'Transit 2.2 TDCi (2006–2014)')
  eq(c.vehicle.mileage, '210000')
})

test('resolution zachována', () => {
  const c = rowToCase(SUPABASE_ROW)
  eq(c.resolution, 'Vyměněn EGR ventil.')
})

test('Null obd_codes → prázdné pole obdCodes', () => {
  const row = { ...SUPABASE_ROW, obd_codes: null }
  const c   = rowToCase(row)
  const input = c.messages.find(m => m.type === 'input')
  eq(input.obdCodes, [])
})

test('Null symptoms → prázdné pole symptoms', () => {
  const row = { ...SUPABASE_ROW, symptoms: null }
  const c   = rowToCase(row)
  const input = c.messages.find(m => m.type === 'input')
  eq(input.symptoms, [])
})

test('Null vehicle_brand → fallback "Ford"', () => {
  const row = { ...SUPABASE_ROW, vehicle_brand: null }
  const c   = rowToCase(row)
  eq(c.vehicle.brand, 'Ford')
})

// ── Roundtrip test ────────────────────────────────────────────────────────────

console.log('\n── Roundtrip (caseToRow → rowToCase) ────────────────────────────')

test('Roundtrip zachová symptoms', () => {
  const row = caseToRow(FULL_CASE, INSTALL_ID)
  // Simulujeme Supabase odpověď (přidáme id a created_at)
  const supaRow = { ...row, id: 'new-uuid', created_at: '2025-01-15T10:00:00Z', obd_codes: row.obd_codes }
  const restored = rowToCase(supaRow)
  const input = restored.messages.find(m => m.type === 'input')
  assert(input.symptoms.includes('Ztráta výkonu'), 'chybí příznak po roundtrip')
})

test('Roundtrip zachová OBD kódy', () => {
  const row    = caseToRow(FULL_CASE, INSTALL_ID)
  const supaRow = { ...row, id: 'new-uuid', created_at: '2025-01-15T10:00:00Z', obd_codes: row.obd_codes }
  const restored = rowToCase(supaRow)
  const input  = restored.messages.find(m => m.type === 'input')
  assert(input.obdCodes.includes('P0401'), 'chybí OBD kód po roundtrip')
  assert(input.obdCodes.includes('P2563'), 'chybí P2563 po roundtrip')
})

test('Roundtrip zachová resolution', () => {
  const row    = caseToRow(FULL_CASE, INSTALL_ID)
  const supaRow = { ...row, id: 'new-uuid', created_at: '2025-01-15T10:00:00Z', obd_codes: row.obd_codes }
  const restored = rowToCase(supaRow)
  eq(restored.resolution, FULL_CASE.resolution)
})

// ── Výsledky ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`)
console.log(`Výsledky: ${passed} prošlo, ${failed} selhalo`)
if (failed > 0) process.exit(1)
else console.log('✓ Všechny testy prošly\n')
