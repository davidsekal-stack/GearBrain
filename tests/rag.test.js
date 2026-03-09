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

  test('Plná shoda (model+OBD+2 příznaky) = 3+4+3 = 10', () => {
    const c = mkCase('Transit 2.2 TDCi (2006–2014)', ['P0401'], ['Ztráta výkonu', 'Černý kouř'])
    assert.strictEqual(computeSimilarity(c, INPUT), 10)
  })

  test('Jen OBD kód = 4', () => {
    const c = mkCase('', ['P0401'], [])
    assert.strictEqual(computeSimilarity(c, INPUT), 4)
  })

  test('Jen model = 3', () => {
    const c = mkCase('Transit 2.2 TDCi (2006–2014)', [], [])
    assert.strictEqual(computeSimilarity(c, INPUT), 3)
  })

  test('Jen příznak = 1.5', () => {
    const c = mkCase('', [], ['Ztráta výkonu'])
    assert.strictEqual(computeSimilarity(c, INPUT), 1.5)
  })

  test('Žádná shoda (jiný model+OBD+příznaky) = 0', () => {
    const c = mkCase('Sprinter 316 CDI', ['P0087'], ['Přehřívání'])
    assert.strictEqual(computeSimilarity(c, INPUT), 0)
  })

  test('Dva OBD kódy (2×OBD) = 4+4 = 8', () => {
    const input2 = { ...INPUT, obdCodes: ['P0401', 'P0403'] }
    const c = mkCase('', ['P0401', 'P0403'], [])
    assert.strictEqual(computeSimilarity(c, input2), 8)
  })

  test('Shoda výkonu motoru přidává +2 body', () => {
    const c = mkCase('Transit MK7 2.2 TDCi (2006–2011)', [], [])
    c.vehicle.enginePower = '96 kW (130 k)'
    const inputPower = { ...INPUT, vehicle: { brand: 'Ford', model: 'Transit MK7 2.2 TDCi (2006–2011)', enginePower: '96 kW (130 k)' } }
    // model(3) + power(2) = 5
    assert.strictEqual(computeSimilarity(c, inputPower), 5)
  })

  test('Neshoda výkonu nedává bonus', () => {
    const c = mkCase('Transit MK7 2.2 TDCi (2006–2011)', [], [])
    c.vehicle.enginePower = '81 kW (110 k)'
    const inputPower = { ...INPUT, vehicle: { brand: 'Ford', model: 'Transit MK7 2.2 TDCi (2006–2011)', enginePower: '96 kW (130 k)' } }
    // model(3) + power(0) = 3
    assert.strictEqual(computeSimilarity(c, inputPower), 3)
  })

  test('Text skóre je omezeno na max 2 (i při 30+ shodách)', () => {
    const words = Array.from({ length: 30 }, (_, i) => `slovo${i}`)
    const input3 = { ...INPUT, text: words.join(' ') }
    const c = mkCase('', [], [], words.join(' '))
    const score = computeSimilarity(c, input3)
    // textScore(max 2) = 2
    assert(score <= 2, `Skóre ${score} překračuje maximum text(2)=2`)
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
