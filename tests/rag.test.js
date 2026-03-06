/**
 * Unit testy pro src/lib/rag.js
 * Spuštění: node tests/rag.test.js
 *
 * Pozn.: findSimilarInCloud() byla odstraněna — scoring nyní probíhá
 * na serveru v Edge Function (supabase/functions/search-cases/index.ts).
 * Testy pokrývají computeSimilarity() a extractSignals() které zůstávají.
 */

const assert = require('assert')

async function run() {
  const { computeSimilarity, extractSignals } = await import('../src/lib/rag.js')

  let passed = 0, failed = 0

  function test(name, fn) {
    try { fn(); console.log(`  ✓ ${name}`); passed++ }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++ }
  }

  const OWN_ID = 'install-uuid-own'

  const mkCase = (model, obdCodes, symptoms, text = '') => ({
    id:             Math.random().toString(36).slice(2),
    status:         'uzavřený',
    resolution:     'Opraveno.',
    installationId: OWN_ID,
    vehicle:        { brand: 'Ford', model },
    messages: [{ type: 'input', symptoms, obdCodes, text }],
  })

  const INPUT = {
    vehicle:  { brand: 'Ford', model: 'Transit 2.2 TDCi (2006–2014)' },
    symptoms: ['Ztráta výkonu', 'Černý kouř'],
    obdCodes: ['P0401'],
    text:     '',
  }

  // ── computeSimilarity ──────────────────────────────────────────────────────
  console.log('\n── computeSimilarity ────────────────────────────────────────────')

  test('Plná shoda (brand+model+OBD+2 příznaky) = 2+3+4+3 = 12', () => {
    const c = mkCase('Transit 2.2 TDCi (2006–2014)', ['P0401'], ['Ztráta výkonu', 'Černý kouř'])
    assert.strictEqual(computeSimilarity(c, INPUT), 12)
  })

  test('Jen OBD kód (brand+OBD) = 2+4 = 6', () => {
    const c = mkCase('', ['P0401'], [])
    assert.strictEqual(computeSimilarity(c, INPUT), 6)
  })

  test('Jen model (brand+model) = 2+3 = 5', () => {
    const c = mkCase('Transit 2.2 TDCi (2006–2014)', [], [])
    assert.strictEqual(computeSimilarity(c, INPUT), 5)
  })

  test('Jen příznak (brand+příznak) = 2+1.5 = 3.5', () => {
    const c = mkCase('', [], ['Ztráta výkonu'])
    assert.strictEqual(computeSimilarity(c, INPUT), 3.5)
  })

  test('Žádná shoda (jiný model+OBD+příznaky) = brand = 2', () => {
    const c = mkCase('Sprinter 316 CDI', ['P0087'], ['Přehřívání'])
    assert.strictEqual(computeSimilarity(c, INPUT), 2)
  })

  test('Dva OBD kódy (brand+2×OBD) = 2+4+4 = 10', () => {
    const input2 = { ...INPUT, obdCodes: ['P0401', 'P0403'] }
    const c = mkCase('', ['P0401', 'P0403'], [])
    assert.strictEqual(computeSimilarity(c, input2), 10)
  })

  test('Text skóre je omezeno na max 2 (i při 30+ shodách)', () => {
    const words = Array.from({ length: 30 }, (_, i) => `slovo${i}`)
    const input3 = { ...INPUT, text: words.join(' ') }
    const c = mkCase('', [], [], words.join(' '))
    const score = computeSimilarity(c, input3)
    // brand(2) + textScore(max 2) = 4
    assert(score <= 4, `Skóre ${score} překračuje maximum brand(2)+text(2)=4`)
  })

  // ── extractSignals ─────────────────────────────────────────────────────────
  console.log('\n── extractSignals ───────────────────────────────────────────────')

  test('Extrahuje unikátní příznaky a OBD kódy z více vstupních zpráv', () => {
    const kase = {
      messages: [
        { type: 'input',     symptoms: ['Ztráta výkonu', 'Kouř'], obdCodes: ['P0401'] },
        { type: 'input',     symptoms: ['Ztráta výkonu', 'Hluk'], obdCodes: ['P0401', 'P0403'] },
        { type: 'diagnosis', symptoms: [],                          obdCodes: [] },
      ]
    }
    const { symptoms, obdCodes } = extractSignals(kase)
    assert.strictEqual(symptoms.length, 3, 'Má být 3 unikátní příznaky')
    assert.strictEqual(obdCodes.length, 2, 'Má být 2 unikátní OBD kódy')
    assert(symptoms.includes('Ztráta výkonu'))
    assert(obdCodes.includes('P0401'))
    assert(obdCodes.includes('P0403'))
  })

  test('Diagnosis zprávy jsou ignorovány', () => {
    const kase = {
      messages: [
        { type: 'diagnosis', symptoms: ['Ignoruj mě'], obdCodes: ['P9999'] },
      ]
    }
    const { symptoms, obdCodes } = extractSignals(kase)
    assert.strictEqual(symptoms.length, 0)
    assert.strictEqual(obdCodes.length, 0)
  })

  test('Prázdné zprávy → prázdné pole', () => {
    const { symptoms, obdCodes } = extractSignals({ messages: [] })
    assert.strictEqual(symptoms.length, 0)
    assert.strictEqual(obdCodes.length, 0)
  })

  // ── Výsledky ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`Výsledky: ${passed} prošlo, ${failed} selhalo`)
  if (failed > 0) process.exit(1)
  else console.log('✓ Všechny testy prošly\n')
}

run().catch(e => { console.error(e); process.exit(1) })
