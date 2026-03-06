# GearBrain — Nasazení Edge Function + zabezpečení databáze

## Co se změní

Přímý SELECT na `gearbrain_cases` bude zakázán pro anon roli.
Veškerý přístup k datům prochází Edge Function `search-cases` která vrátí max 5 výsledků.

---

## Krok 1 — Zakažte přímý SELECT pro anon

V Supabase SQL Editoru:

```sql
DROP POLICY IF EXISTS "anon_select" ON public.gearbrain_cases;
```

---

## Krok 2 — Nasaďte Edge Function

### 2a — Nainstalujte Supabase CLI

```cmd
npm install -g supabase
```

### 2b — Přihlaste se a propojte projekt

```cmd
supabase login
supabase link --project-ref váš-project-ref
```

> `project-ref` najdete v Supabase dashboardu: **Settings → General → Reference ID**

### 2c — Nasaďte funkci

```cmd
cd C:\GearBrain
supabase functions deploy search-cases
```

### 2d — Ověřte nasazení

V Supabase dashboardu: **Edge Functions** → měli byste vidět `search-cases` s statusem Active.

---

## Krok 3 — Ověřte že přímý přístup nefunguje

V SQL Editoru (jako anon) — mělo by vrátit 0 řádků nebo chybu:

```sql
SET ROLE anon;
SELECT COUNT(*) FROM public.gearbrain_cases;
RESET ROLE;
```

---

## Poznámky

- INSERT (push uzavřených případů) zůstává funkční — anon_insert policy je zachována
- Edge Function běží s service_role klíčem který má v Supabase prostředí automaticky
- Při výpadku Edge Function aplikace tiše pokračuje bez RAG (diagnostika funguje dál)

