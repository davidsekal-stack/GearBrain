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
    expertise: "Ford Transit všech generací a variant (TDCi, EcoBlue, EcoBoost, Elektro) od roku 2006 do současnosti, EU spec (AdBlue, DPF Euro 5/6, SCR systémy)",
    models: [
      // ── 1. Transit (velká dodávka) ──────────────────────────────────────────
      { group: "Transit (velká dodávka)" },
      { label: "Transit MK7 2.2 TDCi (2006–2011)",        powers: ["63 kW (85 k)", "81 kW (110 k)", "85 kW (115 k)", "96 kW (130 k)", "103 kW (140 k)"] },
      { label: "Transit MK7 2.4 TDCi (2006–2011)",        powers: ["74 kW (100 k)", "85 kW (115 k)", "103 kW (140 k)"] },
      { label: "Transit MK7 3.2 TDCi (2006–2011)",        powers: ["147 kW (200 k)"] },
      { label: "Transit MK7 2.3 Duratec (2006–2011)",     powers: ["107 kW (145 k)"] },
      { label: "Transit MK7 FL 2.2 TDCi (2011–2014)",     powers: ["74 kW (100 k)", "92 kW (125 k)", "114 kW (155 k)"] },
      { label: "Transit MK8 2.2 TDCi (2014–2016)",        powers: ["74 kW (100 k)", "92 kW (125 k)", "114 kW (155 k)"] },
      { label: "Transit MK8 2.0 EcoBlue (2016–současnost)", powers: ["77 kW (105 k)", "96 kW (130 k)", "125 kW (170 k)", "136 kW (185 k)"] },
      { label: "E-Transit Elektro (2022–současnost)",      powers: ["135 kW (184 k)", "198 kW (269 k)"] },

      // ── 2. Transit Custom (střední dodávka) ────────────────────────────────
      { group: "Transit Custom" },
      { label: "Transit Custom I 2.2 TDCi (2012–2016)",          powers: ["74 kW (100 k)", "92 kW (125 k)", "113 kW (154 k)"] },
      { label: "Transit Custom I FL 2.0 EcoBlue (2016–2023)",    powers: ["77 kW (105 k)", "96 kW (130 k)", "125 kW (170 k)", "136 kW (185 k)"] },
      { label: "Transit Custom I 1.0 EcoBoost PHEV (2019–2023)", powers: ["93 kW (126 k)"] },
      { label: "Transit Custom II 2.0 EcoBlue (2023–současnost)", powers: ["81 kW (110 k)", "100 kW (136 k)", "110 kW (150 k)", "125 kW (170 k)"] },
      { label: "Transit Custom II 2.5 Duratec PHEV (2023–současnost)", powers: ["171 kW (232 k)"] },
      { label: "E-Transit Custom Elektro (2024–současnost)",     powers: ["100 kW (136 k)", "160 kW (218 k)", "210 kW (285 k)"] },

      // ── 3. Transit Connect (kompaktní dodávka) ─────────────────────────────
      { group: "Transit Connect" },
      { label: "Transit Connect I 1.8 TDCi (2006–2013)",         powers: ["55 kW (75 k)", "66 kW (90 k)", "81 kW (110 k)"] },
      { label: "Transit Connect II 1.6 TDCi (2013–2015)",        powers: ["55 kW (75 k)", "70 kW (95 k)", "85 kW (115 k)"] },
      { label: "Transit Connect II 1.0 EcoBoost (2013–2018)",    powers: ["74 kW (100 k)"] },
      { label: "Transit Connect II 1.5 TDCi (2015–2018)",        powers: ["55 kW (75 k)", "74 kW (100 k)", "88 kW (120 k)"] },
      { label: "Transit Connect II FL 1.5 EcoBlue (2018–2024)",  powers: ["55 kW (75 k)", "74 kW (100 k)", "88 kW (120 k)"] },
      { label: "Transit Connect III 2.0 EcoBlue (2024–současnost)", powers: ["75 kW (102 k)", "90 kW (122 k)"] },
      { label: "Transit Connect III 1.5 EcoBoost PHEV (2024–současnost)", powers: ["110 kW (150 k)"] },

      // ── 4. Transit Courier (nejmenší dodávka) ──────────────────────────────
      { group: "Transit Courier" },
      { label: "Transit Courier I 1.5/1.6 TDCi (2014–2023)",    powers: ["55 kW (75 k)", "70 kW (95 k)", "74 kW (100 k)"] },
      { label: "Transit Courier I 1.0 EcoBoost (2014–2023)",    powers: ["74 kW (100 k)"] },
      { label: "Transit Courier II 1.0 EcoBoost (2023–současnost)", powers: ["74 kW (100 k)", "92 kW (125 k)"] },
      { label: "Transit Courier II 1.5 EcoBlue (2023–současnost)", powers: ["74 kW (100 k)"] },
      { label: "E-Transit Courier Elektro (2025–současnost)",    powers: ["100 kW (136 k)"] },
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
export const EMPTY_VEHICLE  = { brand: DEFAULT_BRAND, model: "", mileage: "", enginePower: "" }

/** Vrátí pole dostupných výkonů pro daný model (label) */
export function getModelPowers(modelLabel) {
  if (!modelLabel) return []
  for (const brand of VEHICLE_CATALOG) {
    const entry = brand.models.find(m => m.label === modelLabel)
    if (entry?.powers) return entry.powers
  }
  return []
}

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
