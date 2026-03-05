/**
 * RAG (Retrieval-Augmented Generation) modul
 *
 * Váhy skóre podobnosti:
 *   +2   shoda značky vozidla
 *   +3   shoda modelu vozidla
 *   +4   shoda OBD kódu  (nejsilnější diagnostický signál)
 *   +1.5 shoda příznaku
 *   +0.3 shoda klíčového slova z volného textu (>4 znaky)
 */

/**
 * Vypočítá skóre podobnosti uzavřeného případu vůči aktuálnímu vstupu.
 * @param {Object} closed  - uzavřený případ z databáze
 * @param {Object} input   - { vehicle, symptoms, obdCodes, text }
 * @returns {number}
 */
export function computeSimilarity(closed, input) {
  const allText = closed.messages
    .filter((m) => m.type === "input")
    .flatMap((m) => [...(m.symptoms ?? []), ...(m.obdCodes ?? []), m.text ?? ""])
    .join(" ")
    .toLowerCase();

  let score = 0;

  if (input.vehicle?.brand && closed.vehicle?.brand === input.vehicle.brand) score += 2;
  if (input.vehicle?.model && closed.vehicle?.model === input.vehicle.model) score += 3;

  for (const code of input.obdCodes ?? []) {
    if (allText.includes(code.toLowerCase())) score += 4;
  }
  for (const sym of input.symptoms ?? []) {
    if (allText.includes(sym.toLowerCase())) score += 1.5;
  }
  for (const word of (input.text ?? "").toLowerCase().split(/\s+/).filter((w) => w.length > 4)) {
    if (allText.includes(word)) score += 0.3;
  }

  return score;
}

/**
 * Vrátí až 3 nejpodobnější uzavřené případy (score > 0), seřazené sestupně.
 * @param {Array}  allCases - celý seznam případů
 * @param {Object} input    - { vehicle, symptoms, obdCodes, text }
 * @returns {Array}
 */
export function findSimilar(allCases, input) {
  return allCases
    .filter((c) => c.status === "uzavřený" && c.resolution)
    .map((c) => ({ c, score: computeSimilarity(c, input) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => x.c);
}

/**
 * Extrahuje unikátní příznaky a OBD kódy ze všech vstupních zpráv případu.
 * Používá se při sestavování RAG bloku v system promptu.
 * @param {Object} kase - případ
 * @returns {{ symptoms: string[], obdCodes: string[] }}
 */
export function extractSignals(kase) {
  const inputs = kase.messages.filter((m) => m.type === "input");
  return {
    symptoms: [...new Set(inputs.flatMap((m) => m.symptoms ?? []))],
    obdCodes: [...new Set(inputs.flatMap((m) => m.obdCodes ?? []))],
  };
}
