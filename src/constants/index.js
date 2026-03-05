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
};

// ── Časté OBD kódy ────────────────────────────────────────────────────────────
export const COMMON_OBD_CODES = [
  "P0087", "P0093", "P0191", "P0401", "P0402", "P0403",
  "P0489", "P0490", "P1000", "P2002", "P2003", "P2263",
  "P2599", "P242F", "P246C", "U0001",
];

// ── Modely vozidel ─────────────────────────────────────────────────────────────
// Každá položka buď { label: string } = volitelná, nebo { group: string } = nadpis (disabled)
export const VEHICLE_MODELS = [
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
];

// Výchozí značka — připraveno pro rozšíření na další značky v budoucnu
export const DEFAULT_BRAND = "Ford";
export const EMPTY_VEHICLE = { brand: DEFAULT_BRAND, model: "", mileage: "" };
