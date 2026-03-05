import { urgColor } from "../lib/utils.js";

// ── Pomocné sub-komponenty ────────────────────────────────────────────────────

function SectionLabel({ t, children }) {
  return (
    <div style={{ fontSize: "0.58rem", color: t.textFaint, letterSpacing: "0.12em", marginBottom: 6 }}>
      {children}
    </div>
  );
}

function ObdChip({ code, t }) {
  return (
    <span style={{ fontSize: "0.78rem", color: t.obdText, fontFamily: "monospace", background: t.obdBg, padding: "2px 8px", border: `1px solid ${t.obdBorder}`, borderRadius: 2 }}>
      {code}
    </span>
  );
}

// ── Jedna závada ──────────────────────────────────────────────────────────────

function FaultCard({ fault: f, isPrimary, t }) {
  const accentCol = urgColor(f.naléhavost);
  return (
    <div style={{ background: t.bgCard, border: `1px solid ${isPrimary ? t.accent : t.border}`, padding: "16px", borderLeft: `4px solid ${accentCol}`, marginBottom: 8, borderRadius: 2 }}>

      {/* Název + pravděpodobnost */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10, gap: 8, flexWrap: "wrap" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: "'Barlow Condensed',sans-serif", fontSize: "1.3rem", fontWeight: 700, color: isPrimary ? t.accent : t.text, letterSpacing: "0.04em" }}>
            {isPrimary && "◈ "}{f.název}
          </div>
          {f.díly?.length > 0 && (
            <div style={{ fontSize: "0.66rem", color: t.textFaint, marginTop: 2 }}>
              {f.díly.join(" · ")}
            </div>
          )}
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: "1.5rem", fontFamily: "'Barlow Condensed',sans-serif", fontWeight: 800, color: f.pravděpodobnost > 70 ? t.accent : f.pravděpodobnost > 40 ? "#d97706" : t.textFaint }}>
            {f.pravděpodobnost}%
          </div>
          <div style={{ fontSize: "0.5rem", color: t.textFaint, letterSpacing: "0.08em" }}>PRAVDĚP.</div>
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ height: 3, background: t.probBarBg, marginBottom: 12, borderRadius: 2 }}>
        <div style={{ height: "100%", width: `${f.pravděpodobnost}%`, background: accentCol, borderRadius: 2, transition: "width 1s ease" }} />
      </div>

      <div style={{ fontSize: "0.84rem", color: t.textMuted, lineHeight: 1.7, marginBottom: 10 }}>
        {f.popis}
      </div>

      {/* OBD kódy */}
      {f.obd_kódy?.length > 0 && (
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 10 }}>
          {f.obd_kódy.map((c) => <ObdChip key={c} code={c} t={t} />)}
        </div>
      )}

      {/* Postup opravy */}
      {f.postup && (
        <div style={{ background: t.postupBg, border: `1px solid ${t.postupBorder}`, padding: "10px 14px", marginBottom: 8, borderRadius: 2 }}>
          <SectionLabel t={t}>POSTUP OPRAVY</SectionLabel>
          <div style={{ fontSize: "0.8rem", color: t.textMuted, lineHeight: 1.8 }}>{f.postup}</div>
        </div>
      )}

      {/* Poznámka */}
      {f.poznámka && (
        <div style={{ fontSize: "0.76rem", color: t.noteColor, fontStyle: "italic", borderLeft: `2px solid ${t.noteBorder}`, paddingLeft: 8 }}>
          {f.poznámka}
        </div>
      )}
    </div>
  );
}

// ── Hlavní komponenta ─────────────────────────────────────────────────────────

export default function DiagCard({ result, ragMatches = [], t }) {
  const hasMeta = result.doporučené_testy?.length > 0 || result.varování || result.další_info;

  return (
    <div className="fade-in">
      {/* Shrnutí */}
      <div style={{ padding: "14px 16px", background: t.bgCardAlt, border: `1px solid ${t.borderAccent}`, borderLeft: `3px solid ${t.accent}`, marginBottom: 12, borderRadius: 2 }}>
        <div style={{ fontSize: "0.62rem", color: t.textFaint, letterSpacing: "0.15em", marginBottom: 5 }}>AI DIAGNOSTIKA</div>
        <div style={{ fontSize: "0.88rem", color: t.diagText, lineHeight: 1.6 }}>{result.shrnutí}</div>
        {ragMatches.length > 0 && (
          <div style={{ marginTop: 6, fontSize: "0.7rem", color: t.doneStatusColor }}>
            ◈ Databáze servisu: {ragMatches.length} podobných případů zohledněno
          </div>
        )}
      </div>

      {/* Závady */}
      {result.závady?.map((f, i) => (
        <FaultCard key={i} fault={f} isPrimary={i === 0} t={t} />
      ))}

      {/* Doporučené testy + poznámky */}
      {hasMeta && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
          {result.doporučené_testy?.length > 0 && (
            <div style={{ background: t.bgCard, border: `1px solid ${t.border}`, padding: "12px", borderRadius: 2 }}>
              <SectionLabel t={t}>DOPORUČENÉ TESTY</SectionLabel>
              {result.doporučené_testy.map((test, i) => (
                <div key={i} style={{ fontSize: "0.78rem", color: t.textMuted, padding: "3px 0", borderBottom: `1px solid ${t.border}`, display: "flex", gap: 6 }}>
                  <span style={{ color: t.accent }}>{String(i + 1).padStart(2, "0")}.</span>
                  {test}
                </div>
              ))}
            </div>
          )}
          <div style={{ background: t.bgCard, border: `1px solid ${t.border}`, padding: "12px", borderRadius: 2 }}>
            <SectionLabel t={t}>POZNÁMKY</SectionLabel>
            {result.varování && (
              <div style={{ fontSize: "0.76rem", color: "#dc2626", background: "rgba(220,38,38,0.07)", padding: "6px 8px", marginBottom: 6, borderLeft: "2px solid #dc2626", borderRadius: 2 }}>
                ⚠ {result.varování}
              </div>
            )}
            {result.další_info && (
              <div style={{ fontSize: "0.76rem", color: t.obdText, background: t.obdBg, padding: "6px 8px", borderLeft: `2px solid ${t.borderAccent}`, borderRadius: 2 }}>
                ℹ {result.další_info}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
