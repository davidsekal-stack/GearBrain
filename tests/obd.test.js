/**
 * Unit testy pro electron/lib/obd.js
 *
 * Spuštění: node tests/obd.test.js
 * (Nevyžaduje žádný test framework — čistý Node.js assert)
 */

const assert = require('assert');
const {
  parseDtcBytes,
  parseDtcResponse,
  cleanResponse,
  isElm327Response,
} = require('../electron/lib/obd.js');

// ── Pomocné funkce ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert.strictEqual(a, e, msg || `got ${a}, expected ${e}`);
}

// ── parseDtcBytes ─────────────────────────────────────────────────────────────

console.log('\n── parseDtcBytes ────────────────────────────────────────────────');

test('P kód — P0133', () => {
  eq(parseDtcBytes('01', '33'), 'P0133');
});

test('P kód — P0401', () => {
  eq(parseDtcBytes('04', '01'), 'P0401');
});

test('P kód — P2263', () => {
  eq(parseDtcBytes('22', '63'), 'P2263');
});

test('P kód — P0087 (common Ford fuel pressure)', () => {
  eq(parseDtcBytes('00', '87'), 'P0087');
});

test('C kód — C0035', () => {
  // C = systém 01 = bity 7-6 jsou 01 → 0x40
  // C0035: systém C(01), d1=0, d2=0, d3=3, d4=5 → 0x40|0x00=0x40, 0x35
  eq(parseDtcBytes('40', '35'), 'C0035');
});

test('B kód — B0000 (systém B, všechny nuly)', () => {
  // B = systém 10 (bity 7-6) = 0x80, d1=0, d2=0, d3=0, d4=0
  eq(parseDtcBytes('80', '00'), 'B0000');
});

test('B kód — B1000 správný výpočet', () => {
  // B(10) d1=1(01) d2=0(0000) → high = 1001_0000 = 0x90, low = 0x00
  eq(parseDtcBytes('90', '00'), 'B1000');
});

test('U kód — U0001', () => {
  // U = 11 → 0xC0
  // U0001: systém U(11), d1=0, d2=0, d3=0, d4=1 → high = 1100_0000 = 0xC0, low = 0x01
  eq(parseDtcBytes('C0', '01'), 'U0001');
});

test('Prázdný slot 0x0000 → null', () => {
  eq(parseDtcBytes('00', '00'), null);
});

test('Case insensitive hex vstup', () => {
  eq(parseDtcBytes('04', '01'), 'P0401');
  eq(parseDtcBytes('04', '01'), 'P0401');
});

test('P kód s hex číslicemi v kódu — P242F', () => {
  // P242F: systém P(00), d1=2, d2=4, d3=2, d4=F
  // high = 00_10_0100 = 0x24, low = 0x2F
  eq(parseDtcBytes('24', '2F'), 'P242F');
});

test('P kód — P246C', () => {
  // P246C: P(00), d1=2, d2=4, d3=6, d4=C
  // high = 0x24, low = 0x6C
  eq(parseDtcBytes('24', '6C'), 'P246C');
});

// ── cleanResponse ─────────────────────────────────────────────────────────────

console.log('\n── cleanResponse ────────────────────────────────────────────────');

test('Odstraní prompt ">"', () => {
  const result = cleanResponse('43 01 03\r\n>');
  assert(!result.some(l => l.includes('>')), 'prompt nalezen');
});

test('Odstraní mezery', () => {
  const result = cleanResponse('43 01 03 00');
  eq(result, ['430103  00'.replace(/\s/g, '').toUpperCase()]);
});

test('Odstraní prázdné řádky', () => {
  const result = cleanResponse('\r\n\r\n43 01 03\r\n\r\n');
  assert(result.every(l => l.length > 0));
});

test('Odstraní AT echo řádky', () => {
  const result = cleanResponse('ATE0\r\nOK\r\n43 01 03\r\n>');
  assert(!result.some(l => l.startsWith('AT')));
});

test('Převede na velká písmena', () => {
  const result = cleanResponse('43 01 03');
  eq(result, ['430103']);
});

test('Prázdná odpověď → prázdné pole', () => {
  eq(cleanResponse(''), []);
  eq(cleanResponse('\r\n>\r\n'), []);
});

// ── parseDtcResponse ──────────────────────────────────────────────────────────

console.log('\n── parseDtcResponse ─────────────────────────────────────────────');

test('Jeden kód P0401', () => {
  // 43 = prefix, 01 = počet, 04 01 = P0401, 00 00 = prázdné sloty
  const { codes, error } = parseDtcResponse('43 01 04 01 00 00 00 00\r\n>');
  eq(error, null);
  eq(codes, ['P0401']);
});

test('Dva kódy P0401 + P2263', () => {
  // 43 02 04 01 22 63 00 00
  const { codes, error } = parseDtcResponse('43 02 04 01 22 63 00 00\r\n>');
  eq(error, null);
  eq(codes, ['P0401', 'P2263']);
});

test('Žádné kódy — NO DATA', () => {
  const { codes, error } = parseDtcResponse('NO DATA\r\n>');
  eq(codes, []);
  eq(error, null);
});

test('Žádné kódy — prázdná odpověď', () => {
  const { codes, error } = parseDtcResponse('\r\n>');
  eq(codes, []);
  eq(error, null);
});

test('CAN ERROR → chybová hláška', () => {
  const { codes, error } = parseDtcResponse('CAN ERROR\r\n>');
  eq(codes, []);
  assert(error !== null, 'error má být non-null');
  assert(error.includes('zapalování'), 'error má zmínit zapalování');
});

test('BUS BUSY → chybová hláška', () => {
  const { error } = parseDtcResponse('BUS BUSY\r\n>');
  assert(error !== null);
});

test('Tři kódy P0087 + P0191 + U0001', () => {
  // P0087: 00 87, P0191: 01 91, U0001: C0 01
  const { codes } = parseDtcResponse('43 03 00 87 01 91 C0 01\r\n>');
  eq(codes, ['P0087', 'P0191', 'U0001']);
});

test('Deduplikace — stejný kód na více řádcích (multi-frame)', () => {
  // Někdy ELM327 vrátí stejný kód ve více řádcích (CAN multi-frame)
  const { codes } = parseDtcResponse('43 01 04 01 00 00\r\n43 01 04 01 00 00\r\n>');
  eq(codes, ['P0401']); // ne ['P0401', 'P0401']
});

test('Mode 07 — pending kódy (prefix 47)', () => {
  const { codes } = parseDtcResponse('47 01 04 01 00 00\r\n>', '07');
  eq(codes, ['P0401']);
});

test('UNABLE TO CONNECT → žádné kódy bez chyby', () => {
  const { codes, error } = parseDtcResponse('UNABLE TO CONNECT\r\n>');
  eq(codes, []);
  assert(error !== null);
});

// ── isElm327Response ──────────────────────────────────────────────────────────

console.log('\n── isElm327Response ─────────────────────────────────────────────');

test('Rozpozná ELM327 v odpovědi ATZ', () => {
  assert(isElm327Response('ELM327 v2.1\r\n>'));
});

test('Rozpozná ELM 327 s mezerou', () => {
  assert(isElm327Response('ELM 327 v1.5\r\n>'));
});

test('Neidentifikuje náhodný text jako ELM327', () => {
  assert(!isElm327Response('43 01 04 01\r\n>'));
});

// ── Výsledky ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`Výsledky: ${passed} prošlo, ${failed} selhalo`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log('✓ Všechny testy prošly\n');
}
