/**
 * ConfirmModal — nahrazuje window.confirm() aby ladil s dark theme.
 *
 * Props:
 *   title      — nadpis modálu
 *   message    — text zprávy
 *   onConfirm  — callback při potvrzení
 *   onCancel   — callback při zrušení
 *   confirmLabel — text tlačítka (default "Potvrdit")
 *   danger     — pokud true, potvrzení je červené
 *   t          — téma objekt
 */
export default function ConfirmModal({ title, message, onConfirm, onCancel, confirmLabel = "Potvrdit", danger = false, t }) {
  return (
    <div onClick={onCancel} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: t.bgModal, border: `1px solid ${t.border}`, borderRadius: 4, padding: "26px", width: 400, maxWidth: "92vw", boxShadow: "0 20px 60px rgba(0,0,0,0.35)" }}>
        <div style={{ fontFamily: "'Barlow Condensed',sans-serif", fontSize: "1.3rem", fontWeight: 700, color: danger ? "#dc2626" : t.text, marginBottom: 10 }}>
          {title}
        </div>
        <p style={{ fontSize: "0.85rem", color: t.textMuted, marginBottom: 20, lineHeight: 1.6 }}>
          {message}
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onCancel}
            style={{ background: "transparent", border: `1px solid ${t.border}`, color: t.textFaint, padding: "8px 20px", fontSize: "0.82rem", cursor: "pointer", fontFamily: "inherit", borderRadius: 2 }}>
            Zrušit
          </button>
          <button onClick={onConfirm}
            style={{ background: danger ? "rgba(220,38,38,0.1)" : t.accent, border: `1px solid ${danger ? "#dc2626" : t.accent}`, color: danger ? "#dc2626" : "#fff", padding: "8px 20px", fontSize: "0.82rem", fontWeight: 700, cursor: "pointer", fontFamily: "inherit", borderRadius: 2 }}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
