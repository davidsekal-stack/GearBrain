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

function Divider({ t }) {
  return <div style={{ borderTop: `1px solid ${t.border}`, margin: "22px 0" }} />;
}

function SectionTitle({ t, children }) {
  return <div style={{ fontSize: "0.65rem", color: t.accent, letterSpacing: "0.12em", marginBottom: 14, fontWeight: 600 }}>{children}</div>;
}

// ── Panel nastavení ───────────────────────────────────────────────────────────

export function SettingsPanel({ t, onClose }) {
  // AI model
  const [currentModel, setCurrentModel] = useState(ANTHROPIC_MODELS[0].id);
  const [modelMsg,     setModelMsg]     = useState("");

  // Cloud info (read-only)
  const [installationId, setInstallationId] = useState("");

  useEffect(() => {
    Promise.all([
      window.electronAPI.model.get(),
      window.electronAPI.cloud.configGet(),
    ]).then(([m, cfg]) => {
      setCurrentModel(m || ANTHROPIC_MODELS[0].id);
      setInstallationId(cfg.installationId || "");
    });
  }, []);

  // ── Model ──────────────────────────────────────────────────────────────────
  const saveModel = async (modelId) => {
    setCurrentModel(modelId);
    await window.electronAPI.model.set(modelId);
    setModelMsg("✓ Model uložen");
    setTimeout(() => setModelMsg(""), 2000);
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: t.bgModal, border: `1px solid ${t.border}`, borderRadius: 4, padding: "28px", width: 500, maxWidth: "94vw", boxShadow: "0 20px 60px rgba(0,0,0,0.4)", maxHeight: "92vh", overflowY: "auto" }}>

        {/* Hlavička */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 22 }}>
          <div style={{ fontFamily: "'Barlow Condensed',sans-serif", fontSize: "1.3rem", fontWeight: 700, color: t.text, letterSpacing: "0.05em" }}>NASTAVENÍ</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: t.textFaint, cursor: "pointer", fontSize: "1.2rem", padding: "0 4px" }}>✕</button>
        </div>

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

        {/* ── Cloud databáze (read-only) ── */}
        <SectionTitle t={t}>CLOUD DATABÁZE</SectionTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", background: t.doneStatusBg, border: `1px solid ${t.doneStatusBorder}`, borderRadius: 2, marginBottom: 12 }}>
          <span style={{ fontSize: "0.75rem", color: t.doneStatusColor }}>● PŘIPOJENO</span>
        </div>
        <p style={{ fontSize: "0.76rem", color: t.textFaint, lineHeight: 1.6, marginBottom: 14 }}>
          Cloud databáze je vestavěná a automaticky aktivní. Uzavřené případy se
          anonymně sdílejí pro zlepšení diagnostiky.
        </p>

        {installationId && (
          <div style={{ padding: "7px 11px", background: t.bgMuted, border: `1px solid ${t.border}`, borderRadius: 2 }}>
            <div style={{ fontSize: "0.62rem", color: t.textVeryFaint, letterSpacing: "0.08em", marginBottom: 2 }}>INSTALLATION ID (anonymní identifikátor)</div>
            <div style={{ fontFamily: "monospace", fontSize: "0.72rem", color: t.textFaint }}>{installationId}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── ConsentScreen ─────────────────────────────────────────────────────────────

export function ConsentScreen({ t, onAccept }) {
  return (
    <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: t.bg, fontFamily: "'IBM Plex Mono','Courier New',monospace", padding: 24 }}>
      <div style={{ width: "100%", maxWidth: 560 }}>

        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 32 }}>
          <div style={{ width: 32, height: 32, background: t.accent, display: "flex", alignItems: "center", justifyContent: "center", clipPath: "polygon(10% 0%,90% 0%,100% 10%,100% 90%,90% 100%,10% 100%,0% 90%,0% 10%)" }}>
            <span style={{ fontSize: "16px" }}>🔧</span>
          </div>
          <div style={{ fontFamily: "'Barlow Condensed',sans-serif", fontSize: "1.6rem", fontWeight: 800, color: t.text, letterSpacing: "0.05em" }}>
            GEAR<span style={{ color: t.accent }}>Brain</span>
          </div>
        </div>

        <div style={{ background: t.bgModal, border: `1px solid ${t.border}`, borderRadius: 4, padding: 28 }}>
          <div style={{ fontFamily: "'Barlow Condensed',sans-serif", fontSize: "1.3rem", fontWeight: 700, color: t.text, marginBottom: 6, letterSpacing: "0.05em" }}>
            OCHRANA OSOBNÍCH ÚDAJŮ
          </div>
          <div style={{ fontSize: "0.68rem", color: t.accentText, letterSpacing: "0.1em", marginBottom: 20 }}>
            GDPR — PŘED ZAHÁJENÍM SI PŘEČTĚTE
          </div>

          <div style={{ fontSize: "0.83rem", color: t.textMuted, lineHeight: 1.8, marginBottom: 20 }}>
            Aplikace GearBrain shromažďuje a odesílá <strong style={{ color: t.text }}>anonymní diagnostická data</strong> do sdílené cloudové databáze za účelem zlepšení přesnosti diagnostiky pro všechny uživatele.
          </div>

          {/* Co se odesílá */}
          <div style={{ background: t.bgMuted, border: `1px solid ${t.border}`, borderRadius: 2, padding: "12px 16px", marginBottom: 16 }}>
            <div style={{ fontSize: "0.65rem", color: t.accentText, letterSpacing: "0.1em", marginBottom: 10 }}>CO SE ODESÍLÁ</div>
            {[
              ["Model vozidla a nájezd", "např. Transit 2.2 TDCi, 185 000 km"],
              ["OBD kódy a příznaky závady", "např. P0401, ztráta výkonu"],
              ["Popis provedené opravy", "vámi zadaný text při uzavření případu"],
              ["Anonymní ID instalace", "náhodné UUID, nelze spojit s osobou"],
            ].map(([title, desc]) => (
              <div key={title} style={{ display: "flex", gap: 8, marginBottom: 6, fontSize: "0.78rem" }}>
                <span style={{ color: t.doneStatusColor, flexShrink: 0 }}>✓</span>
                <span><span style={{ color: t.text }}>{title}</span> <span style={{ color: t.textFaint }}>— {desc}</span></span>
              </div>
            ))}
          </div>

          {/* Co se neodesílá */}
          <div style={{ background: t.bgMuted, border: `1px solid ${t.border}`, borderRadius: 2, padding: "12px 16px", marginBottom: 20 }}>
            <div style={{ fontSize: "0.65rem", color: t.textFaint, letterSpacing: "0.1em", marginBottom: 10 }}>CO SE NEODESÍLÁ</div>
            {[
              "Jméno, adresa ani jiné osobní údaje",
              "VIN číslo ani SPZ vozidla",
              "Obsah AI konverzace",
            ].map((item) => (
              <div key={item} style={{ display: "flex", gap: 8, marginBottom: 6, fontSize: "0.78rem" }}>
                <span style={{ color: "#dc2626", flexShrink: 0 }}>✕</span>
                <span style={{ color: t.textFaint }}>{item}</span>
              </div>
            ))}
          </div>

          <div style={{ fontSize: "0.75rem", color: t.textFaint, lineHeight: 1.7, marginBottom: 24, borderTop: `1px solid ${t.border}`, paddingTop: 16 }}>
            Data jsou zpracovávána na základě <strong style={{ color: t.textMuted }}>oprávněného zájmu</strong> (čl. 6 odst. 1 písm. f GDPR) za účelem zlepšení diagnostiky vozidel. Správcem dat je provozovatel tohoto softwaru. Svůj souhlas můžete kdykoliv odvolat odinstalováním aplikace.
          </div>

          <button onClick={onAccept}
            style={{ width: "100%", background: t.accent, color: "#fff", border: "none", padding: "12px", fontSize: "0.82rem", fontWeight: 700, letterSpacing: "0.08em", cursor: "pointer", fontFamily: "inherit", borderRadius: 2 }}>
            ROZUMÍM A SOUHLASÍM → POKRAČOVAT
          </button>
        </div>
      </div>
    </div>
  );
}
