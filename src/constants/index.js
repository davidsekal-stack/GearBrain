// ── Katalog vozidel ───────────────────────────────────────────────────────────
//
// Centrální datová struktura pro všechny podporované značky.
//
// active: true  → zobrazuje se v GUI (výběr modelu, system prompt...)
// active: false → data připravena v katalogu, GUI je zatím nezobrazuje
//
// expertise → odborný kontext vložený do AI system promptu pro tuto značku

export const VEHICLE_CATALOG = [
  {
    brand:     "Ford",
    active:    true,
    expertise: "Ford Transit všech generací a variant (TDCi, EcoBlue, EcoBoost) od roku 2000 do současnosti, EU spec (AdBlue, DPF Euro 5/6, SCR systémy)",
    models: [
      { group: "Transit (plná velikost)" },
      { label: "Transit 2.2 TDCi (2006–2014)" },
      { label: "Transit 2.4 TDCi (2006–2014)" },
      { label: "Transit 2.2 TDCi (2014–2019)" },
      { label: "Transit 2.0 TDCi (2016–2019)" },
      { label: "Transit 2.0 EcoBlue (2019–současnost)" },
      { group: "Transit Custom" },
      { label: "Transit Custom 2.2 TDCi (2012–2018)" },
      { label: "Transit Custom 2.0 EcoBlue (2018–2023)" },
      { label: "Transit Custom 1.0 EcoBoost PHEV (2019–2023)" },
      { label: "Transit Custom 2.0 EcoBlue (2023–současnost)" },
      { group: "Transit Connect" },
      { label: "Transit Connect 1.8 TDCi (2006–2013)" },
      { label: "Transit Connect 1.6 TDCi (2013–2018)" },
      { label: "Transit Connect 1.5 EcoBlue (2018–2022)" },
      { label: "Transit Connect 1.5 EcoBlue (2022–současnost)" },
      { group: "Transit Courier" },
      { label: "Transit Courier 1.5 TDCi (2014–2023)" },
      { label: "Transit Courier 1.0 EcoBoost (2014–2023)" },
      { label: "Transit Courier 1.5 EcoBlue (2023–současnost)" },
    ],
  },

  // ── Připraveno, zatím neaktivní ───────────────────────────────────────────
  // Přidat modely a přepnout active: true až budete připraveni rozšířit GUI.

  {
    brand:     "Volkswagen",
    active:    false,
    expertise: "Volkswagen Crafter a Transporter TDI všech generací, EU spec (AdBlue, DPF Euro 6)",
    models: [
      { group: "Crafter (SY/SZ)" },
      { label: "Crafter 2.0 TDI (2017–současnost)" },
      { label: "Crafter 2.0 TDI 4Motion (2017–současnost)" },
      { group: "Transporter T6/T6.1" },
      { label: "Transporter 2.0 TDI (2015–současnost)" },
    ],
  },

  {
    brand:     "Mercedes-Benz",
    active:    false,
    expertise: "Mercedes-Benz Sprinter a Vito CDI/d všech generací, EU spec (BlueTEC, AdBlue, OM651/OM654)",
    models: [
      { group: "Sprinter W906" },
      { label: "Sprinter 314 CDI (2006–2018)" },
      { label: "Sprinter 316 CDI (2006–2018)" },
      { group: "Sprinter W907/W910" },
      { label: "Sprinter 314 CDI (2018–současnost)" },
      { label: "Sprinter 316 CDI (2018–současnost)" },
      { group: "Vito W447" },
      { label: "Vito 114 CDI (2014–současnost)" },
      { label: "Vito 116 CDI (2014–současnost)" },
    ],
  },

  {
    brand:     "Renault",
    active:    false,
    expertise: "Renault Master a Trafic dCi všech generací, EU spec (AdBlue od Euro 6)",
    models: [
      { group: "Master III/IV" },
      { label: "Master 2.3 dCi (2010–současnost)" },
      { group: "Trafic III" },
      { label: "Trafic 2.0 dCi (2014–současnost)" },
      { label: "Trafic 1.6 dCi (2014–2019)" },
    ],
  },
]

// ── Odvozené konstanty ────────────────────────────────────────────────────────

/** Vyhledá záznam katalogu podle značky (case-insensitive) */
export function getBrandEntry(brand) {
  if (!brand) return null
  return VEHICLE_CATALOG.find(b => b.brand.toLowerCase() === brand.toLowerCase()) ?? null
}

/** Pouze aktivní značky — zobrazují se v GUI */
export const ACTIVE_BRANDS = VEHICLE_CATALOG.filter(b => b.active)

/**
 * Flat seznam modelů aktivních značek pro <select> v GUI.
 * Pokud je aktivních značek více, přidá nadpis značky jako group separator.
 */
export const VEHICLE_MODELS = ACTIVE_BRANDS.length === 1
  ? ACTIVE_BRANDS[0].models
  : ACTIVE_BRANDS.flatMap(b => [{ group: b.brand }, ...b.models])

/** Výchozí značka pro nový případ */
export const DEFAULT_BRAND  = ACTIVE_BRANDS[0]?.brand ?? ""

/** Prázdné vozidlo pro nový případ */
export const EMPTY_VEHICLE  = { brand: DEFAULT_BRAND, model: "", mileage: "" }

// ── Příznaky podle kategorie ──────────────────────────────────────────────────
export const SYMPTOM_CATEGORIES = {
  "Motor & Výkon": [
    "Ztráta výkonu", "Černý kouř z výfuku", "Bílý kouř z výfuku",
    "Nadměrná spotřeba paliva", "Hrubý volnoběh", "Motor zhasíná",
    "Obtížné startování", "Motor se nepodaří nastartovat", "Nouzový režim",
    "Přehřívání motoru", "Nadměrná spotřeba oleje",
  ],
  "Převodovka & Spojka": [
    "Vibrace při řazení", "Obtížné řazení", "Spojka klouže",
    "Rázy při řazení", "Hluk z převodovky", "Výpadky při akceleraci",
  ],
  "Brzdy & Podvozek": [
    "ABS kontrolka svítí", "Pulzování brzd", "Táhnutí na stranu při brzdění",
    "Hluk z podvozku", "Vibrace volantu", "Nerovnoměrné opotřebení pneumatik",
  ],
  "Řízení": [
    "Těžké řízení", "Vůle ve volantu", "Klikání při otáčení volantu",
    "Táhnutí na stranu při jízdě", "Kontrolka řízení svítí",
  ],
  "Elektrika & Elektronika": [
    "Kontrolka motoru (MIL) svítí", "Výpadky elektriky", "Problémy s alternátorem",
    "Vybíjení baterie", "Problémy s centrálním zamykáním", "Chyby na palubním počítači",
  ],
  "Výfuk & Emise": [
    "DPF kontrolka svítí", "AdBlue varování", "Zápach z výfuku",
    "Kouř při akceleraci", "Nefunkční regenerace DPF",
  ],
}

// ── Časté OBD kódy ────────────────────────────────────────────────────────────
export const COMMON_OBD_CODES = [
  "P0087", "P0093", "P0191", "P0401", "P0402", "P0403",
  "P0489", "P0490", "P1000", "P2002", "P2003", "P2263",
  "P2599", "P242F", "P246C", "U0001",
]
