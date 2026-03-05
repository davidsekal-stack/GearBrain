import { useState, useRef, useEffect, useCallback } from "react";

import { DARK, LIGHT }                      from "./theme.js";
import { VEHICLE_MODELS, EMPTY_VEHICLE }    from "./constants/index.js";
import { uid, fmtDate, fmtMileage }         from "./lib/utils.js";
import { findSimilar }                      from "./lib/rag.js";
import { smartRepair, buildSystemPrompt }   from "./lib/ai.js";
import DiagCard                             from "./components/DiagCard.jsx";
import InputForm                            from "./components/InputForm.jsx";
import { ApiKeyScreen, SettingsPanel }      from "./components/Auth.jsx";

// ── Electron storage API wrapper ──────────────────────────────────────────────
const store = {
  get: (key)        => window.electronAPI.storage.get(key),
  set: (key, value) => window.electronAPI.storage.set(key, value),
};

const SESSIONS_KEY = "gearbrain_sessions";

// ── Globální styly ────────────────────────────────────────────────────────────
function GlobalStyles({ t, darkMode }) {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Barlow+Condensed:wght@400;600;700;800&display=swap');
      * { box-sizing: border-box; margin: 0; padding: 0; }
      ::-webkit-scrollbar { width: 5px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: ${t.accent}; border-radius: 3px; }
      @keyframes fadeIn  { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes pulse   { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
      .fade-in   { animation: fadeIn 0.35s ease forwards; }
      .case-item { transition: background 0.12s; }
      .case-item:hover { background: ${darkMode ? "#0f1218" : "#e8eef8"} !important; }
      input:focus, textarea:focus, select:focus { border-color: ${t.accent} !important; }
    `}</style>
  );
}

// ── StatusBadge ───────────────────────────────────────────────────────────────
function StatusBadge({ status, t, size = "normal" }) {
  const closed  = status === "uzavřený";
  const fs      = size === "small" ? "0.52rem" : "0.54rem";
  return (
    <span style={{ padding: "1px 7px", fontSize: fs, fontWeight: 600, background: closed ? t.doneStatusBg : t.openStatusBg, color: closed ? t.doneStatusColor : t.openStatusColor, border: `1px solid ${closed ? t.doneStatusBorder : t.openStatusBorder}`, borderRadius: 2, whiteSpace: "nowrap" }}>
      {closed ? "✓ UZAVŘENÝ" : "● ROZPRACOVANÝ"}
    </span>
  );
}

// ── Modální overlay ───────────────────────────────────────────────────────────
function Modal({ onClose, children, width = 480 }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width, maxWidth: "92vw" }}>
        {children}
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [darkMode, setDarkMode] = useState(true);
  const t = darkMode ? DARK : LIGHT;

  // Inicializace
  const [appReady,     setAppReady]     = useState(false);
  const [hasApiKey,    setHasApiKey]    = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // Data
  const [cases,      setCases]      = useState([]);
  const [activeId,   setActiveId]   = useState(null);
  const [view,       setView]       = useState("welcome"); // "welcome" | "new" | "session"

  // UI
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState(null);
  const [closeModal, setCloseModal] = useState(false);
  const [resolution, setResolution] = useState("");
  const [deleteId,   setDeleteId]   = useState(null);
  const [newVehicle, setNewVehicle] = useState(EMPTY_VEHICLE);

  const chatEndRef = useRef(null);

  // Ref umožňuje čtení aktuálního stavu uvnitř async funkcí bez stale closure
  const casesRef = useRef(cases);
  useEffect(() => { casesRef.current = cases; }, [cases]);

  const activeCase  = cases.find((c) => c.id === activeId) ?? null;
  const closedCount = cases.filter((c) => c.status === "uzavřený").length;
  const diagCount   = activeCase?.messages.filter((m) => m.type === "diagnosis").length ?? 0;

  // ── Init ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const [apiKey, saved] = await Promise.all([
        window.electronAPI.apiKey.get(),
        store.get(SESSIONS_KEY),
      ]);
      setHasApiKey(!!apiKey);
      if (saved) {
        try { setCases(JSON.parse(saved)); } catch (_) {}
      }
      setAppReady(true);
    })();
  }, []);

  // Auto-scroll
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeCase?.messages?.length, loading]);

  // ── Persistence ─────────────────────────────────────────────────────────────
  const saveCases = useCallback((list) => {
    store.set(SESSIONS_KEY, JSON.stringify(list));
  }, []);

  const updateCases = useCallback((updater) => {
    setCases((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      saveCases(next);
      return next;
    });
  }, [saveCases]);

  const updateCase = useCallback((id, fn) => {
    updateCases((prev) => prev.map((c) => c.id === id ? { ...c, ...fn(c) } : c));
  }, [updateCases]);

  // ── Akce ────────────────────────────────────────────────────────────────────
  const createCase = useCallback((vehicle) => {
    const id   = uid();
    const name = vehicle.model
      ? vehicle.model.split(" ").slice(0, 3).join(" ") + (vehicle.mileage ? ` · ${fmtMileage(vehicle.mileage)}` : "")
      : "Nový případ";

    updateCases((prev) => [{
      id, name,
      status:    "rozpracovaný",
      createdAt: new Date().toISOString(),
      closedAt:  null,
      vehicle,
      messages:  [],
      resolution: null,
    }, ...prev]);

    setActiveId(id);
    setView("session");
    return id;
  }, [updateCases]);

  const runDiag = useCallback(async (caseId, inputData) => {
    setLoading(true);
    setError(null);

    const inputMsg = { id: uid(), type: "input", ...inputData, timestamp: new Date().toISOString() };

    // Okamžitě přidáme vstup do UI
    updateCase(caseId, (c) => ({ messages: [...c.messages, inputMsg] }));

    // Čteme ze ref — vždy aktuální stav, i když setCases ještě neproběhlo
    const current   = casesRef.current.find((c) => c.id === caseId) ?? {};
    const vehicle   = current.vehicle ?? {};
    const prevMsgs  = (current.messages ?? []).filter((m) => m.type === "input");
    const allInputs = [...prevMsgs, inputMsg];

    const allSymptoms = [...new Set(allInputs.flatMap((m) => m.symptoms ?? []))];
    const allObdCodes = [...new Set(allInputs.flatMap((m) => m.obdCodes ?? []))];
    const allTexts    = allInputs.map((m) => m.text).filter(Boolean);

    const similar = findSimilar(casesRef.current, {
      vehicle, symptoms: allSymptoms, obdCodes: allObdCodes, text: allTexts.join(" "),
    });

    const userPrompt = [
      (vehicle.brand || vehicle.model) && `Vozidlo: ${[vehicle.brand, vehicle.model].filter(Boolean).join(" ")}`,
      vehicle.mileage                  && `Nájezd: ${vehicle.mileage} km`,
      allSymptoms.length               && `Příznaky: ${allSymptoms.join(", ")}`,
      allObdCodes.length               && `OBD kódy: ${allObdCodes.join(", ")}`,
      ...allTexts.map((tx, i) => `Popis mechanika${allTexts.length > 1 ? ` ${i + 1}` : ""}:\n${tx}`),
    ].filter(Boolean).join("\n");

    try {
      const data   = await window.electronAPI.callClaude({ systemPrompt: buildSystemPrompt(similar), userMessage: userPrompt, maxTokens: 4000 });
      const raw    = data.content.map((b) => b.text ?? "").join("");
      const parsed = smartRepair(raw);

      if (!parsed)                throw new Error("AI nevrátilo čitelný výsledek. Zkuste přidat více příznaků.");
      if (!parsed.závady?.length) throw new Error("Nebyly nalezeny odpovídající závady.");

      const diagMsg = { id: uid(), type: "diagnosis", result: parsed, ragMatchIds: similar.map((s) => s.id), timestamp: new Date().toISOString() };

      updateCase(caseId, (c) => {
        const isFirst = c.messages.filter((m) => m.type === "diagnosis").length === 0;
        const newName = isFirst && parsed.závady[0]
          ? `${vehicle.model ? vehicle.model.split(" ").slice(0, 3).join(" ") : "Transit"} | ${parsed.závady[0].název}`
          : c.name;
        return { messages: [...c.messages, diagMsg], name: newName };
      });
    } catch (e) {
      setError("Chyba: " + e.message);
      // Odstraníme vstupní zprávu, pokud diagnostika selhala
      updateCase(caseId, (c) => ({ messages: c.messages.filter((m) => m.id !== inputMsg.id) }));
    } finally {
      setLoading(false);
    }
  }, [updateCase]);

  // Vytvoří případ a hned spustí diagnostiku — žádný setTimeout hack
  const handleNewCase = useCallback((inputData) => {
    const id = createCase(newVehicle);
    runDiag(id, inputData);
    setNewVehicle(EMPTY_VEHICLE);
  }, [createCase, runDiag, newVehicle]);

  const closeCase = useCallback(() => {
    if (!resolution.trim()) return;
    updateCase(activeId, () => ({ status: "uzavřený", closedAt: new Date().toISOString(), resolution: resolution.trim() }));
    setCloseModal(false);
    setResolution("");
  }, [activeId, resolution, updateCase]);

  const deleteCase = useCallback((id) => {
    updateCases((prev) => prev.filter((c) => c.id !== id));
    if (activeId === id) { setActiveId(null); setView("welcome"); }
    setDeleteId(null);
  }, [activeId, updateCases]);

  const openCase = useCallback((id) => {
    setActiveId(id);
    setView("session");
    setError(null);
  }, []);

  // ── Stavy před hlavním renderem ──────────────────────────────────────────────
  if (!appReady) {
    return (
      <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: DARK.bg, color: DARK.textFaint, fontFamily: "'IBM Plex Mono',monospace", fontSize: "0.8rem", letterSpacing: "0.1em" }}>
        Načítám...
      </div>
    );
  }

  if (!hasApiKey) {
    return <ApiKeyScreen t={t} onSaved={() => setHasApiKey(true)} />;
  }

  // ── Hlavní render ────────────────────────────────────────────────────────────
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: t.bg, color: t.text, fontFamily: "'IBM Plex Mono','Courier New',monospace", overflow: "hidden", transition: "background 0.2s, color 0.2s" }}>
      <GlobalStyles t={t} darkMode={darkMode} />

      {/* ── HEADER ── */}
      <header style={{ background: t.bgHeader, borderBottom: `2px solid ${t.accent}`, padding: "10px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, boxShadow: darkMode ? "none" : "0 1px 8px rgba(0,0,0,0.07)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 34, height: 34, background: t.accent, display: "flex", alignItems: "center", justifyContent: "center", clipPath: "polygon(10% 0%,90% 0%,100% 10%,100% 90%,90% 100%,10% 100%,0% 90%,0% 10%)" }}>
            <span style={{ fontSize: "17px" }}>🔧</span>
          </div>
          <div>
            <div style={{ fontFamily: "'Barlow Condensed',sans-serif", fontSize: "1.6rem", fontWeight: 800, color: t.text, letterSpacing: "0.05em", lineHeight: 1 }}>
              GEAR<span style={{ color: t.accent }}>Brain</span>
            </div>
            <div style={{ fontSize: "0.52rem", color: t.textFaint, letterSpacing: "0.12em" }}>AI DIAGNOSTIKA · FORD TRANSIT EU</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: "0.6rem", color: t.textFaint }}>
            {cases.length} případů &nbsp;·&nbsp; <span style={{ color: t.doneStatusColor }}>{closedCount} v databázi</span>
          </span>
          <button onClick={() => setDarkMode((d) => !d)}
            style={{ display: "flex", alignItems: "center", gap: 5, background: t.bgCard, border: `1px solid ${t.border}`, color: t.textMuted, padding: "5px 10px", fontSize: "0.65rem", fontFamily: "inherit", cursor: "pointer", borderRadius: 20 }}>
            {darkMode ? "☀️" : "🌙"} {darkMode ? "Světlý" : "Tmavý"}
          </button>
          <button onClick={() => setShowSettings(true)}
            style={{ background: t.bgCard, border: `1px solid ${t.border}`, color: t.textMuted, padding: "5px 10px", fontSize: "0.75rem", cursor: "pointer", borderRadius: 20, fontFamily: "inherit" }}>
            ⚙️ Nastavení
          </button>
          <span style={{ fontSize: "0.65rem", color: t.doneStatusColor }}>● Aktivní</span>
        </div>
      </header>

      {/* ── BODY ── */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

        {/* SIDEBAR */}
        <aside style={{ width: 256, borderRight: `1px solid ${t.border}`, display: "flex", flexDirection: "column", flexShrink: 0, background: t.bgSidebar }}>
          <div style={{ padding: "10px 12px", borderBottom: `1px solid ${t.border}` }}>
            <button onClick={() => { setView("new"); setActiveId(null); setError(null); }}
              style={{ width: "100%", background: t.accent, color: "#fff", border: "none", cursor: "pointer", padding: "10px", fontSize: "0.72rem", letterSpacing: "0.12em", fontWeight: 700, fontFamily: "inherit", borderRadius: 2, clipPath: "polygon(5px 0%,100% 0%,calc(100% - 5px) 100%,0% 100%)" }}>
              + NOVÝ PŘÍPAD
            </button>
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: "6px 0" }}>
            {cases.length === 0 && (
              <div style={{ padding: "24px 12px", textAlign: "center", color: t.textVeryFaint, fontSize: "0.65rem", lineHeight: 1.8 }}>
                Žádné případy.<br />Klikněte na NOVÝ PŘÍPAD.
              </div>
            )}
            {cases.map((c) => (
              <div key={c.id} className="case-item" onClick={() => openCase(c.id)}
                style={{ padding: "9px 12px", borderLeft: `3px solid ${activeId === c.id ? t.accent : "transparent"}`, background: activeId === c.id ? t.bgSelected : "transparent", borderBottom: `1px solid ${t.border}`, cursor: "pointer", userSelect: "none" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 5 }}>
                  <div style={{ fontSize: "0.65rem", color: activeId === c.id ? t.text : t.textLabel, flex: 1, overflow: "hidden" }}>
                    <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: activeId === c.id ? 600 : 400, lineHeight: 1.4 }}>{c.name}</div>
                    <div style={{ fontSize: "0.54rem", color: t.textVeryFaint, marginTop: 2 }}>{fmtDate(c.createdAt)}</div>
                  </div>
                  <StatusBadge status={c.status} t={t} size="small" />
                </div>
                {c.vehicle?.model && (
                  <div style={{ fontSize: "0.54rem", color: t.textVeryFaint, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {c.vehicle.model}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div style={{ padding: "8px 12px", borderTop: `1px solid ${t.border}`, fontSize: "0.57rem", color: t.textVeryFaint }}>
            {closedCount > 0 ? `Databáze: ${closedCount} uzavřených případů` : "Databáze: žádné uzavřené případy"}
          </div>
        </aside>

        {/* MAIN */}
        <main style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>

          {/* View: Welcome */}
          {view === "welcome" && (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 14 }}>
              <div style={{ fontSize: "2.5rem", opacity: 0.08 }}>🔧</div>
              <div style={{ fontSize: "0.68rem", color: t.textFaint, letterSpacing: "0.12em", textAlign: "center", lineHeight: 1.8 }}>
                Vyberte případ ze seznamu vlevo<br />nebo vytvořte novou diagnostiku
              </div>
              <button onClick={() => setView("new")}
                style={{ background: t.accent, color: "#fff", border: "none", cursor: "pointer", padding: "10px 28px", fontSize: "0.72rem", letterSpacing: "0.12em", fontFamily: "inherit", fontWeight: 700, borderRadius: 2, marginTop: 6 }}>
                + NOVÝ PŘÍPAD
              </button>
            </div>
          )}

          {/* View: Nový případ */}
          {view === "new" && (
            <div style={{ flex: 1, overflowY: "auto", padding: "20px", background: t.bg }}>
              <div style={{ maxWidth: 680, margin: "0 auto" }}>
                <div style={{ marginBottom: 18 }}>
                  <div style={{ fontFamily: "'Barlow Condensed',sans-serif", fontSize: "1.35rem", fontWeight: 700, color: t.accent, letterSpacing: "0.05em", marginBottom: 3 }}>NOVÝ DIAGNOSTICKÝ PŘÍPAD</div>
                  <div style={{ fontSize: "0.63rem", color: t.textFaint, letterSpacing: "0.08em" }}>Zadejte informace o vozidle a první příznaky závady</div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
                  <div>
                    <div style={{ fontSize: "0.6rem", color: t.textFaint, letterSpacing: "0.1em", marginBottom: 5 }}>MODEL VOZIDLA</div>
                    <select
                      value={newVehicle.model}
                      onChange={(e) => {
                        const item = VEHICLE_MODELS.find((m) => m.label === e.target.value);
                        if (item?.label) setNewVehicle((v) => ({ ...v, model: item.label }));
                      }}
                      style={{ width: "100%", background: t.bgInput, border: `1px solid ${t.borderInput}`, color: t.text, padding: "8px 10px", fontSize: "0.75rem", fontFamily: "inherit", borderRadius: 2, outline: "none" }}>
                      <option value="">— Vyberte model —</option>
                      {VEHICLE_MODELS.map((item, i) =>
                        item.group
                          ? <option key={i} disabled style={{ fontWeight: 600 }}>── {item.group} ──</option>
                          : <option key={i} value={item.label}>{item.label}</option>
                      )}
                    </select>
                  </div>
                  <div>
                    <div style={{ fontSize: "0.6rem", color: t.textFaint, letterSpacing: "0.1em", marginBottom: 5 }}>NÁJEZD (KM)</div>
                    <input type="number" placeholder="185000" value={newVehicle.mileage}
                      onChange={(e) => setNewVehicle((v) => ({ ...v, mileage: e.target.value }))}
                      style={{ width: "100%", background: t.bgInput, border: `1px solid ${t.borderInput}`, color: t.text, padding: "8px 10px", fontSize: "0.75rem", fontFamily: "inherit", borderRadius: 2, outline: "none" }} />
                  </div>
                </div>

                {error && (
                  <div style={{ marginBottom: 12, padding: "9px 12px", background: "rgba(220,38,38,0.08)", border: "1px solid #dc2626", color: "#dc2626", fontSize: "0.78rem", borderRadius: 2 }}>
                    ⚠ {error}
                  </div>
                )}
                <InputForm onSubmit={handleNewCase} loading={loading} label="ZAHÁJIT DIAGNOSTIKU" t={t} />
              </div>
            </div>
          )}

          {/* View: Aktivní případ */}
          {view === "session" && activeCase && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

              {/* Case header */}
              <div style={{ padding: "10px 18px", background: t.bgHeader, borderBottom: `1px solid ${t.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
                <div>
                  <div style={{ fontSize: "0.82rem", color: t.text, fontWeight: 600, lineHeight: 1.3 }}>{activeCase.name}</div>
                  <div style={{ display: "flex", gap: 8, marginTop: 2, alignItems: "center", flexWrap: "wrap" }}>
                    {activeCase.vehicle?.model    && <span style={{ fontSize: "0.58rem", color: t.textFaint }}>{activeCase.vehicle.model}</span>}
                    {activeCase.vehicle?.mileage  && <span style={{ fontSize: "0.58rem", color: t.textVeryFaint }}>· {fmtMileage(activeCase.vehicle.mileage)}</span>}
                    <StatusBadge status={activeCase.status} t={t} />
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  {activeCase.status === "rozpracovaný" && (
                    <button onClick={() => setCloseModal(true)}
                      style={{ background: t.doneStatusBg, border: `1px solid ${t.doneStatusBorder}`, color: t.doneStatusColor, padding: "5px 12px", fontSize: "0.68rem", letterSpacing: "0.08em", cursor: "pointer", fontFamily: "inherit", borderRadius: 2 }}>
                      ✓ UZAVŘÍT
                    </button>
                  )}
                  <button onClick={() => setDeleteId(activeCase.id)}
                    style={{ background: "rgba(220,38,38,0.07)", border: "1px solid rgba(220,38,38,0.3)", color: "#dc2626", padding: "5px 12px", fontSize: "0.68rem", letterSpacing: "0.08em", cursor: "pointer", fontFamily: "inherit", borderRadius: 2 }}>
                    ✕ SMAZAT
                  </button>
                </div>
              </div>

              {/* Messages */}
              <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px", background: t.bg }}>
                <div style={{ maxWidth: 720, margin: "0 auto" }}>

                  {activeCase.messages.length === 0 && !loading && (
                    <div style={{ textAlign: "center", color: t.textVeryFaint, fontSize: "0.68rem", letterSpacing: "0.1em", padding: "32px 0" }}>
                      Případ připraven — zadejte příznaky níže a spusťte diagnostiku
                    </div>
                  )}

                  {activeCase.messages.map((msg, idx) => {
                    if (msg.type === "input") {
                      const roundNo = activeCase.messages.slice(0, idx + 1).filter((m) => m.type === "input").length;
                      return (
                        <div key={msg.id} style={{ marginBottom: 10, padding: "10px 14px", background: t.inputBg, border: `1px solid ${t.inputBorder}`, borderLeft: `3px solid ${t.inputAccent}`, borderRadius: 2 }}>
                          <div style={{ fontSize: "0.58rem", color: t.inputAccent, letterSpacing: "0.12em", marginBottom: 6 }}>
                            Vstup #{roundNo} · {fmtDate(msg.timestamp)}
                          </div>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                            {(msg.symptoms ?? []).map((s) => (
                              <span key={s} style={{ padding: "2px 7px", background: t.sympBg, border: `1px solid ${t.sympBorder}`, color: t.sympText, fontSize: "0.72rem", borderRadius: 2 }}>{s}</span>
                            ))}
                            {(msg.obdCodes ?? []).map((c) => (
                              <span key={c} style={{ padding: "2px 7px", background: t.obdBg, border: `1px solid ${t.obdBorder}`, color: t.obdText, fontSize: "0.72rem", fontFamily: "monospace", borderRadius: 2 }}>{c}</span>
                            ))}
                            {msg.text && (
                              <div style={{ width: "100%", fontSize: "0.78rem", color: t.textMuted, marginTop: 4, fontStyle: "italic" }}>"{msg.text}"</div>
                            )}
                          </div>
                        </div>
                      );
                    }

                    if (msg.type === "diagnosis") {
                      const ragSessions = cases.filter((c) => (msg.ragMatchIds ?? []).includes(c.id));
                      return (
                        <div key={msg.id} style={{ marginBottom: 16 }}>
                          <DiagCard result={msg.result} ragMatches={ragSessions} t={t} />
                        </div>
                      );
                    }

                    return null;
                  })}

                  {loading && (
                    <div style={{ padding: "18px", textAlign: "center", background: t.bgMuted, border: `1px solid ${t.border}`, marginBottom: 12, borderRadius: 2 }}>
                      <div style={{ animation: "pulse 1.5s ease infinite", fontSize: "0.7rem", color: t.accent, letterSpacing: "0.18em" }}>◈ AI DIAGNOSTIKA PROBÍHÁ ◈</div>
                      <div style={{ fontSize: "0.6rem", color: t.textVeryFaint, marginTop: 5 }}>Prohledávám databázi servisu · Analyzuji příznaky...</div>
                    </div>
                  )}

                  {error && (
                    <div style={{ padding: "9px 12px", background: "rgba(220,38,38,0.08)", border: "1px solid #dc2626", color: "#dc2626", fontSize: "0.78rem", marginBottom: 12, borderRadius: 2 }}>
                      ⚠ {error}
                    </div>
                  )}

                  {activeCase.status === "uzavřený" && activeCase.resolution && (
                    <div style={{ padding: "12px 14px", background: t.closedBg, border: `1px solid ${t.closedBorder}`, borderLeft: `4px solid ${t.doneStatusColor}`, marginTop: 6, borderRadius: 2 }}>
                      <div style={{ fontSize: "0.58rem", color: t.doneStatusColor, letterSpacing: "0.12em", marginBottom: 5 }}>
                        ✓ PŘÍPAD UZAVŘEN · {activeCase.closedAt ? fmtDate(activeCase.closedAt) : ""}
                      </div>
                      <div style={{ fontSize: "0.82rem", color: t.doneStatusColor, lineHeight: 1.6 }}>{activeCase.resolution}</div>
                    </div>
                  )}

                  <div ref={chatEndRef} />
                </div>
              </div>

              {/* Follow-up input */}
              {activeCase.status === "rozpracovaný" && (
                <div style={{ borderTop: `1px solid ${t.border}`, padding: "14px 20px", background: t.bgFollowup, flexShrink: 0 }}>
                  <div style={{ maxWidth: 720, margin: "0 auto" }}>
                    <div style={{ fontSize: "0.6rem", color: t.textVeryFaint, letterSpacing: "0.1em", marginBottom: 8 }}>
                      {diagCount === 0 ? "PRVNÍ DIAGNOSTIKA" : "DOPLNIT INFORMACE — přidejte nové příznaky zjištěné diagnostikou"}
                    </div>
                    <InputForm
                      onSubmit={(d) => runDiag(activeId, d)}
                      loading={loading}
                      label={diagCount === 0 ? "SPUSTIT DIAGNOSTIKU" : "UPŘESNIT DIAGNOSTIKU"}
                      t={t}
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </main>
      </div>

      {/* ── OVERLAY: Nastavení ── */}
      {showSettings && (
        <SettingsPanel t={t} onClose={() => setShowSettings(false)} onKeyDeleted={() => { setShowSettings(false); setHasApiKey(false); }} />
      )}

      {/* ── MODAL: Uzavřít případ ── */}
      {closeModal && (
        <Modal onClose={() => setCloseModal(false)} width={480}>
          <div style={{ background: t.bgModal, border: `1px solid ${t.border}`, borderRadius: 4, padding: "24px", boxShadow: "0 20px 60px rgba(0,0,0,0.35)" }}>
            <div style={{ fontFamily: "'Barlow Condensed',sans-serif", fontSize: "1.3rem", fontWeight: 700, color: t.doneStatusColor, marginBottom: 5 }}>✓ UZAVŘÍT PŘÍPAD</div>
            <p style={{ fontSize: "0.78rem", color: t.textMuted, marginBottom: 14, lineHeight: 1.7 }}>
              Popište provedenou opravu. Tato informace bude uložena do databáze a pomůže při budoucích diagnostikách podobných závad.
            </p>
            <div style={{ fontSize: "0.6rem", color: t.textFaint, letterSpacing: "0.1em", marginBottom: 5 }}>PROVEDENÁ OPRAVA *</div>
            <textarea value={resolution} onChange={(e) => setResolution(e.target.value)} autoFocus rows={5}
              placeholder="např. Vyměněn EGR ventil + EGR chladič. Po vyčištění sání a regeneraci DPF vozidlo jede bez závad. Kód P0401 vymazán, nevrátil se."
              style={{ width: "100%", background: t.bgInput, border: `1px solid ${t.borderInput}`, color: t.text, padding: "9px 11px", fontSize: "0.82rem", lineHeight: 1.7, marginBottom: 14, fontFamily: "'IBM Plex Mono',monospace", resize: "vertical", outline: "none", borderRadius: 2 }} />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setCloseModal(false)}
                style={{ background: "transparent", border: `1px solid ${t.border}`, color: t.textFaint, padding: "7px 18px", fontSize: "0.75rem", cursor: "pointer", fontFamily: "inherit", borderRadius: 2 }}>
                Zrušit
              </button>
              <button disabled={!resolution.trim()} onClick={closeCase}
                style={{ background: resolution.trim() ? t.doneStatusColor : "transparent", color: resolution.trim() ? "#fff" : t.textVeryFaint, border: `1px solid ${resolution.trim() ? t.doneStatusColor : t.border}`, padding: "7px 22px", fontSize: "0.75rem", fontWeight: 700, cursor: resolution.trim() ? "pointer" : "not-allowed", fontFamily: "inherit", borderRadius: 2 }}>
                ✓ Potvrdit
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── MODAL: Smazat případ ── */}
      {deleteId && (
        <Modal onClose={() => setDeleteId(null)} width={360}>
          <div style={{ background: t.bgModal, border: `1px solid ${t.border}`, borderRadius: 4, padding: "24px", boxShadow: "0 20px 60px rgba(0,0,0,0.35)" }}>
            <div style={{ fontFamily: "'Barlow Condensed',sans-serif", fontSize: "1.2rem", fontWeight: 700, color: "#dc2626", marginBottom: 8 }}>SMAZAT PŘÍPAD</div>
            <p style={{ fontSize: "0.8rem", color: t.textMuted, marginBottom: 16, lineHeight: 1.6 }}>
              Opravdu smazat tento případ? Akce je nevratná.
              {cases.find((c) => c.id === deleteId)?.status === "uzavřený" && (
                <span style={{ display: "block", color: "#d97706", marginTop: 8, fontSize: "0.75rem" }}>
                  ⚠ Případ je uzavřen a je součástí databáze servisu.
                </span>
              )}
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setDeleteId(null)}
                style={{ background: "transparent", border: `1px solid ${t.border}`, color: t.textFaint, padding: "7px 18px", fontSize: "0.75rem", cursor: "pointer", fontFamily: "inherit", borderRadius: 2 }}>
                Zrušit
              </button>
              <button onClick={() => deleteCase(deleteId)}
                style={{ background: "rgba(220,38,38,0.1)", border: "1px solid #dc2626", color: "#dc2626", padding: "7px 18px", fontSize: "0.75rem", cursor: "pointer", fontFamily: "inherit", borderRadius: 2 }}>
                ✕ Smazat
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
