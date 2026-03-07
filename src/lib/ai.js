import { extractSignals } from "./rag.js";

// ── Limity ────────────────────────────────────────────────────────────────────

export const CASE_TOKEN_LIMIT = 40_000

// ── Off-topic detekce ─────────────────────────────────────────────────────────

// Technické zkratky — jejich přítomnost silně indikuje diagnostický kontext
const TECH_ABBREVIATIONS = /(dpf|egr|adblue|ecu|ecm|tcm|abs|esp|eps|can|lin|obd|dtc|mil|vin|rpm|tdci|ecoblue|ecoboost|scr|nox|def|urea|vgt|egts|maf|map|iac|tps|ckp|cmp|evap|purge|swirl|pid)/i

// OBD kód ve formátu P0401, C1234, B0001, U0100
const OBD_CODE_PATTERN = /[PCBU][0-9A-F]{4}/i

// Čísla s technickým kontextem — nájezd, teplota, tlak, RPM, napětí
const TECHNICAL_NUMBER = /\d+\s*(km|bar|kpa|rpm|psi|mbar|nm|ms|mv|mg)|\d+°[cf]/i

/**
 * Zkontroluje zda text mechanika pravděpodobně patří k diagnostice vozidla.
 *
 * Blokuje pouze dlouhé texty (>80 znaků) bez jakéhokoliv technického signálu.
 * Krátké texty a doplňující odpovědi ("znovu se to stalo") vždy projdou.
 *
 * Signály relevance (stačí jeden):
 *   - OBD kód (P0401, C1234...)
 *   - Technická zkratka (DPF, EGR, ECU, ABS...)
 *   - Číslo s jednotkou (185000 km, 92°C, 2.4 bar...)
 *   - Krátký text ≤80 znaků (doplňující odpověď)
 *
 * @param {string} text
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function checkTopicRelevance(text) {
  const trimmed = (text ?? "").trim()

  // Krátké texty vždy projdou — jsou to doplňující odpovědi v kontextu případu
  if (trimmed.length <= 80) return { ok: true, reason: null }

  // Delší text musí obsahovat alespoň jeden technický signál
  const hasObd        = OBD_CODE_PATTERN.test(trimmed)
  const hasTechAbbr   = TECH_ABBREVIATIONS.test(trimmed)
  const hasTechNumber = TECHNICAL_NUMBER.test(trimmed)

  if (hasObd || hasTechAbbr || hasTechNumber) {
    return { ok: true, reason: null }
  }

  return {
    ok: false,
    reason: "Popis neobsahuje žádný technický údaj (OBD kód, zkratku jako DPF/EGR/ABS, nebo měřenou hodnotu). Popište technický problém nebo příznaky závady.",
  }
}

/**
 * Pokusí se opravit zkrácený nebo mírně poškozený JSON z API odpovědi.
 * 1) Zkusí přímý JSON.parse
 * 2) Heuristická oprava — najde poslední kompletní závadu a doplní zbytek struktury
 * @param {string} raw - surový text z API
 * @returns {Object|null}
 */
export function smartRepair(raw) {
  const start = raw.indexOf("{");
  if (start === -1) return null;

  const str = raw.slice(start);
  try { return JSON.parse(str); } catch (_) {}

  let depth = 0, inStr = false, esc = false, lastFaultEnd = -1;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (esc)               { esc = false; continue; }
    if (c === "\\" && inStr) { esc = true;  continue; }
    if (c === '"')           { inStr = !inStr; continue; }
    if (inStr)               continue;
    if (c === "{" || c === "[")      depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 2 && c === "}") lastFaultEnd = i;
    }
  }

  if (lastFaultEnd > 0) {
    try {
      return JSON.parse(
        str.slice(0, lastFaultEnd + 1) +
        '\n],\n"doporučené_testy":[],\n"varování":null,\n"další_info":null\n}'
      );
    } catch (_) {}
  }

  return null;
}

/**
 * Sestaví system prompt pro Claude.
 * Pokud existují podobné uzavřené případy, jsou vloženy jako RAG blok.
 * @param {Array} similarCases - výsledek searchCases() z Edge Function
 * @returns {string}
 */
export function buildSystemPrompt(similarCases) {
  const ragBlock = similarCases.length > 0 ? buildRagBlock(similarCases) : "";

  return `Jsi expertní AI diagnostika pro mechaniky specializující se na užitková vozidla pro evropský trh (EU spec). Máš hluboké znalosti všech generací Ford Transit a jejich motorových variant (TDCi, EcoBlue, EcoBoost atd.) od roku 2000 do současnosti.${ragBlock}

Když dostaneš příznaky, OBD kódy nebo popis závady, vrať POUZE validní JSON (bez textu před/za JSON):
{"shrnutí":"...","závady":[{"název":"...","pravděpodobnost":85,"popis":"...","příznaky_shoda":[],"obd_kódy":[],"díly":[],"postup":"...","naléhavost":"vysoká","poznámka":"..."}],"doporučené_testy":[],"varování":null,"další_info":null}

Pravidla: Odpovídáš VÝHRADNĚ na otázky týkající se diagnostiky a opravy vozidel. Pokud dostaneš dotaz nesouvisející s diagnostikou vozidla, vrať JSON se závadou název "Nesouvisející dotaz" a pravděpodobností 0 a popisem "Tento systém slouží pouze pro diagnostiku vozidel Ford Transit." Jinak: Když nevíš, přiznej to. 1–4 závady seřazené dle pravděpodobnosti. Naléhavost: nízká/střední/vysoká/kritická. Zohledni EU specifika (AdBlue, DPF Euro6). VRAŤ POUZE JSON.`;
}

function buildRagBlock(cases) {
  const entries = cases.map((c, i) => {
    const { symptoms, obdCodes } = extractSignals(c)
    const vehicle = [c.vehicle?.brand, c.vehicle?.model].filter(Boolean).join(" ") || "?"
    const score   = c.ragScore ?? 0

    // Odstupňování podle skutečného skóre z Edge Function
    // Skóre: brand(2) + model(3) + OBD×4 + příznak×1.5 + text(max 2)
    // Vysoká shoda ≥ 11 = min. model + OBD + příznak
    // Střední shoda ≥ 8  = min. model + OBD nebo OBD + 2 příznaky
    // Částečná shoda < 8 = slabá kombinace signálů
    const strength = score >= 11 ? "🔴 VYSOKÁ SHODA"
                   : score >= 8  ? "🟡 STŘEDNÍ SHODA"
                                 : "🟢 ČÁSTEČNÁ SHODA"

    return (
      `[${i + 1}] ${strength} (skóre: ${score.toFixed(1)}) | ${vehicle}\n` +
      `   Příznaky: ${symptoms.join(", ") || "—"}\n` +
      `   OBD: ${obdCodes.join(", ") || "—"}\n` +
      `   ✅ Ověřené řešení: ${c.resolution}`
    )
  })

  return `

OVĚŘENÉ OPRAVY Z DATABÁZE SERVISU:
${entries.join("\n\n")}

INSTRUKCE K DATABÁZI:
- 🔴 VYSOKÁ SHODA: Toto řešení MUSÍ být na 1. nebo 2. místě — má prokázaný výsledek na velmi podobném vozidle se shodnými OBD kódy i příznaky.
- 🟡 STŘEDNÍ SHODA: Zahrň jako pravděpodobnou variantu, uveď výše než obecné hypotézy.
- 🟢 ČÁSTEČNÁ SHODA: Zmiň jako možnost, hodnoť volně podle ostatních příznaků.
Pokud databázové řešení neodpovídá aktuálním příznakům, vysvětli proč se liší.`
}
