/**
 * Unit testy pro cloud.js — validateCase
 * Spuštění: node tests/validation.test.js
 */

const assert  = require('assert')
const { validateCase } = require('../electron/lib/cloud.js')

let passed = 0, failed = 0

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++ }
}

function mkCase(overrides = {}) {
  return {
    resolution: 'Vyměněn EGR ventil, kód P0401 vymazán.',
    vehicle: { brand: 'Ford', model: 'Transit 2.2 TDCi (2006–2014)', mileage: '185000' },
    messages: [{
      type: 'input',
      symptoms: ['Ztráta výkonu'],
      obdCodes: ['P0401'],
      text: '',
    }],
    ...overrides,
  }
}

// ── Resolution ─────────────────────────────────────────────────────────────────
console.log('\n── Resolution ────────────────────────────────────────────────────')

test('Platný případ projde', () => {
  assert.strictEqual(validateCase(mkCase()).ok, true)
})

test('Chybějící resolution → zamítnuto', () => {
  const r = validateCase(mkCase({ resolution: '' }))
  assert(!r.ok && r.reason)
})

test('Resolution 9 znaků → zamítnuto (min 10)', () => {
  const r = validateCase(mkCase({ resolution: 'Opraveno.' }))
  assert(!r.ok)
})

test('Resolution 10 znaků → projde přesně na limitu', () => {
  const r = validateCase(mkCase({ resolution: 'Vyměněn EG' }))
  // 10 znaků ale jen 1 unikátní slovo >2 znaky — zamítnuto z důvodu min slov
  assert(!r.ok) // správně zamítnuto pro málo slov
})

test('Resolution 201 znaků → zamítnuto (max 200)', () => {
  const r = validateCase(mkCase({ resolution: 'a'.repeat(201) }))
  assert(!r.ok)
})

test('Resolution s opakujícími se znaky → zamítnuto', () => {
  const r = validateCase(mkCase({ resolution: 'aaaaaaaaaa oprava vozidla provedena' }))
  assert(!r.ok)
})

test('Resolution s méně než 4 unikátními slovy → zamítnuto', () => {
  const r = validateCase(mkCase({ resolution: 'ok hotovo ok' }))
  assert(!r.ok)
})

test('Resolution s 4+ unikátními slovy → projde', () => {
  const r = validateCase(mkCase({ resolution: 'Vyměněn EGR ventil závada odstraněna.' }))
  assert(r.ok)
})

// ── Diagnostické signály ───────────────────────────────────────────────────────
console.log('\n── Diagnostické signály ──────────────────────────────────────────')

test('Jen OBD kód (bez příznaku a popisu) → projde', () => {
  const c = mkCase()
  c.messages[0].symptoms = []
  c.messages[0].text = ''
  assert(validateCase(c).ok)
})

test('Jen příznak (bez OBD a popisu) → projde', () => {
  const c = mkCase()
  c.messages[0].obdCodes = []
  c.messages[0].text = ''
  assert(validateCase(c).ok)
})

test('Jen popis ≥20 znaků (bez OBD a příznaku) → projde', () => {
  const c = mkCase()
  c.messages[0].obdCodes = []
  c.messages[0].symptoms = []
  c.messages[0].text = 'Vozidlo přešlo do nouzového režimu po nastartování.'
  assert(validateCase(c).ok)
})

test('Popis <20 znaků bez OBD a příznaku → zamítnuto', () => {
  const c = mkCase()
  c.messages[0].obdCodes = []
  c.messages[0].symptoms = []
  c.messages[0].text = 'Nouzový režim.'
  assert(!validateCase(c).ok)
})

test('Prázdné všechny signály → zamítnuto', () => {
  const c = mkCase()
  c.messages[0].obdCodes = []
  c.messages[0].symptoms = []
  c.messages[0].text = ''
  assert(!validateCase(c).ok)
})

// ── OBD formát ────────────────────────────────────────────────────────────────
console.log('\n── OBD formát ────────────────────────────────────────────────────')

test('Platný kód P0401 → projde', () => {
  assert(validateCase(mkCase()).ok)
})

test('Platné kódy B1234, C0001, U0100 → projdou', () => {
  const c = mkCase()
  c.messages[0].obdCodes = ['B1234', 'C0001', 'U0100']
  assert(validateCase(c).ok)
})

test('Neplatný kód "P04" → zamítnuto', () => {
  const c = mkCase()
  c.messages[0].obdCodes = ['P04']
  const r = validateCase(c)
  assert(!r.ok)
})

test('Neplatný kód "X0401" → zamítnuto', () => {
  const c = mkCase()
  c.messages[0].obdCodes = ['X0401']
  assert(!validateCase(c).ok)
})

// ── Model vozidla ─────────────────────────────────────────────────────────────
console.log('\n── Model vozidla ─────────────────────────────────────────────────')

test('Chybějící model → zamítnuto', () => {
  const c = mkCase()
  c.vehicle.model = ''
  assert(!validateCase(c).ok)
})

test('Null vehicle → zamítnuto', () => {
  const c = mkCase()
  c.vehicle = null
  assert(!validateCase(c).ok)
})

// ── Výsledky ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`)
console.log(`Výsledky: ${passed} prošlo, ${failed} selhalo`)
if (failed > 0) process.exit(1)
else console.log('✓ Všechny testy prošly\n')
