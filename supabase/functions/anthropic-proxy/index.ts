/**
 * GearBrain — Edge Function: anthropic-proxy
 *
 * Proxy pro Anthropic API. Klient posílá diagnostický request,
 * Edge Function přidá API klíč a přepošle na Anthropic.
 *
 * Rate limiting: max 50 AI volání / den / installation_id.
 *
 * POST /functions/v1/anthropic-proxy
 * Body: { model, system, messages, max_tokens, installation_id }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ALLOWED_MODELS = [
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-haiku-4-5-20251001',
]

const DAILY_LIMIT     = 50
const MAX_TOKENS_CAP  = 8000

Deno.serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { model, system, messages, max_tokens, installation_id } = await req.json()

    // ── Validace ───────────────────────────────────────────────────────────
    if (!installation_id || typeof installation_id !== 'string') {
      return json({ error: { message: 'Chybí installation_id.' } }, 400, corsHeaders)
    }
    if (!ALLOWED_MODELS.includes(model)) {
      return json({ error: { message: `Nepovolený model: ${model}` } }, 400, corsHeaders)
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      return json({ error: { message: 'Chybí messages.' } }, 400, corsHeaders)
    }

    const safeMaxTokens = Math.min(max_tokens ?? 4000, MAX_TOKENS_CAP)

    // ── Rate limiting ──────────────────────────────────────────────────────
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } },
    )

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { count, error: countErr } = await supabase
      .from('gearbrain_ai_usage')
      .select('*', { count: 'exact', head: true })
      .eq('installation_id', installation_id)
      .gte('created_at', since)

    if (!countErr && (count ?? 0) >= DAILY_LIMIT) {
      return json(
        { error: { message: `Denní limit ${DAILY_LIMIT} AI dotazů překročen. Zkuste to zítra.` } },
        429, corsHeaders,
      )
    }

    // ── Forward to Anthropic ───────────────────────────────────────────────
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')
    if (!anthropicKey) {
      return json({ error: { message: 'Server: chybí konfigurace AI služby.' } }, 500, corsHeaders)
    }

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: safeMaxTokens,
        system: system ?? undefined,
        messages,
      }),
    })

    const anthropicData = await anthropicRes.json()

    // ── Log usage (fire-and-forget) ────────────────────────────────────────
    if (!anthropicData.error) {
      supabase
        .from('gearbrain_ai_usage')
        .insert({
          installation_id,
          model,
          input_tokens:  anthropicData.usage?.input_tokens  ?? 0,
          output_tokens: anthropicData.usage?.output_tokens ?? 0,
        })
        .then(() => {})
    }

    // ── Pass through ───────────────────────────────────────────────────────
    return new Response(JSON.stringify(anthropicData), {
      status: anthropicRes.ok ? 200 : anthropicRes.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return json({ error: { message: `Proxy chyba: ${msg}` } }, 500, corsHeaders)
  }
})

/** Helper pro JSON response */
function json(body: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  })
}
