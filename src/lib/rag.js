/**
 * RAG (Retrieval-Augmented Generation) modul
 *
 * computeSimilarity() — skórovací logika, sdílena s Edge Function search-cases
 * extractSignals()    — pomocná funkce pro sestavení RAG bloku v system promptu
 *
 * Scoring algoritmus (shodný s supabase/functions/search-cases/index.ts):
 *   +2   shoda značky vozidla
 *   +3   shoda modelu vozidla
 *   +4   shoda OBD kódu  (nejsilnější diagnostický signál)
 *   +1.5 shoda příznaku
 *   +0.3 shoda klíčového slova z volného textu (>4 znaky), max +2 celkem
 *
 * Prahy relevance:
 *   OWN_THRESHOLD   = 8  — záznamy z této instalace
 *   OTHER_THRESHOLD = 10 — záznamy od ostatních servisů
 */

const OWN_THRESHOLD   = 6
const OTHER_THRESHOLD = 10

// FIX #5: Max příspěvek z klíčových slov volného textu
// Bez tohoto limitu může 30+ slov ve volném textu přidat 9+ bodů
// a propašovat nesouvisející záznam přes práh.
const MAX_TEXT_SCORE = 2

/**
 * Vypočítá skóre podobnosti uzavřeného případu vůči aktuálnímu vstupu.
 * @param {Object} closed  - uzavřený případ (lokální nebo cloudový)
 * @param {Object} input   - { vehicle, symptoms, obdCodes, text }
 * @returns {number}
 */
export function computeSimilarity(closed, input) {
  const allText = closed.messages
    .filter((m) => m.type === 'input')
    .flatMap((m) => [...(m.symptoms ?? []), ...(m.obdCodes ?? []), m.text ?? ''])
    .join(' ')
    .toLowerCase()

  let score = 0

  if (input.vehicle?.brand && closed.vehicle?.brand === input.vehicle.brand) score += 2
  if (input.vehicle?.model && closed.vehicle?.model === input.vehicle.model) score += 3

  for (const code of input.obdCodes ?? []) {
    if (allText.includes(code.toLowerCase())) score += 4
  }
  for (const sym of input.symptoms ?? []) {
    if (allText.includes(sym.toLowerCase())) score += 1.5
  }

  // FIX #5: Skóre z volného textu je omezeno na MAX_TEXT_SCORE
  let textScore = 0
  for (const word of (input.text ?? '').toLowerCase().split(/\s+/).filter((w) => w.length > 4)) {
    if (allText.includes(word)) {
      textScore = Math.min(textScore + 0.3, MAX_TEXT_SCORE)
      if (textScore >= MAX_TEXT_SCORE) break
    }
  }
  score += textScore

  return score
}

/**
 * Extrahuje unikátní příznaky a OBD kódy ze všech vstupních zpráv případu.
 * Používá se při sestavování RAG bloku v system promptu.
 * @param {Object} kase - případ
 * @returns {{ symptoms: string[], obdCodes: string[] }}
 */
export function extractSignals(kase) {
  const inputs = kase.messages.filter((m) => m.type === 'input')
  return {
    symptoms: [...new Set(inputs.flatMap((m) => m.symptoms ?? []))],
    obdCodes: [...new Set(inputs.flatMap((m) => m.obdCodes ?? []))],
  }
}
