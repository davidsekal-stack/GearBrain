/**
 * OBD-II / ELM327 protokol
 *
 * Komunikace probíhá přes sériový port (USB kabel s ELM327 čipem).
 * Tento soubor obsahuje pouze čistou logiku — žádné I/O, plně testovatelné.
 *
 * Dokumentace ELM327:
 *   https://www.elmelectronics.com/wp-content/uploads/2016/07/ELM327DS.pdf
 * OBD-II DTC formát (SAE J2012):
 *   https://en.wikipedia.org/wiki/OBD-II_PIDs#Mode_03
 */

// ── Konfigurace ───────────────────────────────────────────────────────────────

/** Inicializační sekvence ELM327 — posílaná při každém připojení */
const INIT_COMMANDS = [
  { cmd: 'ATZ',   delay: 1000, desc: 'Reset adaptéru'          },
  { cmd: 'ATE0',  delay: 200,  desc: 'Echo OFF'                 },
  { cmd: 'ATL0',  delay: 200,  desc: 'Linefeed OFF'             },
  { cmd: 'ATS0',  delay: 200,  desc: 'Spaces OFF'               },
  { cmd: 'ATH0',  delay: 200,  desc: 'Headers OFF'              },
  { cmd: 'ATSP0', delay: 500,  desc: 'Auto výběr protokolu'     },
];

/** Příkaz pro čtení uložených DTC (Mode 03) */
const CMD_READ_STORED  = '03';
/** Příkaz pro čtení pending DTC (Mode 07) — závady detekované ale ještě nepotvrzené */
const CMD_READ_PENDING = '07';
/** Příkaz pro smazání DTC (Mode 04) */
const CMD_CLEAR_CODES  = '04';

/** Timeout pro odpověď ELM327 (ms) */
const READ_TIMEOUT_MS = 10_000;

// ── DTC parsování ─────────────────────────────────────────────────────────────

/**
 * Mapování prvních 2 bitů prvního bajtu DTC na písmeno systému.
 *   00 → P (Powertrain)
 *   01 → C (Chassis)
 *   10 → B (Body)
 *   11 → U (Network)
 */
const SYSTEM_LETTERS = ['P', 'C', 'B', 'U'];

/**
 * Převede dva hex bajty DTC na standardní kód (např. "P0401").
 *
 * Formát dle SAE J2012:
 *   Bajt 1:  [7:6] systém  [5:4] 1. číslice  [3:0] 2. číslice
 *   Bajt 2:  [7:4] 3. číslice  [3:0] 4. číslice
 *
 * @param {string} highHex  - první bajt jako 2-znakový hex string (např. "01")
 * @param {string} lowHex   - druhý bajt jako 2-znakový hex string (např. "33")
 * @returns {string|null}   - kód (např. "P0133") nebo null pro prázdný slot (0000)
 */
function parseDtcBytes(highHex, lowHex) {
  const high = parseInt(highHex, 16);
  const low  = parseInt(lowHex,  16);

  // 0x0000 = prázdný slot, ne skutečný kód
  if (high === 0 && low === 0) return null;

  const system = SYSTEM_LETTERS[(high & 0xC0) >> 6];          // bity 7–6
  const d1     = (high & 0x30) >> 4;                           // bity 5–4
  const d2     = high & 0x0F;                                  // bity 3–0
  const d3     = (low  & 0xF0) >> 4;                           // bity 7–4
  const d4     = low  & 0x0F;                                  // bity 3–0

  return `${system}${d1}${d2}${d3.toString(16).toUpperCase()}${d4.toString(16).toUpperCase()}`;
}

/**
 * Vyčistí surovou odpověď ELM327 — odstraní echo, prompt znak ('>'),
 * mezery, CR/LF a převede na velká písmena.
 *
 * @param {string} raw  - surová odpověď ze sériového portu
 * @returns {string[]}  - pole neprázdných řádků
 */
function cleanResponse(raw) {
  return raw
    .replace(/\r/g, '\n')
    .split('\n')
    .map(l => l.replace(/>/g, '').replace(/\s/g, '').toUpperCase())
    .filter(l => l.length > 0 && l !== 'OK' && !l.startsWith('AT'));
}

/**
 * Parsuje odpověď na příkaz Mode 03 nebo 07.
 *
 * Odpověď má formát: "43 01 03 00 00 00 00" (Mode 03 → 43, Mode 07 → 47)
 * - Byte 0: 0x43 nebo 0x47 (potvrzení)
 * - Byte 1: počet DTC (nepoužíváme — někdy nesprávné)
 * - Zbývající páry bajtů: DTC kódy
 *
 * @param {string} raw       - surová odpověď ze sériového portu
 * @param {string} [mode]    - "03" nebo "07"
 * @returns {{ codes: string[], error: string|null }}
 */
function parseDtcResponse(raw, mode = '03') {
  const lines = cleanResponse(raw);

  // Prázdná nebo žádná odpověď
  if (lines.length === 0) return { codes: [], error: null };

  // Chybové odpovědi ELM327
  const joined = lines.join('');
  if (joined.includes('NODATA'))                               return { codes: [], error: null };
  if (joined.includes('UNABLE') || joined.includes('NOCONN'))  return { codes: [], error: 'Není spojení s vozidlem — zapněte zapalování (klíč do polohy ON)' };
  if (joined.includes('CANERROR') || joined.includes('ERROR')) return { codes: [], error: 'CAN chyba — zkontrolujte zapnutí zapalování' };
  if (joined.includes('BUSBUSY'))                              return { codes: [], error: 'Sběrnice obsazena — zkuste znovu za chvíli' };
  if (joined.includes('STOPPED'))                              return { codes: [], error: 'Komunikace přerušena — odpojte a znovu připojte adaptér' };

  // Očekávaný prefix odpovědi: 43 pro mode 03, 47 pro mode 07
  const expectedPrefix = mode === '07' ? '47' : '43';

  const codes = [];

  for (const line of lines) {
    // Přeskočit řádky které nezačínají správným prefixem
    if (!line.startsWith(expectedPrefix)) continue;

    // Odstranit prefix (2 znaky) + počet kódů (2 znaky) → zbývají páry DTC
    const data = line.slice(4); // přeskočit "43" + byte s počtem

    // Procházet páry bajtů (každý DTC = 4 hex znaky)
    for (let i = 0; i + 3 < data.length; i += 4) {
      const highHex = data.slice(i, i + 2);
      const lowHex  = data.slice(i + 2, i + 4);
      const code    = parseDtcBytes(highHex, lowHex);
      if (code) codes.push(code);
    }
  }

  // Deduplikace (někteří adaptéři vrátí kód vícekrát přes více řádků)
  return { codes: [...new Set(codes)], error: null };
}

/**
 * Zkontroluje zda odpověď pochází z ELM327 (nikoliv jiný sériový port).
 * @param {string} raw
 * @returns {boolean}
 */
function isElm327Response(raw) {
  const upper = raw.toUpperCase();
  return upper.includes('ELM327') || upper.includes('ELM 327') || upper.includes('OBDII');
}

// ── Export ────────────────────────────────────────────────────────────────────

module.exports = {
  INIT_COMMANDS,
  CMD_READ_STORED,
  CMD_READ_PENDING,
  CMD_CLEAR_CODES,
  READ_TIMEOUT_MS,
  parseDtcBytes,
  parseDtcResponse,
  cleanResponse,
  isElm327Response,
};
