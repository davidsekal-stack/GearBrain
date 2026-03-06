# GearBrain — Databázový gatekeeper

Spusťte níže uvedené SQL příkazy v Supabase SQL Editoru.
**Pokud jste databázi vytvořili dříve, použijte sekci Migrace na konci.**

---

## Krok 1 — CHECK constraints na gearbrain_cases

```sql
-- Resolution: 10–200 znaků
ALTER TABLE public.gearbrain_cases
  ADD CONSTRAINT chk_resolution_length
  CHECK (LENGTH(resolution) >= 10 AND LENGTH(resolution) <= 200);

-- Alespoň jeden diagnostický signál (OBD kód, příznak, nebo popis)
ALTER TABLE public.gearbrain_cases
  ADD CONSTRAINT chk_has_diagnostic_signal
  CHECK (
    array_length(obd_codes, 1) > 0
    OR array_length(symptoms, 1) > 0
    OR (description IS NOT NULL AND LENGTH(description) >= 20)
  );

-- Model vozidla nesmí být prázdný
ALTER TABLE public.gearbrain_cases
  ADD CONSTRAINT chk_vehicle_model
  CHECK (vehicle_model IS NOT NULL AND LENGTH(TRIM(vehicle_model)) > 0);
```

---

## Krok 2 — Rate limit: max 20 záznamů za den na instalaci

```sql
-- Pomocná funkce pro počítání dnešních záznamů z dané instalace
CREATE OR REPLACE FUNCTION gearbrain_daily_count(inst_id uuid)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT COUNT(*)::integer
  FROM public.gearbrain_cases
  WHERE installation_id = inst_id
    AND created_at > now() - interval '24 hours';
$$;

-- RLS policy: zamítne insert pokud instalace překročila 20 záznamů/den
DROP POLICY IF EXISTS "anon_insert" ON public.gearbrain_cases;

CREATE POLICY "anon_insert" ON public.gearbrain_cases
  FOR INSERT TO anon
  WITH CHECK (
    gearbrain_daily_count(installation_id) < 20
  );
```

---

## Krok 3 — Tabulka violations + email notifikace

```sql
-- Tabulka pro záznamy o porušeních pravidel
CREATE TABLE IF NOT EXISTS public.gearbrain_violations (
  id               uuid primary key default gen_random_uuid(),
  installation_id  uuid        not null,
  reason           text        not null,
  violation_count  integer     not null,
  blocked          boolean     not null default false,
  created_at       timestamptz not null default now()
);

ALTER TABLE public.gearbrain_violations ENABLE ROW LEVEL SECURITY;

-- Kdokoliv může vložit violation report (anon klient to potřebuje)
CREATE POLICY "anon_insert_violations" ON public.gearbrain_violations
  FOR INSERT TO anon WITH CHECK (true);

-- Číst violations může jen service role (ne anon klient)
CREATE POLICY "service_select_violations" ON public.gearbrain_violations
  FOR SELECT TO service_role USING (true);
```

---

## Krok 4 — Email notifikace přes pg_net + Resend

### 4a — Povolte pg_net rozšíření

V Supabase dashboardu: **Database → Extensions** → vyhledejte `pg_net` → zapněte.

### 4b — Uložte svůj Resend API klíč jako Supabase secret

V Supabase SQL Editoru spusťte (nahraďte hodnoty):

```sql
-- Uložení citlivých hodnot do vault (bezpečné úložiště Supabase)
INSERT INTO vault.secrets (name, secret)
VALUES
  ('resend_api_key', 'váš-resend-api-klíč'),
  ('admin_email',    'váš@email.cz')
ON CONFLICT (name) DO UPDATE SET secret = EXCLUDED.secret;
```

> Resend API klíč získáte zdarma na resend.com → API Keys → Create API Key

### 4c — Trigger funkce pro odeslání emailu

```sql
CREATE OR REPLACE FUNCTION notify_violation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_resend_key text;
  v_admin_email text;
  v_subject text;
  v_body text;
BEGIN
  -- Načtení secrets
  SELECT secret INTO v_resend_key  FROM vault.secrets WHERE name = 'resend_api_key';
  SELECT secret INTO v_admin_email FROM vault.secrets WHERE name = 'admin_email';

  -- Předmět podle závažnosti
  v_subject := CASE
    WHEN NEW.blocked THEN '[GearBrain] ⛔ Instalace ZABLOKOVÁNA — ' || NEW.violation_count || '. porušení'
    ELSE '[GearBrain] ⚠ Porušení pravidel č. ' || NEW.violation_count
  END;

  -- Tělo emailu
  v_body := format(
    '<h2>GearBrain — Porušení pravidel databáze</h2>'
    '<table style="border-collapse:collapse;font-family:monospace">'
    '<tr><td style="padding:4px 12px 4px 0"><b>Instalace:</b></td><td>%s</td></tr>'
    '<tr><td style="padding:4px 12px 4px 0"><b>Důvod:</b></td><td>%s</td></tr>'
    '<tr><td style="padding:4px 12px 4px 0"><b>Počet porušení:</b></td><td>%s</td></tr>'
    '<tr><td style="padding:4px 12px 4px 0"><b>Zablokována:</b></td><td>%s</td></tr>'
    '<tr><td style="padding:4px 12px 4px 0"><b>Čas:</b></td><td>%s</td></tr>'
    '</table>',
    NEW.installation_id,
    NEW.reason,
    NEW.violation_count,
    CASE WHEN NEW.blocked THEN '⛔ ANO' ELSE 'Ne' END,
    NEW.created_at
  );

  -- Odeslání přes Resend API
  PERFORM net.http_post(
    url     := 'https://api.resend.com/emails',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_resend_key,
      'Content-Type',  'application/json'
    ),
    body    := jsonb_build_object(
      'from',    'GearBrain <onboarding@resend.dev>',
      'to',      ARRAY[v_admin_email],
      'subject', v_subject,
      'html',    v_body
    )
  );

  RETURN NEW;
END;
$$;

-- Trigger: spustí se při každém vložení do violations
CREATE TRIGGER trg_notify_violation
  AFTER INSERT ON public.gearbrain_violations
  FOR EACH ROW EXECUTE FUNCTION notify_violation();
```

---

## Migrace (pokud jste databázi vytvořili dříve)

Pokud tabulka `gearbrain_cases` již existuje, spusťte pouze:

```sql
-- 1. local_id (pokud chybí)
ALTER TABLE public.gearbrain_cases ADD COLUMN IF NOT EXISTS local_id text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_gearbrain_idempotent
  ON public.gearbrain_cases (installation_id, local_id)
  WHERE local_id IS NOT NULL;

-- 2. CHECK constraints
ALTER TABLE public.gearbrain_cases
  ADD CONSTRAINT IF NOT EXISTS chk_resolution_length
  CHECK (LENGTH(resolution) >= 10 AND LENGTH(resolution) <= 200);

ALTER TABLE public.gearbrain_cases
  ADD CONSTRAINT IF NOT EXISTS chk_has_diagnostic_signal
  CHECK (
    array_length(obd_codes, 1) > 0
    OR array_length(symptoms, 1) > 0
    OR (description IS NOT NULL AND LENGTH(description) >= 20)
  );

ALTER TABLE public.gearbrain_cases
  ADD CONSTRAINT IF NOT EXISTS chk_vehicle_model
  CHECK (vehicle_model IS NOT NULL AND LENGTH(TRIM(vehicle_model)) > 0);

-- 3. Rate limit policy (nahradí stávající anon_insert)
CREATE OR REPLACE FUNCTION gearbrain_daily_count(inst_id uuid)
RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$
  SELECT COUNT(*)::integer FROM public.gearbrain_cases
  WHERE installation_id = inst_id AND created_at > now() - interval '24 hours';
$$;

DROP POLICY IF EXISTS "anon_insert" ON public.gearbrain_cases;
CREATE POLICY "anon_insert" ON public.gearbrain_cases
  FOR INSERT TO anon
  WITH CHECK (gearbrain_daily_count(installation_id) < 20);
```

Poté pokračujte Kroky 3 a 4 výše (violations tabulka + email trigger).

