import { useState } from "react";
import { SYMPTOM_CATEGORIES, COMMON_OBD_CODES } from "../constants/index.js";

const OBD_REGEX = /^[PCBU][0-9A-F]{4}$/;

const TABS = [
  { key: "symptoms", label: "⚡ PŘÍZNAKY" },
  { key: "obd",      label: "📡 OBD"      },
  { key: "text",     label: "✍️ POPIS"   },
];

export default function InputForm({ onSubmit, loading, label = "SPUSTIT DIAGNOSTIKU", t }) {
  const [tab,      setTab]      = useState("symptoms");
  const [symptoms, setSymptoms] = useState([]);
  const [obdInput, setObdInput] = useState("");
  const [obdCodes, setObdCodes] = useState([]);
  const [text,     setText]     = useState("");
  const [openCat,  setOpenCat]  = useState("Motor & Výkon");

  const toggleSymptom = (s) =>
    setSymptoms((prev) => prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]);

  const toggleObd = (code) =>
    setObdCodes((prev) => prev.includes(code) ? prev.filter((x) => x !== code) : [...prev, code]);

  const addObdFromInput = () => {
    const parsed = obdInput.toUpperCase().split(/[\s,;]+/).filter((c) => OBD_REGEX.test(c));
    setObdCodes((prev) => [...new Set([...prev, ...parsed])]);
    setObdInput("");
  };

  const handleSubmit = () => {
    if (!total) return;
    onSubmit({ symptoms, obdCodes, text: text.trim() });
    setSymptoms([]);
    setObdCodes([]);
    setText("");
  };

  const total = symptoms.length + obdCodes.length + (text.trim() ? 1 : 0);

  const tabHints = {
    symptoms: `${symptoms.length} vyb.`,
    obd:      `${obdCodes.length} kódů`,
    text:     text.trim() ? "✓" : "—",
  };

  return (
    <div>
      {/* Tab navigace */}
      <div style={{ display: "flex", borderBottom: `1px solid ${t.border}`, marginBottom: 12 }}>
        {TABS.map(({ key, label: tabLabel }) => (
          <button key={key} onClick={() => setTab(key)}
            style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", padding: "8px 14px", borderBottom: tab === key ? `2px solid ${t.accent}` : "2px solid transparent", color: tab === key ? t.accent : t.textLabel, fontSize: "0.68rem", letterSpacing: "0.08em", fontWeight: 600 }}>
            {tabLabel}
            <span style={{ display: "block", fontSize: "0.54rem", color: tab === key ? t.accentText : t.textVeryFaint, marginTop: 1 }}>
              {tabHints[key]}
            </span>
          </button>
        ))}
      </div>

      {/* Panel: Příznaky */}
      {tab === "symptoms" && (
        <div style={{ maxHeight: 280, overflowY: "auto" }}>
          {Object.entries(SYMPTOM_CATEGORIES).map(([cat, syms]) => {
            const selectedCount = syms.filter((s) => symptoms.includes(s)).length;
            const isOpen = openCat === cat;
            return (
              <div key={cat} style={{ marginBottom: 4 }}>
                <button onClick={() => setOpenCat(isOpen ? null : cat)}
                  style={{ width: "100%", textAlign: "left", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", padding: "7px 10px", backgroundColor: isOpen ? t.bgCatOpen : t.bgCat, color: isOpen ? t.accent : t.textLabel, fontSize: "0.65rem", letterSpacing: "0.08em", borderLeft: isOpen ? `3px solid ${t.accent}` : `3px solid ${t.border}` }}>
                  {isOpen ? "▼" : "▶"} {cat.toUpperCase()}
                  {selectedCount > 0 && <span style={{ marginLeft: 8, color: t.textFaint }}>({selectedCount})</span>}
                </button>
                {isOpen && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5, padding: "8px 10px", background: t.bgMuted, borderLeft: `3px solid ${t.border}` }}>
                    {syms.map((s) => {
                      const sel = symptoms.includes(s);
                      return (
                        <div key={s} onClick={() => toggleSymptom(s)}
                          style={{ cursor: "pointer", userSelect: "none", padding: "4px 9px", fontSize: "0.68rem", background: sel ? t.chipSelBg : t.chipBg, color: sel ? t.chipSelText : t.chipText, border: `1px solid ${sel ? t.accent : t.chipBorder}`, fontWeight: sel ? 600 : 400, borderRadius: 2, transition: "all 0.12s" }}>
                          {s}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Panel: OBD kódy (bez OBD čtečky ve webové verzi) */}
      {tab === "obd" && (
        <div>
          <div style={{ display: "flex", gap: 7, marginBottom: 10 }}>
            <input value={obdInput} onChange={(e) => setObdInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addObdFromInput()}
              placeholder="P0401, P2263..."
              style={{ flex: 1, background: t.bgInput, border: `1px solid ${t.borderInput}`, color: t.text, padding: "8px 10px", fontSize: "0.78rem", fontFamily: "'IBM Plex Mono',monospace", borderRadius: 2, outline: "none" }} />
            <button onClick={addObdFromInput}
              style={{ background: t.accent, color: "#fff", border: "none", cursor: "pointer", padding: "8px 14px", fontSize: "0.7rem", fontFamily: "inherit", fontWeight: 700, borderRadius: 2 }}>
              +
            </button>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 8 }}>
            {COMMON_OBD_CODES.map((c) => {
              const sel = obdCodes.includes(c);
              return (
                <div key={c} onClick={() => toggleObd(c)}
                  style={{ cursor: "pointer", userSelect: "none", padding: "4px 10px", fontFamily: "monospace", fontSize: "0.75rem", background: sel ? t.accent : t.bgInput, color: sel ? "#fff" : t.obdText, border: `1px solid ${sel ? t.accent : t.obdBorder}`, borderRadius: 2, transition: "all 0.12s" }}>
                  {c}
                </div>
              );
            })}
          </div>

          {obdCodes.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {obdCodes.map((c) => (
                <div key={c} onClick={() => toggleObd(c)}
                  style={{ padding: "2px 8px", background: t.obdBg, border: `1px solid ${t.accent}`, color: t.accent, fontSize: "0.72rem", fontFamily: "monospace", cursor: "pointer", borderRadius: 2 }}>
                  {c} ✕
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Panel: Volný text */}
      {tab === "text" && (
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4}
          placeholder="Popište závadu vlastními slovy... např. 'Po nastartování přešel do nouzového režimu, černý kouř, svítí kontrolka motoru a DPF...'"
          style={{ width: "100%", background: t.bgInput, border: `1px solid ${t.borderInput}`, color: t.text, padding: "10px 12px", fontSize: "0.8rem", lineHeight: 1.7, fontFamily: "'IBM Plex Mono',monospace", resize: "vertical", outline: "none", borderRadius: 2 }} />
      )}

      {/* Spodní lišta: souhrn + odeslat */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10, padding: "10px 12px", background: t.bgMuted, border: `1px solid ${t.border}`, borderRadius: 2 }}>
        <div style={{ display: "flex", gap: 12, fontSize: "0.7rem" }}>
          {symptoms.length > 0 && <span style={{ color: t.accent }}>⚡ {symptoms.length}</span>}
          {obdCodes.length > 0 && <span style={{ color: t.obdText }}>📡 {obdCodes.length}</span>}
          {text.trim()         && <span style={{ color: t.doneStatusColor }}>✍️</span>}
          {total === 0         && <span style={{ color: t.textVeryFaint }}>Zadejte příznaky nebo OBD kódy</span>}
        </div>
        <button disabled={total === 0 || loading} onClick={handleSubmit}
          style={{ background: total > 0 ? t.accent : t.border, color: total > 0 ? "#fff" : t.textFaint, border: "none", cursor: total > 0 && !loading ? "pointer" : "not-allowed", padding: "9px 22px", letterSpacing: "0.1em", fontSize: "0.75rem", fontFamily: "inherit", fontWeight: 700, borderRadius: 2, transition: "all 0.2s", opacity: total === 0 || loading ? 0.55 : 1 }}>
          {loading
            ? <span style={{ display: "inline-block", animation: "pulse 1.5s ease infinite" }}>Analyzuji...</span>
            : `▶ ${label}`}
        </button>
      </div>
    </div>
  );
}

// ── FollowUpPrompt — jednoduchá promptlina pro pokračování diagnostiky ─────────
export function FollowUpPrompt({ onSubmit, loading, t }) {
  const [text, setText] = useState("");

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;
    onSubmit({ symptoms: [], obdCodes: [], text: trimmed });
    setText("");
  };

  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); } }}
        placeholder="Popište nové zjištění nebo doplňte informace... (Enter = odeslat, Shift+Enter = nový řádek)"
        rows={2}
        style={{ flex: 1, background: t.bgInput, border: `1px solid ${t.borderInput}`, color: t.text, padding: "10px 12px", fontSize: "0.88rem", lineHeight: 1.6, fontFamily: "'IBM Plex Mono',monospace", resize: "none", outline: "none", borderRadius: 2 }}
      />
      <button
        disabled={!text.trim() || loading}
        onClick={handleSubmit}
        style={{ background: text.trim() ? t.accent : t.border, color: text.trim() ? "#fff" : t.textFaint, border: "none", cursor: text.trim() && !loading ? "pointer" : "not-allowed", padding: "10px 20px", fontSize: "0.82rem", fontFamily: "inherit", fontWeight: 700, borderRadius: 2, transition: "all 0.2s", whiteSpace: "nowrap", flexShrink: 0 }}>
        {loading
          ? <span style={{ animation: "pulse 1.5s ease infinite", display: "inline-block" }}>...</span>
          : "▶ Odeslat"}
      </button>
    </div>
  );
}
