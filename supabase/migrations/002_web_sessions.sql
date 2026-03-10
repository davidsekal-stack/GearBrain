-- ═══════════════════════════════════════════════════════════════════════════════
-- GearBrain Web — tabulka pro uživatelské sessions + RLS
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1) Tabulka pro web sessions (JSONB ukládá celý případ)
CREATE TABLE IF NOT EXISTS public.gearbrain_web_sessions (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  data       JSONB NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index pro rychlé dotazy per-user
CREATE INDEX idx_web_sessions_user_id ON public.gearbrain_web_sessions(user_id);
CREATE INDEX idx_web_sessions_status  ON public.gearbrain_web_sessions(user_id, status);

-- 2) RLS politiky — uživatel vidí jen svoje záznamy
ALTER TABLE public.gearbrain_web_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "web_select_own" ON public.gearbrain_web_sessions
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "web_insert_own" ON public.gearbrain_web_sessions
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "web_update_own" ON public.gearbrain_web_sessions
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "web_delete_own" ON public.gearbrain_web_sessions
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- 3) Přidání user_id sloupce do gearbrain_cases (pro RAG — web uživatelé)
ALTER TABLE public.gearbrain_cases ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id);
CREATE INDEX IF NOT EXISTS idx_gearbrain_user_id ON public.gearbrain_cases(user_id);

-- 4) RLS politika pro web uživatele — mohou insertovat svoje případy do RAG DB
CREATE POLICY "web_user_insert_cases" ON public.gearbrain_cases
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- 5) Existující anon politiky zůstávají beze změny (Electron verze)
