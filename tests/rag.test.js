/**
 * Unit testy pro src/lib/rag.js
 * Spuštění: node tests/rag.test.js
 */

const assert = require('assert')

// ESM modul načteme přes dynamic import
async function run() {
  const { computeSimilarity, findSimilarInCloud } = await import('../src/lib/rag.js')

  let passed = 0, failed = 0

  function test(name, fn) {
    try { fn(); console.log(`  ✓ ${name}`); passed++ }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++ }
  }

  function eq(a, b, msg) {
    assert.strictEqual(JSON.stringify(a), JSON.stringify(b), msg || `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`)
  }

  const OWN_ID   = 'install-uuid-own'
  const OTHER_ID = 'install-uuid-other'

  const mkCase = (installationId, model, obdCodes, symptoms, text = '') => ({
    id:             Math.random().toString(36).slice(2),
    status:         'uzavřený',
    resolution:     'Opraveno.',
    fromCloud:      true,
    installationId,
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

  test('Plná shoda (model+OBD+2 příznaky) = brand+model+OBD+2 příznaky = 2+3+4+3 = 12', () => {
    const c = mkCase(OWN_ID, 'Transit 2.2 TDCi (2006–2014)', ['P0401'], ['Ztráta výkonu', 'Černý kouř'])
    assert.strictEqual(computeSimilarity(c, INPUT), 12)
  })

  test('Jen OBD kód = brand+OBD = 2+4 = 6', () => {
    const c = mkCase(OWN_ID, '', ['P0401'], [])
    assert.strictEqual(computeSimilarity(c, INPUT), 6)
  })

  test('Jen model = 5 (brand+model)', () => {
    const c = mkCase(OWN_ID, 'Transit 2.2 TDCi (2006–2014)', [], [])
    assert.strictEqual(computeSimilarity(c, INPUT), 5) // brand(2) + model(3)
  })

  test('Jen příznak = brand+příznak = 2+1.5 = 3.5', () => {
    const c = mkCase(OWN_ID, '', [], ['Ztráta výkonu'])
    assert.strictEqual(computeSimilarity(c, INPUT), 3.5)
  })

  test('Žádná shoda = brand match = 2 (jiný model, OBD, příznaky)', () => {
    const c = mkCase(OWN_ID, 'Sprinter 316 CDI', ['P0087'], ['Přehřívání'])
    assert.strictEqual(computeSimilarity(c, INPUT), 2)
  })

  test('Dva OBD kódy = brand+2×OBD = 2+4+4 = 10', () => {
    const input2 = { ...INPUT, obdCodes: ['P0401', 'P0403'] }
    const c = mkCase(OWN_ID, '', ['P0401', 'P0403'], [])
    assert.strictEqual(computeSimilarity(c, input2), 10)
  })

  // ── findSimilarInCloud — vlastní záznamy (práh 8) ─────────────────────────
  console.log('\n── findSimilarInCloud — vlastní záznamy (práh OWN=8) ────────────')

  test('Vlastní: OBD+model+příznak (10) projde', () => {
    const c = mkCase(OWN_ID, 'Transit 2.2 TDCi (2006–2014)', ['P0401'], ['Ztráta výkonu'])
    const result = findSimilarInCloud([c], INPUT, OWN_ID)
    eq(result.length, 1)
  })

  test('Vlastní: jen OBD kód (4) neprojde prahem 8', () => {
    const c = mkCase(OWN_ID, '', ['P0401'], [])
    const result = findSimilarInCloud([c], INPUT, OWN_ID)
    eq(result.length, 0)
  })

  test('Vlastní: dva OBD kódy (8) projde přesně na prahu', () => {
    const input2 = { ...INPUT, obdCodes: ['P0401', 'P0403'] }
    const c = mkCase(OWN_ID, '', ['P0401', 'P0403'], [])
    const result = findSimilarInCloud([c], input2, OWN_ID)
    eq(result.length, 1)
  })

  test('Vlastní: model+příznak (3+1.5=4.5) neprojde prahem 8', () => {
    const c = mkCase(OWN_ID, 'Transit 2.2 TDCi (2006–2014)', [], ['Ztráta výkonu'])
    const result = findSimilarInCloud([c], INPUT, OWN_ID)
    eq(result.length, 0)
  })

  // ── findSimilarInCloud — cizí záznamy (práh 10) ───────────────────────────
  console.log('\n── findSimilarInCloud — cizí záznamy (práh OTHER=10) ────────────')

  test('Cizí: OBD+model+příznak (10) projde přesně na prahu', () => {
    const c = mkCase(OTHER_ID, 'Transit 2.2 TDCi (2006–2014)', ['P0401'], ['Ztráta výkonu'])
    const result = findSimilarInCloud([c], INPUT, OWN_ID)
    eq(result.length, 1)
  })

  test('Cizí: OBD+model (7) neprojde prahem 10', () => {
    const c = mkCase(OTHER_ID, 'Transit 2.2 TDCi (2006–2014)', ['P0401'], [])
    const result = findSimilarInCloud([c], INPUT, OWN_ID)
    eq(result.length, 0)
  })

  test('Cizí: jen OBD kód (4) neprojde prahem 10', () => {
    const c = mkCase(OTHER_ID, '', ['P0401'], [])
    const result = findSimilarInCloud([c], INPUT, OWN_ID)
    eq(result.length, 0)
  })

  test('Cizí: OBD+model+2 příznaky (11.5) projde', () => {
    const c = mkCase(OTHER_ID, 'Transit 2.2 TDCi (2006–2014)', ['P0401'], ['Ztráta výkonu', 'Černý kouř'])
    const result = findSimilarInCloud([c], INPUT, OWN_ID)
    eq(result.length, 1)
  })

  // ── Řazení — vlastní mají přednost při stejném skóre ─────────────────────
  console.log('\n── Řazení ───────────────────────────────────────────────────────')

  test('Vlastní případ (10) předchází cizímu (10) při stejném skóre', () => {
    const own   = mkCase(OWN_ID,   'Transit 2.2 TDCi (2006–2014)', ['P0401'], ['Ztráta výkonu', 'Černý kouř'])
    const other = mkCase(OTHER_ID, 'Transit 2.2 TDCi (2006–2014)', ['P0401'], ['Ztráta výkonu', 'Černý kouř'])
    const result = findSimilarInCloud([other, own], INPUT, OWN_ID)
    eq(result[0].installationId, OWN_ID)
  })

  test('Cizí případ s vyšším skóre (11.5) je před vlastním (10)', () => {
    const own   = mkCase(OWN_ID,   'Transit 2.2 TDCi (2006–2014)', ['P0401'], ['Ztráta výkonu'])   // 10
    const other = mkCase(OTHER_ID, 'Transit 2.2 TDCi (2006–2014)', ['P0401'], ['Ztráta výkonu', 'Černý kouř']) // 11.5
    const result = findSimilarInCloud([own, other], INPUT, OWN_ID)
    eq(result[0].installationId, OTHER_ID)
  })

  test('Max 5 výsledků', () => {
    const cases = Array.from({ length: 10 }, () =>
      mkCase(OWN_ID, 'Transit 2.2 TDCi (2006–2014)', ['P0401'], ['Ztráta výkonu', 'Černý kouř'])
    )
    const result = findSimilarInCloud(cases, INPUT, OWN_ID)
    assert(result.length <= 5, `Vráceno ${result.length}, max je 5`)
  })

  test('Prázdná databáze → prázdný výsledek', () => {
    eq(findSimilarInCloud([], INPUT, OWN_ID), [])
  })

  // ── Výsledky ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`Výsledky: ${passed} prošlo, ${failed} selhalo`)
  if (failed > 0) process.exit(1)
  else console.log('✓ Všechny testy prošly\n')
}

run().catch(e => { console.error(e); process.exit(1) })
