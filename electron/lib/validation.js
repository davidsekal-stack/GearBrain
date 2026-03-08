/**
 * Sdílená validační logika pro resolution text.
 * Používá se v UI (App.jsx přes preload) i v cloud.js před pushem.
 *
 * @param {string} resolutionRaw - text popisující provedenou opravu
 * @returns {{ ok: boolean, reason: string|null }}
 */
function validateResolution(resolutionRaw) {
  const resolution = (resolutionRaw ?? '').trim()

  if (!resolution) {
    return { ok: false, reason: 'Chybí popis provedené opravy.' }
  }
  if (resolution.length < 10) {
    return { ok: false, reason: `Popis opravy je příliš krátký (${resolution.length} znaků, minimum 10).` }
  }
  if (resolution.length > 200) {
    return { ok: false, reason: `Popis opravy je příliš dlouhý (${resolution.length} znaků, maximum 200).` }
  }
  if (/(.)\1{6,}/.test(resolution)) {
    return { ok: false, reason: 'Popis opravy obsahuje opakující se znaky.' }
  }
  const uniqueWords = new Set(
    resolution.toLowerCase().split(/\s+/).filter(w => w.length > 2)
  )
  if (uniqueWords.size < 2) {
    return { ok: false, reason: 'Popis opravy je příliš stručný — přidejte alespoň 2 různá slova.' }
  }

  return { ok: true, reason: null }
}

module.exports = { validateResolution }
