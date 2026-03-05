import { extractSignals } from "./rag.js";

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
        '\n],\n"doporučené_testy":[],\n"varování":null,\n"další_info":"Výsledek zkrácen."\n}'
      );
    } catch (_) {}
  }

  return null;
}

/**
 * Sestaví system prompt pro Claude.
 * Pokud existují podobné uzavřené případy, jsou vloženy jako RAG blok
 * s explicitní instrukcí o jejich prioritě nad obecnou diagnostikou.
 * @param {Array} similarCases - výsledek findSimilar()
 * @returns {string}
 */
export function buildSystemPrompt(similarCases) {
  const ragBlock = similarCases.length > 0 ? buildRagBlock(similarCases) : "";

  return `Jsi expertní AI diagnostika pro mechaniky specializující se na užitková vozidla pro evropský trh (EU spec). Máš hluboké znalosti všech generací Ford Transit a jejich motorových variant (TDCi, EcoBlue, EcoBoost atd.) od roku 2000 do současnosti.${ragBlock}

Když dostaneš příznaky, OBD kódy nebo popis závady, vrať POUZE validní JSON (bez textu před/za JSON):
{"shrnutí":"...","závady":[{"název":"...","pravděpodobnost":85,"popis":"...","příznaky_shoda":[],"obd_kódy":[],"díly":[],"postup":"...","naléhavost":"vysoká","poznámka":"..."}],"doporučené_testy":[],"varování":null,"další_info":null}

Pravidla: Když nevíš, přiznej to. 1–4 závady seřazené dle pravděpodobnosti. Naléhavost: nízká/střední/vysoká/kritická. Zohledni EU specifika (AdBlue, DPF Euro6). VRAŤ POUZE JSON.`;
}

function buildRagBlock(cases) {
  const entries = cases.map((c, i) => {
    const { symptoms, obdCodes } = extractSignals(c);
    const vehicle = [c.vehicle?.brand, c.vehicle?.model].filter(Boolean).join(" ") || "?";
    return (
      `[${i + 1}] ${vehicle} | ${c.vehicle?.mileage ?? "?"}km\n` +
      `   Příznaky: ${symptoms.join(", ") || "—"}\n` +
      `   OBD: ${obdCodes.join(", ") || "—"}\n` +
      `   ✅ Ověřené řešení: ${c.resolution}`
    );
  });

  return `

OVĚŘENÉ OPRAVY Z DATABÁZE SERVISU (nejvyšší priorita):
${entries.join("\n\n")}

INSTRUKCE K DATABÁZI: Tyto záznamy jsou reálné opravy provedené na stejném nebo podobném vozidle. Při shodě OBD kódů nebo příznaků MUSÍŠ toto řešení uvést jako první závadu s nejvyšší pravděpodobností. Ověřené řešení z databáze má přednost před obecnou diagnostikou.`;
}
