import { useState, useEffect } from "react";

// ── Dostupné modely Anthropic ─────────────────────────────────────────────────
export const ANTHROPIC_MODELS = [
  { id: "claude-sonnet-4-6",          label: "Claude Sonnet 4.6",  desc: "Výchozí — nejlepší poměr přesnosti a rychlosti" },
  { id: "claude-opus-4-6",            label: "Claude Opus 4.6",    desc: "Nejpřesnější — pomalejší, vyšší cena" },
  { id: "claude-haiku-4-5-20251001",  label: "Claude Haiku 4.5",   desc: "Nejrychlejší — nižší cena, méně detailů" },
];

// ── Sdílené sub-komponenty ────────────────────────────────────────────────────

export function AppLogo({ t, subtitle }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
      <div style={{ width: 40, height: 40, background: t.accent, display: "flex", alignItems: "center", justifyContent: "center", clipPath: "polygon(10% 0%,90% 0%,100% 10%,100% 90%,90% 100%,10% 100%,0% 90%,0% 10%)" }}>
        <span style={{ fontSize: "20px" }}>🔧</span>
      </div>
      <div>
        <div style={{ fontFamily: "'Barlow Condensed',sans-serif", fontSize: "1.6rem", fontWeight: 800, color: t.text }}>
          GEAR<span style={{ color: t.accent }}>Brain</span>
        </div>
        <div style={{ fontSize: "0.65rem", color: t.textFaint, letterSpacing: "0.1em" }}>{subtitle}</div>
      </div>
    </div>
  );
}

function FieldLabel({ t, children }) {
  return <div style={{ fontSize: "0.65rem", color: t.textFaint, letterSpacing: "0.1em", marginBottom: 7 }}>{children}</div>;
}

function ToggleVisibility({ show, onToggle, t }) {
  return (
    <button onClick={onToggle}
      style={{ background: t.bgMuted, border: `1px solid ${t.border}`, color: t.textFaint, padding: "8px 12px", cursor: "pointer", borderRadius: 2, fontSize: "0.9rem" }}>
      {show ? "🙈" : "👁"}
    </button>
  );
}

function Divider({ t }) {
  return <div style={{ borderTop: `1px solid ${t.border}`, margin: "22px 0" }} />;
}

function SectionTitle({ t, children }) {
  return <div style={{ fontSize: "0.65rem", color: t.accent, letterSpacing: "0.12em", marginBottom: 14, fontWeight: 600 }}>{children}</div>;
}

function validateApiKey(key) {
  if (!key.startsWith("sk-ant-")) return "Klíč musí začínat na 'sk-ant-'";
  return null;
}

// ── Obrazovka prvního spuštění ────────────────────────────────────────────────

export function ApiKeyScreen({ t, onSaved }) {
  const [key,    setKey]    = useState("");
  const [show,   setShow]   = useState(false);
  const [saving, setSaving] = useState(false);
  const [err,    setErr]    = useState("");

  const save = async () => {
    const trimmed = key.trim();
    const validationErr = validateApiKey(trimmed);
    if (validationErr) { setErr(validationErr); return; }
    setSaving(true);
    try {
      await window.electronAPI.apiKey.set(trimmed);
      onSaved();
    } catch (e) {
      setErr("Chyba při ukládání: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: t.bg, fontFamily: "'IBM Plex Mono','Courier New',monospace" }}>
      <div style={{ width: 500, padding: "36px", background: t.bgModal, border: `1px solid ${t.borderAccent}`, borderTop: `3px solid ${t.accent}`, borderRadius: 4 }}>
        <AppLogo t={t} subtitle="PRVNÍ SPUŠTĚNÍ" />
        <p style={{ fontSize: "0.85rem", color: t.textMuted, lineHeight: 1.7, marginBottom: 22 }}>
          Pro fungování aplikace je potřeba <strong style={{ color: t.text }}>Anthropic API klíč</strong>.<br />
          Klíč je uložen pouze lokálně na tomto počítači a nikam se neodesílá.
        </p>
        <FieldLabel t={t}>ANTHROPIC API KLÍČ</FieldLabel>
        <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
          <input type={show ? "text" : "password"} value={key}
            onChange={(e) => { setKey(e.target.value); setErr(""); }}
            onKeyDown={(e) => e.key === "Enter" && save()}
            placeholder="sk-ant-api03-..." autoFocus
            style={{ flex: 1, background: t.bgInput, border: `1px solid ${err ? "#dc2626" : t.borderInput}`, color: t.text, padding: "10px 12px", fontSize: "0.88rem", fontFamily: "'IBM Plex Mono',monospace", borderRadius: 2, outline: "none" }} />
          <ToggleVisibility show={show} onToggle={() => setShow((s) => !s)} t={t} />
        </div>
        {err && <div style={{ fontSize: "0.78rem", color: "#dc2626", marginBottom: 10 }}>⚠ {err}</div>}
        <p style={{ fontSize: "0.72rem", color: t.textVeryFaint, marginBottom: 22, lineHeight: 1.6 }}>
          Klíč získáte na <span style={{ color: t.accentText }}>console.anthropic.com</span> → API Keys → Create Key
        </p>
        <button onClick={save} disabled={!key.trim() || saving}
          style={{ width: "100%", background: key.trim() ? t.accent : t.border, color: key.trim() ? "#fff" : t.textFaint, border: "none", cursor: key.trim() ? "pointer" : "not-allowed", padding: "12px", fontSize: "0.82rem", letterSpacing: "0.1em", fontWeight: 700, fontFamily: "inherit", borderRadius: 2, transition: "all 0.2s" }}>
          {saving ? "Ukládám..." : "✓ ULOŽIT A SPUSTIT"}
        </button>
      </div>
    </div>
  );
}

// ── Panel nastavení ───────────────────────────────────────────────────────────

export function SettingsPanel({ t, onClose, onKeyDeleted, onCloudConfigSaved }) {
  // Anthropic API klíč
  const [maskedKey,    setMaskedKey]    = useState("načítám...");
  const [newKey,       setNewKey]       = useState("");
  const [showKey,      setShowKey]      = useState(false);
  const [keyMsg,       setKeyMsg]       = useState("");

  // AI model
  const [currentModel, setCurrentModel] = useState(ANTHROPIC_MODELS[0].id);
  const [modelMsg,     setModelMsg]     = useState("");

  // Cloud / Supabase
  const [cloudEnabled,    setCloudEnabled]    = useState(false);
  const [cloudUrl,        setCloudUrl]        = useState("");
  const [cloudKey,        setCloudKey]        = useState("");
  const [cloudKeyMasked,  setCloudKeyMasked]  = useState("");
  const [showCloudKey,    setShowCloudKey]    = useState(false);
  const [cloudMsg,        setCloudMsg]        = useState("");
  const [cloudTesting,    setCloudTesting]    = useState(false);
  const [installationId,  setInstallationId]  = useState("");

  useEffect(() => {
    Promise.all([
      window.electronAPI.apiKey.get(),
      window.electronAPI.model.get(),
      window.electronAPI.cloud.configGet(),
    ]).then(([k, m, cfg]) => {
      setMaskedKey(k ? `${k.slice(0, 12)}••••••••••••${k.slice(-4)}` : "—");
      setCurrentModel(m || ANTHROPIC_MODELS[0].id);
      setCloudEnabled(cfg.enabled);
      setCloudUrl(cfg.url || "");
      setCloudKeyMasked(cfg.keyMasked || "");
      setInstallationId(cfg.installationId || "");
    });
  }, []);

  // ── API klíč ───────────────────────────────────────────────────────────────
  const updateKey = async () => {
    const trimmed = newKey.trim();
    const err = validateApiKey(trimmed);
    if (err) { setKeyMsg("⚠ " + err); return; }
    await window.electronAPI.apiKey.set(trimmed);
    setKeyMsg("✓ Klíč aktualizován");
    setNewKey("");
    setMaskedKey(`${trimmed.slice(0, 12)}••••••••••••${trimmed.slice(-4)}`);
  };

  const deleteKey = async () => {
    if (!window.confirm("Opravdu smazat API klíč? Aplikace přestane fungovat.")) return;
    await window.electronAPI.apiKey.delete();
    onKeyDeleted();
  };

  // ── Model ──────────────────────────────────────────────────────────────────
  const saveModel = async (modelId) => {
    setCurrentModel(modelId);
    await window.electronAPI.model.set(modelId);
    setModelMsg("✓ Model uložen");
    setTimeout(() => setModelMsg(""), 2000);
  };

  // ── Cloud ──────────────────────────────────────────────────────────────────
  const saveCloud = async () => {
    const url = cloudUrl.trim();
    const key = cloudKey.trim();
    if (!url || !key) { setCloudMsg("⚠ Vyplňte URL i klíč"); return; }
    if (!url.startsWith("https://")) { setCloudMsg("⚠ URL musí začínat https://"); return; }
    await window.electronAPI.cloud.configSet(url, key);
    setCloudEnabled(true);
    setCloudKeyMasked(`${key.slice(0, 20)}••••••••${key.slice(-6)}`);
    setCloudKey("");
    setCloudMsg("✓ Uloženo — načítám databázi...");
    // FIX #9: Spustit načtení cloudové DB ihned po uložení konfigurace
    if (onCloudConfigSaved) onCloudConfigSaved();
    setTimeout(() => setCloudMsg(""), 3000);
  };

  const testCloud = async () => {
    setCloudTesting(true);
    setCloudMsg("Testuji připojení...");
    const { ok, count, error } = await window.electronAPI.cloud.test();
    setCloudTesting(false);
    if (ok) {
      setCloudMsg(`✓ Připojeno · ${count !== null ? `${count} záznamů v databázi` : "databáze dostupná"}`);
    } else {
      setCloudMsg(`⚠ ${error}`);
    }
  };

  const deleteCloud = async () => {
    if (!window.confirm("Odpojit cloud databázi? Záznamy v Supabase zůstanou zachovány.")) return;
    await window.electronAPI.cloud.configDelete();
    setCloudEnabled(false);
    setCloudUrl("");
    setCloudKeyMasked("");
    setCloudMsg("");
  };

  const cloudMsgOk = cloudMsg.startsWith("✓");

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: t.bgModal, border: `1px solid ${t.border}`, borderRadius: 4, padding: "28px", width: 500, maxWidth: "94vw", boxShadow: "0 20px 60px rgba(0,0,0,0.4)", maxHeight: "92vh", overflowY: "auto" }}>

        {/* Hlavička */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 22 }}>
          <div style={{ fontFamily: "'Barlow Condensed',sans-serif", fontSize: "1.3rem", fontWeight: 700, color: t.text, letterSpacing: "0.05em" }}>NASTAVENÍ</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: t.textFaint, cursor: "pointer", fontSize: "1.2rem", padding: "0 4px" }}>✕</button>
        </div>

        {/* ── API klíč ── */}
        <SectionTitle t={t}>API KLÍČ</SectionTitle>
        <FieldLabel t={t}>AKTUÁLNÍ KLÍČ</FieldLabel>
        <div style={{ fontFamily: "monospace", fontSize: "0.82rem", color: t.textMuted, background: t.bgMuted, padding: "9px 12px", border: `1px solid ${t.border}`, borderRadius: 2, marginBottom: 16 }}>
          {maskedKey}
        </div>
        <FieldLabel t={t}>NOVÝ KLÍČ (volitelné)</FieldLabel>
        <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
          <input type={showKey ? "text" : "password"} value={newKey}
            onChange={(e) => { setNewKey(e.target.value); setKeyMsg(""); }}
            placeholder="sk-ant-api03-..."
            style={{ flex: 1, background: t.bgInput, border: `1px solid ${t.borderInput}`, color: t.text, padding: "9px 11px", fontSize: "0.82rem", fontFamily: "monospace", borderRadius: 2, outline: "none" }} />
          <ToggleVisibility show={showKey} onToggle={() => setShowKey((s) => !s)} t={t} />
        </div>
        {keyMsg && <div style={{ fontSize: "0.76rem", color: keyMsg.startsWith("✓") ? "#16a34a" : "#dc2626", marginBottom: 8 }}>{keyMsg}</div>}
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button onClick={updateKey} disabled={!newKey.trim()}
            style={{ flex: 1, background: newKey.trim() ? t.accent : t.border, color: newKey.trim() ? "#fff" : t.textFaint, border: "none", cursor: newKey.trim() ? "pointer" : "not-allowed", padding: "9px", fontSize: "0.76rem", fontWeight: 700, fontFamily: "inherit", borderRadius: 2 }}>
            Aktualizovat klíč
          </button>
          <button onClick={deleteKey}
            style={{ background: "rgba(220,38,38,0.1)", border: "1px solid rgba(220,38,38,0.4)", color: "#dc2626", padding: "9px 16px", fontSize: "0.76rem", cursor: "pointer", fontFamily: "inherit", borderRadius: 2 }}>
            Smazat klíč
          </button>
        </div>

        <Divider t={t} />

        {/* ── AI Model ── */}
        <SectionTitle t={t}>AI MODEL</SectionTitle>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {ANTHROPIC_MODELS.map((m) => {
            const selected = currentModel === m.id;
            return (
              <button key={m.id} onClick={() => saveModel(m.id)}
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 14px", background: selected ? t.bgCardAlt : t.bgMuted, border: `1px solid ${selected ? t.accent : t.border}`, borderLeft: `3px solid ${selected ? t.accent : "transparent"}`, borderRadius: 2, cursor: "pointer", fontFamily: "inherit", textAlign: "left", transition: "all 0.12s" }}>
                <div style={{ width: 14, height: 14, borderRadius: "50%", border: `2px solid ${selected ? t.accent : t.textFaint}`, background: selected ? t.accent : "transparent", flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: "0.85rem", color: selected ? t.text : t.textMuted, fontWeight: selected ? 600 : 400 }}>{m.label}</div>
                  <div style={{ fontSize: "0.72rem", color: t.textFaint, marginTop: 2 }}>{m.desc}</div>
                </div>
              </button>
            );
          })}
        </div>
        {modelMsg && <div style={{ fontSize: "0.76rem", color: "#16a34a", marginTop: 10 }}>{modelMsg}</div>}

        <Divider t={t} />

        {/* ── Cloud databáze ── */}
        <SectionTitle t={t}>CLOUD DATABÁZE</SectionTitle>

        {/* Stav připojení */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", background: cloudEnabled ? t.doneStatusBg : t.bgMuted, border: `1px solid ${cloudEnabled ? t.doneStatusBorder : t.border}`, borderRadius: 2, marginBottom: 16 }}>
          <span style={{ fontSize: "0.75rem", color: cloudEnabled ? t.doneStatusColor : t.textVeryFaint }}>
            {cloudEnabled ? "● PŘIPOJENO" : "○ NEPŘIPOJENO"}
          </span>
          {cloudEnabled && cloudUrl && (
            <span style={{ fontSize: "0.72rem", color: t.textFaint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              · {cloudUrl.replace("https://", "")}
            </span>
          )}
        </div>

        {/* Popis co cloud dělá */}
        <p style={{ fontSize: "0.76rem", color: t.textFaint, lineHeight: 1.6, marginBottom: 16 }}>
          Uzavřené případy se automaticky sdílejí do globální anonymní databáze.
          Při diagnostice aplikace prohledá záznamy od všech servisů — čím více zákazníků,
          tím přesnější výsledky.
        </p>

        {/* Formulář pro URL + klíč */}
        <FieldLabel t={t}>SUPABASE PROJECT URL</FieldLabel>
        <input value={cloudUrl} onChange={(e) => setCloudUrl(e.target.value)}
          placeholder="https://xxxxxxxxxxxx.supabase.co"
          style={{ width: "100%", background: t.bgInput, border: `1px solid ${t.borderInput}`, color: t.text, padding: "9px 11px", fontSize: "0.82rem", fontFamily: "monospace", borderRadius: 2, outline: "none", marginBottom: 12 }} />

        <FieldLabel t={t}>{cloudEnabled ? "ANON KLÍČ (zanechte prázdné pro zachování stávajícího)" : "SUPABASE ANON KEY"}</FieldLabel>
        {cloudEnabled && cloudKeyMasked && !cloudKey && (
          <div style={{ fontFamily: "monospace", fontSize: "0.78rem", color: t.textMuted, background: t.bgMuted, padding: "8px 11px", border: `1px solid ${t.border}`, borderRadius: 2, marginBottom: 8 }}>
            {cloudKeyMasked}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
          <input type={showCloudKey ? "text" : "password"} value={cloudKey}
            onChange={(e) => setCloudKey(e.target.value)}
            placeholder={cloudEnabled ? "Nový klíč (volitelné)" : "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."}
            style={{ flex: 1, background: t.bgInput, border: `1px solid ${t.borderInput}`, color: t.text, padding: "9px 11px", fontSize: "0.78rem", fontFamily: "monospace", borderRadius: 2, outline: "none" }} />
          <ToggleVisibility show={showCloudKey} onToggle={() => setShowCloudKey((s) => !s)} t={t} />
        </div>

        {cloudMsg && (
          <div style={{ fontSize: "0.76rem", color: cloudMsgOk ? "#16a34a" : "#dc2626", marginBottom: 10, lineHeight: 1.5 }}>
            {cloudMsg}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button onClick={saveCloud}
            style={{ flex: 1, background: t.accent, color: "#fff", border: "none", cursor: "pointer", padding: "9px", fontSize: "0.76rem", fontWeight: 700, fontFamily: "inherit", borderRadius: 2 }}>
            {cloudEnabled ? "Aktualizovat" : "✓ Připojit cloud"}
          </button>
          {cloudEnabled && (
            <button onClick={testCloud} disabled={cloudTesting}
              style={{ background: t.bgMuted, border: `1px solid ${t.border}`, color: t.textMuted, padding: "9px 14px", fontSize: "0.76rem", cursor: cloudTesting ? "not-allowed" : "pointer", fontFamily: "inherit", borderRadius: 2 }}>
              {cloudTesting ? "..." : "Test"}
            </button>
          )}
          {cloudEnabled && (
            <button onClick={deleteCloud}
              style={{ background: "rgba(220,38,38,0.1)", border: "1px solid rgba(220,38,38,0.4)", color: "#dc2626", padding: "9px 14px", fontSize: "0.76rem", cursor: "pointer", fontFamily: "inherit", borderRadius: 2 }}>
              Odpojit
            </button>
          )}
        </div>

        {/* Installation ID — pro přehled v Supabase dashboardu */}
        {installationId && (
          <div style={{ marginTop: 14, padding: "7px 11px", background: t.bgMuted, border: `1px solid ${t.border}`, borderRadius: 2 }}>
            <div style={{ fontSize: "0.62rem", color: t.textVeryFaint, letterSpacing: "0.08em", marginBottom: 2 }}>INSTALLATION ID (anonymní identifikátor)</div>
            <div style={{ fontFamily: "monospace", fontSize: "0.72rem", color: t.textFaint }}>{installationId}</div>
          </div>
        )}
      </div>
    </div>
  );
}
