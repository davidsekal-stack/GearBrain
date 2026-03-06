/**
 * RAG (Retrieval-Augmented Generation) modul
 *
 * Skórovací váhy:
 *   +2   shoda značky vozidla
 *   +3   shoda modelu vozidla
 *   +4   shoda OBD kódu  (nejsilnější diagnostický signál)
 *   +1.5 shoda příznaku
 *   +0.3 shoda klíčového slova z volného textu (>4 znaky), max +2 celkem z textu
 *
 * Prahy relevance:
 *   OWN_THRESHOLD   = 8  — záznamy z této instalace (naše vlastní případy)
 *   OTHER_THRESHOLD = 10 — záznamy od ostatních servisů
 */

const OWN_THRESHOLD   = 8
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
      textScore += 0.3
      if (textScore >= MAX_TEXT_SCORE) break
    }
  }
  score += textScore

  return score
}

/**
 * Prohledá cloudovou databázi (která obsahuje i naše vlastní záznamy).
 * Vlastní záznamy (podle installationId) mají nižší práh než cizí.
 *
 * @param {Array}  cloudDb        - celá cloudová cache (stažená při startu)
 * @param {Object} input          - { vehicle, symptoms, obdCodes, text }
 * @param {string} installationId - UUID této instalace (pro rozlišení vlastních záznamů)
 * @returns {Array}               - max 5 nejrelevantnějších případů
 */
export function findSimilarInCloud(cloudDb, input, installationId) {
  return cloudDb
    .map((c) => {
      const score     = computeSimilarity(c, input)
      const isOwn     = c.installationId === installationId
      const threshold = isOwn ? OWN_THRESHOLD : OTHER_THRESHOLD
      return { c, score, isOwn, passes: score >= threshold }
    })
    .filter((x) => x.passes)
    .sort((a, b) =>
      b.score - a.score ||
      // Při stejném skóre mají přednost vlastní záznamy
      (a.isOwn && !b.isOwn ? -1 : !a.isOwn && b.isOwn ? 1 : 0)
    )
    .slice(0, 5)
    .map((x) => x.c)
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
