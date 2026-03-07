import { useState, useRef, useEffect, useCallback } from "react";

import { DARK, LIGHT }                      from "./theme.js";
import { VEHICLE_MODELS, EMPTY_VEHICLE }    from "./constants/index.js";
import { uid, fmtDate, fmtMileage }         from "./lib/utils.js";
import { smartRepair, buildSystemPrompt, checkTopicRelevance, CASE_TOKEN_LIMIT } from "./lib/ai.js";
import DiagCard                             from "./components/DiagCard.jsx";
import InputForm, { FollowUpPrompt }        from "./components/InputForm.jsx";
import { ApiKeyScreen, SettingsPanel, ConsentScreen } from "./components/Auth.jsx";

// ── Storage wrapper ───────────────────────────────────────────────────────────
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
      html { font-size: 17px; }
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
function StatusBadge({ status, t }) {
  const closed = status === "uzavřený";
  return (
    <span style={{ padding: "2px 8px", fontSize: "0.65rem", fontWeight: 600, background: closed ? t.doneStatusBg : t.openStatusBg, color: closed ? t.doneStatusColor : t.openStatusColor, border: `1px solid ${closed ? t.doneStatusBorder : t.openStatusBorder}`, borderRadius: 2, whiteSpace: "nowrap" }}>
      {closed ? "✓ UZAVŘENÝ" : "● AKTIVNÍ"}
    </span>
  );
}

// ── Modal overlay ─────────────────────────────────────────────────────────────
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

  const [appReady,     setAppReady]     = useState(false);
  const [hasApiKey,    setHasApiKey]    = useState(false);
  const [hasConsent,   setHasConsent]   = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const [cases,      setCases]      = useState([]);
  const [activeId,   setActiveId]   = useState(null);
  const [view,       setView]       = useState("welcome");

  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState(null);
  const [closeModal, setCloseModal] = useState(false);
  const [resolution, setResolution] = useState("");
  const [closeError,  setCloseError]  = useState(null);
  const [deleteId,   setDeleteId]   = useState(null);
  const [newVehicle, setNewVehicle] = useState(EMPTY_VEHICLE);

  const [installationId,  setInstallationId]   = useState("");         // UUID této instalace
  const [cloudStatus,     setCloudStatus]      = useState("idle");   // "idle"|"ok"|"error" — stav posledního RAG dotazu

  // ── Auto-updater ──────────────────────────────────────────────────────────────
  const [updateInfo,     setUpdateInfo]     = useState(null);   // { version, releaseDate }
  const [updatePhase,    setUpdatePhase]    = useState("idle"); // idle|available|downloading|ready
  const [updateProgress, setUpdateProgress] = useState(0);      // 0–100

  const chatEndRef = useRef(null);
  const casesRef   = useRef(cases);
  useEffect(() => { casesRef.current = cases; }, [cases]);

  const activeCase  = cases.find((c) => c.id === activeId) ?? null;
  const closedCount = cases.filter((c) => c.status === "uzavřený").length;
  const diagCount   = activeCase?.messages.filter((m) => m.type === "diagnosis").length ?? 0;

  // ── Init ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const [apiKey, saved, consent] = await Promise.all([
        window.electronAPI.apiKey.get(),
        store.get(SESSIONS_KEY),
        store.get("gearbrain_consent"),
      ]);
      setHasApiKey(!!apiKey);
      setHasConsent(!!consent);
      if (saved) { try { setCases(JSON.parse(saved)); } catch (_) {} }
      const cfg = await window.electronAPI.cloud.configGet();
      if (cfg.installationId) setInstallationId(cfg.installationId);

      // Cloud je nakonfigurovaný → zobrazíme ok ihned
      // (testConnection volá REST endpoint který má zakázaný anon SELECT)
      // Reálný stav se ověří při první diagnostice přes Edge Function
      if (cfg.enabled) setCloudStatus('ok');

      setAppReady(true);

      // Posloucháme události auto-updateru
      window.electronAPI.updater.onAvailable((info) => {
        setUpdateInfo(info);
        setUpdatePhase("available");
      });
      window.electronAPI.updater.onProgress(({ percent }) => {
        setUpdateProgress(percent);
        setUpdatePhase("downloading");
      });
      window.electronAPI.updater.onDownloaded(() => {
        setUpdateProgress(100);
        setUpdatePhase("ready");
      });
      window.electronAPI.updater.onError((msg) => {
        setUpdatePhase("idle");
        setError("Chyba aktualizace: " + msg);
      });
    })();
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeCase?.messages?.length, loading]);

  // ── Persistence ─────────────────────────────────────────────────────────────
  const saveCases = useCallback((list) => store.set(SESSIONS_KEY, JSON.stringify(list)), []);

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
    updateCases((prev) => [{ id, name, status: "rozpracovaný", createdAt: new Date().toISOString(), closedAt: null, vehicle, messages: [], resolution: null, tokenCount: 0 }, ...prev]);
    setActiveId(id);
    setView("session");
    return id;
  }, [updateCases]);

  const runDiag = useCallback(async (caseId, inputData) => {
    setLoading(true);
    setError(null);

    const inputMsg = { id: uid(), type: "input", ...inputData, timestamp: new Date().toISOString() };
    updateCase(caseId, (c) => ({ messages: [...c.messages, inputMsg] }));

    const current    = casesRef.current.find((c) => c.id === caseId) ?? {};
    const vehicle    = current.vehicle ?? {};
    const prevInputs = (current.messages ?? []).filter((m) => m.type === "input");
    const allInputs  = [...prevInputs, inputMsg];

    const allSymptoms = [...new Set(allInputs.flatMap((m) => m.symptoms ?? []))];
    const allObdCodes = [...new Set(allInputs.flatMap((m) => m.obdCodes ?? []))];
    const allTexts    = allInputs.map((m) => m.text).filter(Boolean);

    const ragInput = { vehicle, symptoms: allSymptoms, obdCodes: allObdCodes, text: allTexts.join(" ") };

    const userPrompt = [
      (vehicle.brand || vehicle.model) && `Vozidlo: ${[vehicle.brand, vehicle.model].filter(Boolean).join(" ")}`,
      vehicle.mileage                  && `Nájezd: ${vehicle.mileage} km`,
      allSymptoms.length               && `Příznaky: ${allSymptoms.join(", ")}`,
      allObdCodes.length               && `OBD kódy: ${allObdCodes.join(", ")}`,
      ...allTexts.map((tx, i) => `Popis mechanika${allTexts.length > 1 ? ` ${i + 1}` : ""}:\n${tx}`),
    ].filter(Boolean).join("\n");

    // Kontrola limitu tokenů pro tento případ
    const currentTokens = current.tokenCount ?? 0;
    if (currentTokens >= CASE_TOKEN_LIMIT) {
      setError(`Případ dosáhl limitu ${CASE_TOKEN_LIMIT.toLocaleString()} tokenů. Uzavřete případ a výsledky shrňte do poznámky.`);
      updateCase(caseId, (c) => ({ messages: c.messages.filter((m) => m.id !== inputMsg.id) }));
      setLoading(false);
      return;
    }

    // Off-topic kontrola volného textu (příznaky a OBD kódy jsou vždy relevantní)
    const freeText = inputData.text?.trim() ?? "";
    if (freeText && !inputData.symptoms?.length && !inputData.obdCodes?.length) {
      const topicCheck = checkTopicRelevance(freeText);
      if (!topicCheck.ok) {
        setError(topicCheck.reason);
        updateCase(caseId, (c) => ({ messages: c.messages.filter((m) => m.id !== inputMsg.id) }));
        setLoading(false);
        return;
      }
    }

    // RAG + Claude API běží paralelně — RAG výsledky se vloží do promptu jakmile jsou k dispozici
    let similar = [];
    const ragPromise = window.electronAPI.cloud.searchCases(ragInput, installationId)
      .then(({ cases }) => { similar = cases ?? []; setCloudStatus("ok"); })
      .catch(() => { setCloudStatus("error"); });

    try {
      // Počkáme na RAG (většinou doběhne dřív než bychom promptem sestavili)
      await ragPromise;
      const data   = await window.electronAPI.callClaude({ systemPrompt: buildSystemPrompt(similar, vehicle), userMessage: userPrompt, maxTokens: 4000 });
      const raw    = data.content.map((b) => b.text ?? "").join("");
      const parsed = smartRepair(raw);

      if (!parsed)                throw new Error("AI nevrátilo čitelný výsledek. Zkuste přidat více příznaků.");
      if (!parsed.závady?.length) throw new Error("Nebyly nalezeny odpovídající závady.");

      // Přičíst tokeny z API odpovědi (Anthropic vrací přesné hodnoty)
      const usedTokens = (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0);

      const diagMsg = { id: uid(), type: "diagnosis", result: parsed, ragMatchIds: similar.map((s) => s.id), tokensUsed: usedTokens, timestamp: new Date().toISOString() };

      updateCase(caseId, (c) => {
        const isFirst = c.messages.filter((m) => m.type === "diagnosis").length === 0;
        const newName = isFirst && parsed.závady[0]
          ? `${vehicle.model?.split(" ").slice(0, 3).join(" ") || vehicle.brand || "Vozidlo"} | ${parsed.závady[0].název}`
          : c.name;
        return {
          messages: [...c.messages, diagMsg],
          name: newName,
          tokenCount: (c.tokenCount ?? 0) + usedTokens,
        };
      });
    } catch (e) {
      setError("Chyba: " + e.message);
      updateCase(caseId, (c) => ({ messages: c.messages.filter((m) => m.id !== inputMsg.id) }));
    } finally {
      setLoading(false);
    }
  }, [updateCase, installationId]);

  const handleNewCase = useCallback((inputData) => {
    const id = createCase(newVehicle);
    runDiag(id, inputData);
    setNewVehicle(EMPTY_VEHICLE);
  }, [createCase, runDiag, newVehicle]);

  const closeCase = useCallback(() => {
    if (!resolution.trim()) return;
    const resText     = resolution.trim();
    const currentCase = casesRef.current.find((c) => c.id === activeId);

    // Validace přímo v UI — uživatel vidí chybu okamžitě, žádné tiché blokování
    if (resText.length < 10) {
      setCloseError(`Popis opravy je příliš krátký (${resText.length} znaků, minimum 10).`);
      return;
    }
    if (resText.length > 200) {
      setCloseError(`Popis opravy je příliš dlouhý (${resText.length} znaků, maximum 200).`);
      return;
    }
    if (/(.)\1{6,}/.test(resText)) {
      setCloseError("Popis opravy obsahuje opakující se znaky.");
      return;
    }
    const uniqueWords = new Set(resText.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    if (uniqueWords.size < 2) {
      setCloseError("Popis opravy je příliš stručný — přidejte alespoň 2 různá slova.");
      return;
    }

    const closedAt = new Date().toISOString();
    updateCase(activeId, () => ({ status: "uzavřený", closedAt, resolution: resText }));

    if (currentCase) {
      const fullCase = { ...currentCase, status: "uzavřený", closedAt, resolution: resText };
      window.electronAPI.cloud.push(fullCase)
        .then((result) => {
          if (!result.ok) console.warn('[cloud push]', result.error);
        })
        .catch((e) => console.warn('[cloud push]', e.message));
    }

    setCloseModal(false);
    setCloseError(null);
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

  // ── Loading / API Key screens ────────────────────────────────────────────────
  if (!appReady) {
    return (
      <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: DARK.bg, color: DARK.textFaint, fontFamily: "'IBM Plex Mono',monospace", fontSize: "0.85rem", letterSpacing: "0.1em" }}>
        Načítám...
      </div>
    );
  }

  if (!hasConsent) {
    return <ConsentScreen t={DARK} onAccept={() => {
      store.set("gearbrain_consent", new Date().toISOString());
      setHasConsent(true);
    }} />;
  }

  if (!hasApiKey) return <ApiKeyScreen t={t} onSaved={() => setHasApiKey(true)} />;

  // ── Hlavní render ────────────────────────────────────────────────────────────
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: t.bg, color: t.text, fontFamily: "'IBM Plex Mono','Courier New',monospace", overflow: "hidden", transition: "background 0.2s, color 0.2s" }}>
      <GlobalStyles t={t} darkMode={darkMode} />

      {/* ── HEADER ── */}
      <header style={{ background: t.bgHeader, borderBottom: `2px solid ${t.accent}`, padding: "0 20px", height: 52, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, boxShadow: darkMode ? "none" : "0 1px 8px rgba(0,0,0,0.07)" }}>
        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 30, height: 30, background: t.accent, display: "flex", alignItems: "center", justifyContent: "center", clipPath: "polygon(10% 0%,90% 0%,100% 10%,100% 90%,90% 100%,10% 100%,0% 90%,0% 10%)", flexShrink: 0 }}>
            <span style={{ fontSize: "15px" }}>🔧</span>
          </div>
          <div>
            <div style={{ fontFamily: "'Barlow Condensed',sans-serif", fontSize: "1.5rem", fontWeight: 800, color: t.text, letterSpacing: "0.05em", lineHeight: 1 }}>
              GEAR<span style={{ color: t.accent }}>Brain</span>
            </div>
            <div style={{ fontSize: "0.6rem", color: t.textFaint, letterSpacing: "0.1em", lineHeight: 1, marginTop: 1 }}>AI DIAGNOSTIKA · FORD TRANSIT EU</div>
          </div>
        </div>

        {/* Pravá část — sjednocená výška a font */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: "0.75rem", color: t.textFaint }}>
            {cases.length} případů
          </span>
          <span style={{ color: t.border }}>·</span>
          <span style={{ fontSize: "0.75rem", color: cloudStatus === "ok" ? t.doneStatusColor : t.textFaint }}>
            {cloudStatus === "ok" ? "cloud ✓" : cloudStatus === "error" ? "cloud offline" : "cloud —"}
          </span>
          <span style={{ color: t.border, margin: "0 4px" }}>|</span>
          <button onClick={() => setDarkMode((d) => !d)}
            style={{ display: "flex", alignItems: "center", gap: 5, background: t.bgCard, border: `1px solid ${t.border}`, color: t.textMuted, padding: "5px 11px", fontSize: "0.75rem", fontFamily: "inherit", cursor: "pointer", borderRadius: 20, height: 30 }}>
            {darkMode ? "☀️ Světlý" : "🌙 Tmavý"}
          </button>
          <button onClick={() => setShowSettings(true)}
            style={{ display: "flex", alignItems: "center", gap: 5, background: t.bgCard, border: `1px solid ${t.border}`, color: t.textMuted, padding: "5px 11px", fontSize: "0.75rem", cursor: "pointer", borderRadius: 20, height: 30, fontFamily: "inherit" }}>
            ⚙️ Nastavení
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 11px", background: "rgba(76,175,80,0.08)", border: `1px solid ${t.doneStatusBorder}`, borderRadius: 20, height: 30 }}>
            <span style={{ fontSize: "0.6rem", color: t.doneStatusColor }}>●</span>
            <span style={{ fontSize: "0.75rem", color: t.doneStatusColor }}>Aktivní</span>
          </div>
        </div>
      </header>

      {/* ── UPDATE BANNER ── */}
      {updatePhase !== "idle" && (
        <div style={{
          background: updatePhase === "ready" ? "rgba(76,175,80,0.12)" : "rgba(59,130,246,0.1)",
          borderBottom: `1px solid ${updatePhase === "ready" ? t.doneStatusBorder : "#3b82f6"}`,
          padding: "8px 20px", display: "flex", alignItems: "center",
          justifyContent: "space-between", gap: 12, flexShrink: 0,
          fontSize: "0.78rem",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {updatePhase === "available" && (
              <>
                <span style={{ color: "#3b82f6" }}>↑</span>
                <span style={{ color: t.text }}>
                  Dostupná aktualizace <strong>v{updateInfo?.version}</strong>
                </span>
              </>
            )}
            {updatePhase === "downloading" && (
              <>
                <span style={{ color: "#3b82f6", animation: "pulse 1s ease infinite" }}>↓</span>
                <span style={{ color: t.text }}>Stahuji aktualizaci... {updateProgress}%</span>
                <div style={{ width: 120, height: 4, background: t.border, borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ width: `${updateProgress}%`, height: "100%", background: "#3b82f6", transition: "width 0.3s" }} />
                </div>
              </>
            )}
            {updatePhase === "ready" && (
              <>
                <span style={{ color: t.doneStatusColor }}>✓</span>
                <span style={{ color: t.text }}>
                  Aktualizace <strong>v{updateInfo?.version}</strong> připravena k instalaci
                </span>
              </>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            {updatePhase === "available" && (
              <>
                <button onClick={() => setUpdatePhase("idle")}
                  style={{ background: "none", border: `1px solid ${t.border}`, color: t.textFaint, padding: "4px 12px", fontSize: "0.72rem", cursor: "pointer", fontFamily: "inherit", borderRadius: 2 }}>
                  Později
                </button>
                <button onClick={() => window.electronAPI.updater.download()}
                  style={{ background: "#3b82f6", color: "#fff", border: "none", padding: "4px 14px", fontSize: "0.72rem", fontWeight: 700, cursor: "pointer", fontFamily: "inherit", borderRadius: 2 }}>
                  ↓ Stáhnout
                </button>
              </>
            )}
            {updatePhase === "ready" && (
              <button onClick={() => window.electronAPI.updater.install()}
                style={{ background: t.doneStatusColor, color: "#fff", border: "none", padding: "4px 14px", fontSize: "0.72rem", fontWeight: 700, cursor: "pointer", fontFamily: "inherit", borderRadius: 2 }}>
                ↺ Restartovat a nainstalovat
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── BODY ── */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

        {/* SIDEBAR */}
        <aside style={{ width: 264, borderRight: `1px solid ${t.border}`, display: "flex", flexDirection: "column", flexShrink: 0, background: t.bgSidebar }}>
          <div style={{ padding: "10px 12px", borderBottom: `1px solid ${t.border}` }}>
            <button onClick={() => { setView("new"); setActiveId(null); setError(null); }}
              style={{ width: "100%", background: t.accent, color: "#fff", border: "none", cursor: "pointer", padding: "10px", fontSize: "0.78rem", letterSpacing: "0.1em", fontWeight: 700, fontFamily: "inherit", borderRadius: 2, clipPath: "polygon(5px 0%,100% 0%,calc(100% - 5px) 100%,0% 100%)" }}>
              + NOVÝ PŘÍPAD
            </button>
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: "6px 0" }}>
            {cases.length === 0 && (
              <div style={{ padding: "24px 12px", textAlign: "center", color: t.textVeryFaint, fontSize: "0.75rem", lineHeight: 1.8 }}>
                Žádné případy.<br />Klikněte na NOVÝ PŘÍPAD.
              </div>
            )}
            {cases.map((c) => (
              <div key={c.id} className="case-item" onClick={() => openCase(c.id)}
                style={{ padding: "10px 12px", borderLeft: `3px solid ${activeId === c.id ? t.accent : "transparent"}`, background: activeId === c.id ? t.bgSelected : "transparent", borderBottom: `1px solid ${t.border}`, cursor: "pointer", userSelect: "none" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 6, marginBottom: 3 }}>
                  <div style={{ fontSize: "0.75rem", color: activeId === c.id ? t.text : t.textLabel, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: activeId === c.id ? 600 : 400 }}>
                    {c.name}
                  </div>
                  <StatusBadge status={c.status} t={t} />
                </div>
                <div style={{ fontSize: "0.65rem", color: t.textVeryFaint }}>
                  {fmtDate(c.createdAt)}
                  {c.vehicle?.model && <span style={{ marginLeft: 6 }}>· {c.vehicle.model.split(" ").slice(0, 2).join(" ")}</span>}
                </div>
              </div>
            ))}
          </div>

          <div style={{ borderTop: `1px solid ${t.border}`, flexShrink: 0 }}>
            {/* Lokální databáze */}
            <div style={{ padding: "7px 12px", fontSize: "0.67rem", color: t.textVeryFaint, borderBottom: `1px solid ${t.border}` }}>
              Lokální: {closedCount > 0 ? `${closedCount} uzavřených` : "prázdná"}
            </div>

            {/* Cloud databáze — stav posledního RAG dotazu */}
            <div style={{ padding: "7px 12px", fontSize: "0.67rem", color: cloudStatus === "ok" ? t.doneStatusColor : cloudStatus === "error" ? "#dc2626" : t.textVeryFaint, display: "flex", alignItems: "center", gap: 5 }}>
              {cloudStatus === "ok"    && <><span>●</span><span>Cloud RAG aktivní</span></>}
              {cloudStatus === "error" && <><span>✕</span><span>Cloud nedostupný</span></>}
              {cloudStatus === "idle"  && <><span>○</span><span>Cloud: nepřipojeno</span></>}
            </div>
          </div>
        </aside>

        {/* MAIN */}
        <main style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>

          {/* Welcome */}
          {view === "welcome" && (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 16 }}>
              <div style={{ fontSize: "3rem", opacity: 0.07 }}>🔧</div>
              <div style={{ fontSize: "0.8rem", color: t.textFaint, letterSpacing: "0.1em", textAlign: "center", lineHeight: 1.9 }}>
                Vyberte případ ze seznamu vlevo<br />nebo vytvořte novou diagnostiku
              </div>
              <button onClick={() => setView("new")}
                style={{ background: t.accent, color: "#fff", border: "none", cursor: "pointer", padding: "11px 30px", fontSize: "0.78rem", letterSpacing: "0.12em", fontFamily: "inherit", fontWeight: 700, borderRadius: 2, marginTop: 8 }}>
                + NOVÝ PŘÍPAD
              </button>
            </div>
          )}

          {/* Nový případ */}
          {view === "new" && (
            <div style={{ flex: 1, overflowY: "auto", padding: "24px", background: t.bg }}>
              <div style={{ maxWidth: 680, margin: "0 auto" }}>
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontFamily: "'Barlow Condensed',sans-serif", fontSize: "1.5rem", fontWeight: 700, color: t.accent, letterSpacing: "0.05em", marginBottom: 4 }}>NOVÝ DIAGNOSTICKÝ PŘÍPAD</div>
                  <div style={{ fontSize: "0.78rem", color: t.textFaint }}>Zadejte informace o vozidle a první příznaky závady</div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 18 }}>
                  <div>
                    <div style={{ fontSize: "0.68rem", color: t.textFaint, letterSpacing: "0.1em", marginBottom: 6 }}>MODEL VOZIDLA</div>
                    <select value={newVehicle.model}
                      onChange={(e) => { const item = VEHICLE_MODELS.find((m) => m.label === e.target.value); if (item?.label) setNewVehicle((v) => ({ ...v, model: item.label })); }}
                      style={{ width: "100%", background: t.bgInput, border: `1px solid ${t.borderInput}`, color: t.text, padding: "9px 10px", fontSize: "0.82rem", fontFamily: "inherit", borderRadius: 2, outline: "none" }}>
                      <option value="">— Vyberte model —</option>
                      {VEHICLE_MODELS.map((item, i) =>
                        item.group
                          ? <option key={i} disabled>── {item.group} ──</option>
                          : <option key={i} value={item.label}>{item.label}</option>
                      )}
                    </select>
                  </div>
                  <div>
                    <div style={{ fontSize: "0.68rem", color: t.textFaint, letterSpacing: "0.1em", marginBottom: 6 }}>NÁJEZD (KM)</div>
                    <input type="number" placeholder="185000" value={newVehicle.mileage}
                      onChange={(e) => setNewVehicle((v) => ({ ...v, mileage: e.target.value }))}
                      style={{ width: "100%", background: t.bgInput, border: `1px solid ${t.borderInput}`, color: t.text, padding: "9px 10px", fontSize: "0.82rem", fontFamily: "inherit", borderRadius: 2, outline: "none" }} />
                  </div>
                </div>

                {error && <div style={{ marginBottom: 14, padding: "10px 13px", background: "rgba(220,38,38,0.08)", border: "1px solid #dc2626", color: "#dc2626", fontSize: "0.82rem", borderRadius: 2 }}>⚠ {error}</div>}
                <InputForm onSubmit={handleNewCase} loading={loading} label="ZAHÁJIT DIAGNOSTIKU" t={t} />
              </div>
            </div>
          )}

          {/* Aktivní případ */}
          {view === "session" && activeCase && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

              {/* Case header */}
              <div style={{ padding: "0 18px", height: 52, background: t.bgHeader, borderBottom: `1px solid ${t.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
                <div style={{ overflow: "hidden" }}>
                  <div style={{ fontSize: "0.9rem", color: t.text, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{activeCase.name}</div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    {activeCase.vehicle?.model   && <span style={{ fontSize: "0.68rem", color: t.textFaint }}>{activeCase.vehicle.model}</span>}
                    {activeCase.vehicle?.mileage && <span style={{ fontSize: "0.68rem", color: t.textVeryFaint }}>· {fmtMileage(activeCase.vehicle.mileage)}</span>}
                    <StatusBadge status={activeCase.status} t={t} />
                    {/* Token indikátor */}
                    {activeCase.status === "rozpracovaný" && (() => {
                      const used  = activeCase.tokenCount ?? 0;
                      const pct   = Math.min(100, Math.round(used / CASE_TOKEN_LIMIT * 100));
                      const color = pct >= 90 ? "#dc2626" : pct >= 70 ? "#d97706" : t.textVeryFaint;
                      return (
                        <span title={`${used.toLocaleString()} / ${CASE_TOKEN_LIMIT.toLocaleString()} tokenů`}
                          style={{ fontSize: "0.62rem", color, letterSpacing: "0.04em" }}>
                          {pct >= 5 ? `▓ ${pct}%` : "▓ <1%"}
                        </span>
                      );
                    })()}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                  {activeCase.status === "rozpracovaný" && (
                    <button onClick={() => setCloseModal(true)}
                      style={{ background: t.doneStatusBg, border: `1px solid ${t.doneStatusBorder}`, color: t.doneStatusColor, padding: "6px 14px", fontSize: "0.75rem", letterSpacing: "0.06em", cursor: "pointer", fontFamily: "inherit", borderRadius: 2 }}>
                      ✓ UZAVŘÍT
                    </button>
                  )}
                  <button onClick={() => setDeleteId(activeCase.id)}
                    style={{ background: "rgba(220,38,38,0.07)", border: "1px solid rgba(220,38,38,0.3)", color: "#dc2626", padding: "6px 14px", fontSize: "0.75rem", letterSpacing: "0.06em", cursor: "pointer", fontFamily: "inherit", borderRadius: 2 }}>
                    ✕ SMAZAT
                  </button>
                </div>
              </div>

              {/* ── CHAT MESSAGES ── */}
              <div style={{ flex: 1, overflowY: "auto", padding: "20px", background: t.bg }}>
                <div style={{ maxWidth: 760, margin: "0 auto", display: "flex", flexDirection: "column", gap: 12 }}>

                  {activeCase.messages.length === 0 && !loading && (
                    <div style={{ textAlign: "center", color: t.textVeryFaint, fontSize: "0.78rem", letterSpacing: "0.08em", padding: "40px 0" }}>
                      Případ připraven — zadejte příznaky níže a spusťte diagnostiku
                    </div>
                  )}

                  {activeCase.messages.map((msg, idx) => {

                    // ── Uživatelský vstup — bublina vpravo ──
                    if (msg.type === "input") {
                      const roundNo = activeCase.messages.slice(0, idx + 1).filter((m) => m.type === "input").length;
                      const hasChips = (msg.symptoms?.length > 0) || (msg.obdCodes?.length > 0);
                      return (
                        <div key={msg.id} style={{ display: "flex", justifyContent: "flex-end" }}>
                          <div style={{ maxWidth: "72%", minWidth: 120 }}>
                            <div style={{ fontSize: "0.65rem", color: t.textFaint, textAlign: "right", marginBottom: 4, letterSpacing: "0.06em" }}>
                              Vstup #{roundNo} · {fmtDate(msg.timestamp)}
                            </div>
                            <div style={{ background: t.inputBg, border: `1px solid ${t.inputBorder}`, borderRight: `3px solid ${t.accent}`, borderRadius: "8px 2px 8px 8px", padding: "10px 14px" }}>
                              {hasChips && (
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: msg.text ? 8 : 0 }}>
                                  {(msg.symptoms ?? []).map((s) => (
                                    <span key={s} style={{ padding: "2px 8px", background: t.sympBg, border: `1px solid ${t.sympBorder}`, color: t.sympText, fontSize: "0.76rem", borderRadius: 2 }}>{s}</span>
                                  ))}
                                  {(msg.obdCodes ?? []).map((c) => (
                                    <span key={c} style={{ padding: "2px 8px", background: t.obdBg, border: `1px solid ${t.obdBorder}`, color: t.obdText, fontSize: "0.76rem", fontFamily: "monospace", borderRadius: 2 }}>{c}</span>
                                  ))}
                                </div>
                              )}
                              {msg.text && (
                                <div style={{ fontSize: "0.85rem", color: t.text, lineHeight: 1.6 }}>{msg.text}</div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    }

                    // ── AI diagnostika — bublina vlevo ──
                    if (msg.type === "diagnosis") {
                      // RAG shody — jen lokální cases (cloudové záznamy se již neukládají lokálně)
                    const matchIds    = msg.ragMatchIds ?? [];
                    const ragSessions = cases.filter((c) => matchIds.includes(c.id));
                      return (
                        <div key={msg.id} style={{ display: "flex", justifyContent: "flex-start" }}>
                          <div style={{ maxWidth: "92%" }}>
                            <div style={{ fontSize: "0.65rem", color: t.accentText, marginBottom: 4, letterSpacing: "0.06em" }}>
                              ◈ GearBrain · {fmtDate(msg.timestamp)}
                            </div>
                            <DiagCard result={msg.result} ragMatches={ragSessions} t={t} />
                          </div>
                        </div>
                      );
                    }

                    return null;
                  })}

                  {/* Načítání */}
                  {loading && (
                    <div style={{ display: "flex", justifyContent: "flex-start" }}>
                      <div style={{ padding: "16px 20px", background: t.bgMuted, border: `1px solid ${t.border}`, borderLeft: `3px solid ${t.accent}`, borderRadius: "2px 8px 8px 8px" }}>
                        <div style={{ animation: "pulse 1.5s ease infinite", fontSize: "0.78rem", color: t.accent, letterSpacing: "0.15em" }}>◈ AI DIAGNOSTIKA PROBÍHÁ ◈</div>
                        <div style={{ fontSize: "0.7rem", color: t.textVeryFaint, marginTop: 4 }}>Prohledávám databázi servisu · Analyzuji příznaky...</div>
                      </div>
                    </div>
                  )}

                  {/* Chyba */}
                  {error && (
                    <div style={{ padding: "10px 14px", background: "rgba(220,38,38,0.08)", border: "1px solid #dc2626", color: "#dc2626", fontSize: "0.82rem", borderRadius: 2 }}>
                      ⚠ {error}
                    </div>
                  )}

                  {/* Uzavřený případ — summary */}
                  {activeCase.status === "uzavřený" && activeCase.resolution && (
                    <div style={{ padding: "14px 16px", background: t.closedBg, border: `1px solid ${t.closedBorder}`, borderLeft: `4px solid ${t.doneStatusColor}`, borderRadius: 2, marginTop: 4 }}>
                      <div style={{ fontSize: "0.68rem", color: t.doneStatusColor, letterSpacing: "0.1em", marginBottom: 6 }}>
                        ✓ PŘÍPAD UZAVŘEN · {activeCase.closedAt ? fmtDate(activeCase.closedAt) : ""}
                      </div>
                      <div style={{ fontSize: "0.9rem", color: t.doneStatusColor, lineHeight: 1.6 }}>{activeCase.resolution}</div>
                    </div>
                  )}

                  <div ref={chatEndRef} />
                </div>
              </div>

              {/* ── INPUT AREA ── */}
              {activeCase.status === "rozpracovaný" && (
                <div style={{ borderTop: `1px solid ${t.border}`, padding: "14px 20px", background: t.bgFollowup, flexShrink: 0 }}>
                  <div style={{ maxWidth: 760, margin: "0 auto" }}>
                    {diagCount === 0 ? (
                      // První diagnostika — plný formulář s příznaky + OBD
                      <>
                        <div style={{ fontSize: "0.68rem", color: t.textVeryFaint, letterSpacing: "0.08em", marginBottom: 10 }}>PRVNÍ DIAGNOSTIKA — zadejte příznaky</div>
                        <InputForm onSubmit={(d) => runDiag(activeId, d)} loading={loading} label="SPUSTIT DIAGNOSTIKU" t={t} />
                      </>
                    ) : (
                      // Pokračování — jednoduchý prompt
                      <>
                        <div style={{ fontSize: "0.68rem", color: t.textVeryFaint, letterSpacing: "0.08em", marginBottom: 10 }}>DOPLNIT INFORMACE</div>
                        <FollowUpPrompt onSubmit={(d) => runDiag(activeId, d)} loading={loading} t={t} />
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </main>
      </div>

      {/* ── Nastavení ── */}
      {showSettings && (
        <SettingsPanel t={t} onClose={() => setShowSettings(false)} onKeyDeleted={() => { setShowSettings(false); setHasApiKey(false); }} />
      )}

      {/* ── MODAL: Uzavřít případ ── */}
      {closeModal && (
        <Modal onClose={() => { setCloseModal(false); setCloseError(null); }} width={500}>
          <div style={{ background: t.bgModal, border: `1px solid ${t.border}`, borderRadius: 4, padding: "26px", boxShadow: "0 20px 60px rgba(0,0,0,0.35)" }}>
            <div style={{ fontFamily: "'Barlow Condensed',sans-serif", fontSize: "1.4rem", fontWeight: 700, color: t.doneStatusColor, marginBottom: 8 }}>✓ UZAVŘÍT PŘÍPAD</div>
            <p style={{ fontSize: "0.85rem", color: t.textMuted, marginBottom: 16, lineHeight: 1.7 }}>
              Popište provedenou opravu. Tato informace bude uložena do databáze servisu a pomůže při budoucích diagnostikách.
            </p>
            <div style={{ fontSize: "0.68rem", color: t.textFaint, letterSpacing: "0.1em", marginBottom: 6 }}>PROVEDENÁ OPRAVA *</div>
            <textarea value={resolution} onChange={(e) => { setResolution(e.target.value); setCloseError(null); }} autoFocus rows={5}
              placeholder="např. Vyměněn EGR ventil + EGR chladič. Po vyčištění sání a regeneraci DPF vozidlo jede bez závad. Kód P0401 vymazán, nevrátil se."
              style={{ width: "100%", background: t.bgInput, border: `1px solid ${closeError ? "#dc2626" : t.borderInput}`, color: t.text, padding: "10px 12px", fontSize: "0.88rem", lineHeight: 1.7, marginBottom: closeError ? 8 : 16, fontFamily: "'IBM Plex Mono',monospace", resize: "vertical", outline: "none", borderRadius: 2 }} />
            {closeError && (
              <div style={{ fontSize: "0.8rem", color: "#dc2626", marginBottom: 12, padding: "6px 10px", background: "rgba(220,38,38,0.08)", border: "1px solid rgba(220,38,38,0.3)", borderRadius: 2 }}>
                ⚠ {closeError}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => { setCloseModal(false); setCloseError(null); }}
                style={{ background: "transparent", border: `1px solid ${t.border}`, color: t.textFaint, padding: "8px 20px", fontSize: "0.82rem", cursor: "pointer", fontFamily: "inherit", borderRadius: 2 }}>
                Zrušit
              </button>
              <button disabled={!resolution.trim()} onClick={closeCase}
                style={{ background: resolution.trim() ? t.doneStatusColor : "transparent", color: resolution.trim() ? "#fff" : t.textVeryFaint, border: `1px solid ${resolution.trim() ? t.doneStatusColor : t.border}`, padding: "8px 24px", fontSize: "0.82rem", fontWeight: 700, cursor: resolution.trim() ? "pointer" : "not-allowed", fontFamily: "inherit", borderRadius: 2 }}>
                ✓ Potvrdit
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── MODAL: Smazat případ ── */}
      {deleteId && (
        <Modal onClose={() => setDeleteId(null)} width={380}>
          <div style={{ background: t.bgModal, border: `1px solid ${t.border}`, borderRadius: 4, padding: "26px", boxShadow: "0 20px 60px rgba(0,0,0,0.35)" }}>
            <div style={{ fontFamily: "'Barlow Condensed',sans-serif", fontSize: "1.3rem", fontWeight: 700, color: "#dc2626", marginBottom: 10 }}>SMAZAT PŘÍPAD</div>
            <p style={{ fontSize: "0.85rem", color: t.textMuted, marginBottom: 18, lineHeight: 1.6 }}>
              Opravdu smazat tento případ? Akce je nevratná.
              {cases.find((c) => c.id === deleteId)?.status === "uzavřený" && (
                <span style={{ display: "block", color: "#d97706", marginTop: 8, fontSize: "0.8rem" }}>
                  ⚠ Případ je uzavřen a je součástí databáze servisu.
                </span>
              )}
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setDeleteId(null)}
                style={{ background: "transparent", border: `1px solid ${t.border}`, color: t.textFaint, padding: "8px 20px", fontSize: "0.82rem", cursor: "pointer", fontFamily: "inherit", borderRadius: 2 }}>
                Zrušit
              </button>
              <button onClick={() => deleteCase(deleteId)}
                style={{ background: "rgba(220,38,38,0.1)", border: "1px solid #dc2626", color: "#dc2626", padding: "8px 20px", fontSize: "0.82rem", cursor: "pointer", fontFamily: "inherit", borderRadius: 2 }}>
                ✕ Smazat
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
