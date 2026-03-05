import { useState, useEffect } from "react";

// ── Sdílené mini-komponenty ───────────────────────────────────────────────────

function AppLogo({ t, subtitle }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
      <div style={{ width: 40, height: 40, background: t.accent, display: "flex", alignItems: "center", justifyContent: "center", clipPath: "polygon(10% 0%,90% 0%,100% 10%,100% 90%,90% 100%,10% 100%,0% 90%,0% 10%)" }}>
        <span style={{ fontSize: "20px" }}>🔧</span>
      </div>
      <div>
        <div style={{ fontFamily: "'Barlow Condensed',sans-serif", fontSize: "1.5rem", fontWeight: 800, color: t.text }}>
          GEAR<span style={{ color: t.accent }}>Brain</span>
        </div>
        <div style={{ fontSize: "0.52rem", color: t.textFaint, letterSpacing: "0.1em" }}>{subtitle}</div>
      </div>
    </div>
  );
}

function FieldLabel({ t, children }) {
  return (
    <div style={{ fontSize: "0.58rem", color: t.textFaint, letterSpacing: "0.1em", marginBottom: 6 }}>
      {children}
    </div>
  );
}

function ToggleVisibility({ show, onToggle, t }) {
  return (
    <button onClick={onToggle}
      style={{ background: t.bgMuted, border: `1px solid ${t.border}`, color: t.textFaint, padding: "8px 12px", cursor: "pointer", borderRadius: 2, fontSize: "0.9rem" }}>
      {show ? "🙈" : "👁"}
    </button>
  );
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
      <div style={{ width: 480, padding: "32px", background: t.bgModal, border: `1px solid ${t.borderAccent}`, borderTop: `3px solid ${t.accent}`, borderRadius: 4 }}>
        <AppLogo t={t} subtitle="PRVNÍ SPUŠTĚNÍ" />

        <p style={{ fontSize: "0.8rem", color: t.textMuted, lineHeight: 1.7, marginBottom: 20 }}>
          Pro fungování aplikace je potřeba <strong style={{ color: t.text }}>Anthropic API klíč</strong>.<br />
          Klíč je uložen pouze lokálně na tomto počítači a nikam se neodesílá.
        </p>

        <FieldLabel t={t}>ANTHROPIC API KLÍČ</FieldLabel>
        <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
          <input
            type={show ? "text" : "password"}
            value={key}
            onChange={(e) => { setKey(e.target.value); setErr(""); }}
            onKeyDown={(e) => e.key === "Enter" && save()}
            placeholder="sk-ant-api03-..."
            autoFocus
            style={{ flex: 1, background: t.bgInput, border: `1px solid ${err ? "#dc2626" : t.borderInput}`, color: t.text, padding: "10px 12px", fontSize: "0.82rem", fontFamily: "'IBM Plex Mono',monospace", borderRadius: 2, outline: "none" }}
          />
          <ToggleVisibility show={show} onToggle={() => setShow((s) => !s)} t={t} />
        </div>
        {err && <div style={{ fontSize: "0.72rem", color: "#dc2626", marginBottom: 10 }}>⚠ {err}</div>}

        <p style={{ fontSize: "0.62rem", color: t.textVeryFaint, marginBottom: 20, lineHeight: 1.6 }}>
          Klíč získáte na{" "}
          <span style={{ color: t.accentText }}>console.anthropic.com</span>
          {" "}→ API Keys → Create Key
        </p>

        <button onClick={save} disabled={!key.trim() || saving}
          style={{ width: "100%", background: key.trim() ? t.accent : t.border, color: key.trim() ? "#fff" : t.textFaint, border: "none", cursor: key.trim() ? "pointer" : "not-allowed", padding: "11px", fontSize: "0.78rem", letterSpacing: "0.1em", fontWeight: 700, fontFamily: "inherit", borderRadius: 2, transition: "all 0.2s" }}>
          {saving ? "Ukládám..." : "✓ ULOŽIT A SPUSTIT"}
        </button>
      </div>
    </div>
  );
}

// ── Panel nastavení (modální overlay) ─────────────────────────────────────────

export function SettingsPanel({ t, onClose, onKeyDeleted }) {
  const [maskedKey, setMaskedKey] = useState("načítám...");
  const [newKey,    setNewKey]    = useState("");
  const [show,      setShow]      = useState(false);
  const [msg,       setMsg]       = useState("");

  useEffect(() => {
    window.electronAPI.apiKey.get().then((k) => {
      setMaskedKey(k ? `${k.slice(0, 12)}••••••••••••${k.slice(-4)}` : "—");
    });
  }, []);

  const updateKey = async () => {
    const trimmed = newKey.trim();
    const validationErr = validateApiKey(trimmed);
    if (validationErr) { setMsg("⚠ " + validationErr); return; }
    await window.electronAPI.apiKey.set(trimmed);
    setMsg("✓ Klíč aktualizován");
    setNewKey("");
    setMaskedKey(`${trimmed.slice(0, 12)}••••••••••••${trimmed.slice(-4)}`);
  };

  const deleteKey = async () => {
    if (!window.confirm("Opravdu smazat API klíč? Aplikace přestane fungovat.")) return;
    await window.electronAPI.apiKey.delete();
    onKeyDeleted();
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: t.bgModal, border: `1px solid ${t.border}`, borderRadius: 4, padding: "28px", width: 440, maxWidth: "92vw", boxShadow: "0 20px 60px rgba(0,0,0,0.4)" }}>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div style={{ fontFamily: "'Barlow Condensed',sans-serif", fontSize: "1.2rem", fontWeight: 700, color: t.text, letterSpacing: "0.05em" }}>NASTAVENÍ</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: t.textFaint, cursor: "pointer", fontSize: "1.2rem", padding: "0 4px" }}>✕</button>
        </div>

        <FieldLabel t={t}>AKTUÁLNÍ API KLÍČ</FieldLabel>
        <div style={{ fontFamily: "monospace", fontSize: "0.78rem", color: t.textMuted, background: t.bgMuted, padding: "8px 12px", border: `1px solid ${t.border}`, borderRadius: 2, marginBottom: 16 }}>
          {maskedKey}
        </div>

        <FieldLabel t={t}>NOVÝ API KLÍČ (volitelné)</FieldLabel>
        <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
          <input type={show ? "text" : "password"} value={newKey}
            onChange={(e) => { setNewKey(e.target.value); setMsg(""); }}
            placeholder="sk-ant-api03-..."
            style={{ flex: 1, background: t.bgInput, border: `1px solid ${t.borderInput}`, color: t.text, padding: "8px 10px", fontSize: "0.78rem", fontFamily: "monospace", borderRadius: 2, outline: "none" }} />
          <ToggleVisibility show={show} onToggle={() => setShow((s) => !s)} t={t} />
        </div>
        {msg && (
          <div style={{ fontSize: "0.72rem", color: msg.startsWith("✓") ? "#16a34a" : "#dc2626", marginBottom: 8 }}>{msg}</div>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button onClick={updateKey} disabled={!newKey.trim()}
            style={{ flex: 1, background: newKey.trim() ? t.accent : t.border, color: newKey.trim() ? "#fff" : t.textFaint, border: "none", cursor: newKey.trim() ? "pointer" : "not-allowed", padding: "8px", fontSize: "0.72rem", fontWeight: 700, fontFamily: "inherit", borderRadius: 2 }}>
            Aktualizovat klíč
          </button>
          <button onClick={deleteKey}
            style={{ background: "rgba(220,38,38,0.1)", border: "1px solid rgba(220,38,38,0.4)", color: "#dc2626", padding: "8px 16px", fontSize: "0.72rem", cursor: "pointer", fontFamily: "inherit", borderRadius: 2 }}>
            Smazat klíč
          </button>
        </div>
      </div>
    </div>
  );
}
