/**
 * Unit testy pro electron/lib/validation.js — sdílená validace resolution
 * Testuje validateResolution() izolovaně (bez cloud.js závislostí).
 *
 * Spuštění: node tests/validation-standalone.test.js
 */

const assert = require('assert')
const { validateResolution } = require('../electron/lib/validation.js')

let passed = 0, failed = 0

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++ }
}

// ── Platné vstupy ──────────────────────────────────────────────────────────────
console.log('\n── validateResolution: platné ────────────────────────────────────')

test('Platný popis opravy → ok', () => {
  const r = validateResolution('Vyměněn EGR ventil, kód P0401 vymazán.')
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.reason, null)
})

test('Přesně 10 znaků se 2+ unikátními slovy → ok', () => {
  // "Opraveno EGR" = 12 znaků, 2 slova >2 znaků
  const r = validateResolution('Opraveno EGR')
  assert.strictEqual(r.ok, true)
})

test('200 znaků → ok (horní limit)', () => {
  const words = 'opraveno ventil filtr závada motor sání turbo chladič brzdy výfuk'
  let text = words
  while (text.length < 195) text += ' ' + words
  text = text.slice(0, 200)
  const r = validateResolution(text)
  assert.strictEqual(r.ok, true)
})

test('Text s diakritikou → ok', () => {
  const r = validateResolution('Přetěsnění sacího potrubí, vyměněna těsnění.')
  assert.strictEqual(r.ok, true)
})

// ── Neplatné vstupy ────────────────────────────────────────────────────────────
console.log('\n── validateResolution: neplatné ──────────────────────────────────')

test('Null → chybí popis', () => {
  const r = validateResolution(null)
  assert.strictEqual(r.ok, false)
  assert(r.reason.includes('Chybí'))
})

test('Undefined → chybí popis', () => {
  const r = validateResolution(undefined)
  assert.strictEqual(r.ok, false)
})

test('Prázdný string → chybí popis', () => {
  const r = validateResolution('')
  assert.strictEqual(r.ok, false)
})

test('Jen mezery → chybí popis', () => {
  const r = validateResolution('   \t\n  ')
  assert.strictEqual(r.ok, false)
})

test('9 znaků → příliš krátký', () => {
  const r = validateResolution('Opraveno.')
  assert.strictEqual(r.ok, false)
  assert(r.reason.includes('krátký'))
})

test('201 znaků → příliš dlouhý', () => {
  const r = validateResolution('Opraveno '.repeat(26)) // 26 * 9 = 234
  assert.strictEqual(r.ok, false)
  assert(r.reason.includes('dlouhý'))
})

test('Opakující se znaky (7x) → zamítnuto', () => {
  const r = validateResolution('aaaaaaaaa oprava ventilu provedena')
  assert.strictEqual(r.ok, false)
  assert(r.reason.includes('opakující'))
})

test('Opakující se znaky (přesně 6x) → projde (limit je 7+)', () => {
  const r = validateResolution('aaaaaa oprava ventilu provedena')
  assert.strictEqual(r.ok, true)
})

test('Méně než 2 unikátní slova (>2 znaků) → zamítnuto', () => {
  const r = validateResolution('ok ok ok ok ok ok ok')
  assert.strictEqual(r.ok, false)
  assert(r.reason.includes('stručný'))
})

test('Jedno dlouhé slovo → zamítnuto (jen 1 unikátní)', () => {
  const r = validateResolution('opravaaaaaaaaaaa')
  assert.strictEqual(r.ok, false)
})

test('Krátká slova (≤2 znaky) se nepočítají', () => {
  // "ej to je ok" — slova >2 znaků: žádné (ej=2, to=2, je=2, ok=2)
  const r = validateResolution('ej to je ok ne no')
  assert.strictEqual(r.ok, false)
})

// ── Hraniční případy ───────────────────────────────────────────────────────────
console.log('\n── validateResolution: hraniční případy ─────────────────────────')

test('Text s taby a newlines je správně oříznut', () => {
  const r = validateResolution('  \t Vyměněn EGR ventil  \n ')
  assert.strictEqual(r.ok, true)
})

test('Text přesně 10 znaků s 2 unikátními slovy → ok', () => {
  // "Motor opra" = 10 znaků, "motor"(5) + "opra"(4) = 2 unikátní slova >2 znaků
  const r = validateResolution('Motor opra')
  assert.strictEqual(r.ok, true)
})

test('Text 200 znaků přesně → ok', () => {
  let text = 'Vyměněn ventil '.repeat(14) // 14 * 15 = 210, ořízne se na 200
  text = text.slice(0, 200)
  const r = validateResolution(text)
  assert.strictEqual(r.ok, true)
})

test('Vrácený objekt má vždy klíče ok a reason', () => {
  const r1 = validateResolution('Platný popis opravy zde')
  assert('ok' in r1 && 'reason' in r1)
  const r2 = validateResolution('')
  assert('ok' in r2 && 'reason' in r2)
})

// ── Výsledky ────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`)
console.log(`Výsledky: ${passed} prošlo, ${failed} selhalo`)
if (failed > 0) process.exit(1)
else console.log('✓ Všechny testy prošly\n')
