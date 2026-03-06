# GearBrain — Supabase nastavení

Jednorázový setup. Celé zabere asi 5 minut.

---

## 1. Vytvořte Supabase projekt

1. Jděte na [supabase.com](https://supabase.com) → **New project**
2. Název: `gearbrain`, heslo databáze si uložte
3. Region: `Central EU (Frankfurt)` — nejblíže ČR
4. Počkejte ~2 minuty než se projekt provisionuje

---

## 2. Vytvořte tabulku

V Supabase dashboardu: **SQL Editor** → **New query** → vložte a spusťte:

```sql
-- Hlavní tabulka pro sdílené diagnostické záznamy
CREATE TABLE public.gearbrain_cases (
  id               uuid primary key default gen_random_uuid(),
  local_id         text,
  installation_id  uuid        not null,
  vehicle_brand    text,
  vehicle_model    text,
  mileage          integer,
  symptoms         text[]      not null default '{}',
  obd_codes        text[]      not null default '{}',
  description      text,
  resolution       text        not null,
  closed_at        timestamptz,
  created_at       timestamptz not null default now()
);

-- Index pro rychlé vyhledávání podle OBD kódů (GIN index pro array overlap)
CREATE INDEX idx_gearbrain_obd_codes
  ON public.gearbrain_cases USING GIN (obd_codes);

-- Index pro vyhledávání podle modelu vozidla
CREATE INDEX idx_gearbrain_vehicle_model
  ON public.gearbrain_cases (vehicle_model);

-- Index pro řazení podle data (nejnovější první)
CREATE INDEX idx_gearbrain_created_at
  ON public.gearbrain_cases (created_at DESC);
```

---

## 3. Nastavte Row Level Security (RLS)

Toto je klíčové pro bezpečnost — anon klíč smí pouze číst a zapisovat, ne mazat ani upravovat.

```sql
-- Unique constraint pro idempotentní push (zabraňuje duplicitám při opakovaném odeslání)
CREATE UNIQUE INDEX idx_gearbrain_idempotent
  ON public.gearbrain_cases (installation_id, local_id)
  WHERE local_id IS NOT NULL;

-- Zapněte RLS na tabulce
ALTER TABLE public.gearbrain_cases ENABLE ROW LEVEL SECURITY;

-- Policy: anonymní uživatelé mohou číst všechny záznamy
CREATE POLICY "anon_select"
  ON public.gearbrain_cases
  FOR SELECT
  TO anon
  USING (true);

-- Policy: anonymní uživatelé mohou přidávat nové záznamy
CREATE POLICY "anon_insert"
  ON public.gearbrain_cases
  FOR INSERT
  TO anon
  WITH CHECK (true);

-- UPDATE a DELETE nejsou povoleny pro nikoho (žádná policy = zakázáno)
```

---

## 4. Získejte přihlašovací údaje

V Supabase dashboardu: **Project Settings** → **API**

Potřebujete:
- **Project URL** — např. `https://abcdefghijkl.supabase.co`
- **anon / public key** — dlouhý JWT token začínající `eyJ...`

> ⚠️ **Nepoužívejte `service_role` klíč** — ten má plný přístup k databázi.
> Pouze `anon` klíč je bezpečný pro distribuci zákazníkům.

---

## 5. Zadejte do GearBrain

V aplikaci: **Nastavení** → sekce **CLOUD DATABÁZE**

- **Supabase Project URL**: vložte Project URL
- **Supabase Anon Key**: vložte anon klíč
- Klikněte **✓ Připojit cloud**
- Klikněte **Test** — měli byste vidět `✓ Připojeno · 0 záznamů v databázi`

---

## Jak to funguje

```
Zákazník uzavře případ
        ↓
GearBrain odešle anonymní záznam do Supabase
(installation_id = náhodné UUID, žádná osobní data)
        ↓
Při příští diagnostice jiného zákazníka
GearBrain prohledá Supabase (OBD kódy / model vozidla)
        ↓
Nalezené záznamy se sloučí s lokálními výsledky
a předají AI jako kontext → přesnější diagnostika
```

---

## Monitoring (volitelné)

V Supabase dashboardu → **Table Editor** → `gearbrain_cases`
uvidíte všechny záznamy od zákazníků.

Užitečné SQL dotazy:

```sql
-- Celkový počet záznamů
SELECT COUNT(*) FROM gearbrain_cases;

-- Nejčastější OBD kódy
SELECT unnest(obd_codes) AS code, COUNT(*) AS pocet
FROM gearbrain_cases
GROUP BY code
ORDER BY pocet DESC
LIMIT 20;

-- Nejčastější modely vozidel
SELECT vehicle_model, COUNT(*) AS pocet
FROM gearbrain_cases
WHERE vehicle_model IS NOT NULL
GROUP BY vehicle_model
ORDER BY pocet DESC;

-- Záznamy za posledních 30 dní
SELECT * FROM gearbrain_cases
WHERE created_at > now() - interval '30 days'
ORDER BY created_at DESC;
```

---

## Migrace existující databáze (pokud jste ji vytvořili před touto verzí)

Pokud jste již vytvořili databázi z dřívější verze GearBrain, spusťte v SQL Editoru:

```sql
-- Přidat local_id sloupec
ALTER TABLE public.gearbrain_cases ADD COLUMN IF NOT EXISTS local_id text;

-- Přidat unique index pro idempotentní push
CREATE UNIQUE INDEX IF NOT EXISTS idx_gearbrain_idempotent
  ON public.gearbrain_cases (installation_id, local_id)
  WHERE local_id IS NOT NULL;
```
