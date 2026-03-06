import { useState, useEffect, useCallback } from "react";

/**
 * ObdReader — komponenta pro připojení ELM327 adaptéru a načtení DTC kódů.
 *
 * Props:
 *   onCodesLoaded(stored, pending) — voláno po úspěšném načtení kódů
 *   t                              — tema objekt
 */
export default function ObdReader({ onCodesLoaded, t }) {
  // "idle" | "listing" | "ready" | "connecting" | "connected" | "reading" | "error"
  const [phase,       setPhase]       = useState("idle");
  const [ports,       setPorts]       = useState([]);
  const [selectedPort,setSelectedPort]= useState("");
  const [statusMsg,   setStatusMsg]   = useState("");
  const [errorMsg,    setErrorMsg]    = useState("");
  const [lastCodes,   setLastCodes]   = useState(null); // { stored, pending }

  // ── Načtení portů ────────────────────────────────────────────────────────────
  const listPorts = useCallback(async () => {
    setPhase("listing");
    setErrorMsg("");
    try {
      const { ports: found, error } = await window.electronAPI.obd.listPorts();
      if (error) { setPhase("error"); setErrorMsg(error); return; }
      if (found.length === 0) {
        setPhase("error");
        setErrorMsg("Žádný sériový port nenalezen. Zkontrolujte, zda je kabel zapojen.");
        return;
      }
      setPorts(found);
      // Automaticky předvybrat pravděpodobný OBD port
      const likelyPort = found.find(p => p.likelyObd) ?? found[0];
      setSelectedPort(likelyPort.path);
      setPhase("ready");
    } catch (e) {
      setPhase("error");
      setErrorMsg("Chyba při hledání portů: " + e.message);
    }
  }, []);

  // ── Připojení ────────────────────────────────────────────────────────────────
  const connect = useCallback(async () => {
    if (!selectedPort) return;
    setPhase("connecting");
    setStatusMsg("Inicializuji ELM327...");
    setErrorMsg("");
    try {
      const { ok, error } = await window.electronAPI.obd.connect(selectedPort);
      if (!ok) {
        setPhase("error");
        setErrorMsg(error || "Připojení selhalo");
        return;
      }
      setPhase("connected");
      setStatusMsg("Připojeno ✓");
    } catch (e) {
      setPhase("error");
      setErrorMsg("Chyba připojení: " + e.message);
    }
  }, [selectedPort]);

  // ── Načtení kódů ─────────────────────────────────────────────────────────────
  const readCodes = useCallback(async () => {
    setPhase("reading");
    setStatusMsg("Čtu kódy závad...");
    setErrorMsg("");
    try {
      const { stored, pending, error } = await window.electronAPI.obd.readCodes({ includePending: true });
      if (error) {
        setPhase("connected"); // zůstaneme připojeni, jen se nepodařilo číst
        setErrorMsg(error);
        return;
      }
      setLastCodes({ stored, pending });
      setPhase("connected");
      setStatusMsg(`Načteno: ${stored.length} uložených, ${pending.length} pending kódů`);
      onCodesLoaded(stored, pending);
    } catch (e) {
      setPhase("connected");
      setErrorMsg("Chyba čtení: " + e.message);
    }
  }, [onCodesLoaded]);

  // ── Odpojení ─────────────────────────────────────────────────────────────────
  const disconnect = useCallback(async () => {
    await window.electronAPI.obd.disconnect();
    setPhase("idle");
    setStatusMsg("");
    setErrorMsg("");
    setLastCodes(null);
    setPorts([]);
    setSelectedPort("");
  }, []);

  // Cleanup při unmount
  useEffect(() => () => { window.electronAPI.obd.disconnect(); }, []);

  // ── Barvy podle stavu ─────────────────────────────────────────────────────────
  const phaseColor = {
    idle:       t.textVeryFaint,
    listing:    t.textFaint,
    ready:      t.textMuted,
    connecting: "#d97706",
    connected:  t.doneStatusColor,
    reading:    "#d97706",
    error:      "#dc2626",
  }[phase] ?? t.textFaint;

  const phaseDot = {
    idle:       "○",
    listing:    "◌",
    ready:      "◌",
    connecting: "◎",
    connected:  "●",
    reading:    "◎",
    error:      "✕",
  }[phase] ?? "○";

  const isWorking = phase === "listing" || phase === "connecting" || phase === "reading";

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div style={{ border: `1px solid ${phase === "connected" ? t.doneStatusBorder : t.border}`, borderRadius: 3, overflow: "hidden", marginBottom: 10 }}>

      {/* Header lišta */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", background: phase === "connected" ? t.doneStatusBg : t.bgMuted, borderBottom: `1px solid ${t.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: "0.85rem", color: phaseColor, animation: isWorking ? "pulse 1s ease infinite" : "none" }}>
            {phaseDot}
          </span>
          <span style={{ fontSize: "0.72rem", color: t.textMuted, letterSpacing: "0.08em", fontWeight: 600 }}>
            NAČÍST Z VOZIDLA
          </span>
          {statusMsg && (
            <span style={{ fontSize: "0.68rem", color: phaseColor }}>{statusMsg}</span>
          )}
        </div>
        {/* Disconnect tlačítko */}
        {(phase === "connected" || phase === "reading") && (
          <button onClick={disconnect}
            style={{ background: "none", border: "none", color: t.textFaint, fontSize: "0.68rem", cursor: "pointer", fontFamily: "inherit", padding: "2px 6px" }}>
            Odpojit
          </button>
        )}
      </div>

      {/* Tělo */}
      <div style={{ padding: "10px 12px", background: t.bgCard }}>

        {/* Chybová hláška */}
        {errorMsg && (
          <div style={{ padding: "7px 10px", background: "rgba(220,38,38,0.08)", border: "1px solid rgba(220,38,38,0.3)", color: "#dc2626", fontSize: "0.76rem", borderRadius: 2, marginBottom: 10, lineHeight: 1.5 }}>
            ⚠ {errorMsg}
          </div>
        )}

        {/* Idle — výzva ke skenování */}
        {phase === "idle" && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <div style={{ fontSize: "0.76rem", color: t.textFaint, lineHeight: 1.5 }}>
              Připojte OBD-II USB kabel (ELM327) a klikněte na Hledat porty.
              <span style={{ display: "block", fontSize: "0.68rem", color: t.textVeryFaint, marginTop: 2 }}>
                Vozidlo musí mít zapnuté zapalování (klíč do polohy ON).
              </span>
            </div>
            <button onClick={listPorts}
              style={{ background: t.accent, color: "#fff", border: "none", cursor: "pointer", padding: "8px 16px", fontSize: "0.75rem", fontFamily: "inherit", fontWeight: 700, borderRadius: 2, whiteSpace: "nowrap", flexShrink: 0 }}>
              🔍 Hledat porty
            </button>
          </div>
        )}

        {/* Listing */}
        {phase === "listing" && (
          <div style={{ fontSize: "0.76rem", color: t.textFaint, padding: "4px 0", animation: "pulse 1.5s ease infinite" }}>
            Hledám sériové porty...
          </div>
        )}

        {/* Ready — výběr portu + připojení */}
        {phase === "ready" && (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <select value={selectedPort} onChange={(e) => setSelectedPort(e.target.value)}
              style={{ flex: 1, background: t.bgInput, border: `1px solid ${t.borderInput}`, color: t.text, padding: "7px 9px", fontSize: "0.78rem", fontFamily: "inherit", borderRadius: 2, outline: "none" }}>
              {ports.map((p) => (
                <option key={p.path} value={p.path}>
                  {p.likelyObd ? "★ " : ""}{p.friendlyName || p.path}
                </option>
              ))}
            </select>
            <button onClick={connect}
              style={{ background: t.accent, color: "#fff", border: "none", cursor: "pointer", padding: "8px 16px", fontSize: "0.75rem", fontFamily: "inherit", fontWeight: 700, borderRadius: 2, whiteSpace: "nowrap" }}>
              Připojit
            </button>
            <button onClick={() => setPhase("idle")}
              style={{ background: "none", border: `1px solid ${t.border}`, color: t.textFaint, padding: "8px 12px", fontSize: "0.75rem", cursor: "pointer", fontFamily: "inherit", borderRadius: 2 }}>
              ✕
            </button>
          </div>
        )}

        {/* Connecting */}
        {phase === "connecting" && (
          <div style={{ fontSize: "0.76rem", color: "#d97706", animation: "pulse 1.5s ease infinite" }}>
            Inicializuji ELM327 na {selectedPort}...
          </div>
        )}

        {/* Connected — akce */}
        {(phase === "connected" || phase === "reading") && (
          <div>
            <div style={{ display: "flex", gap: 8, marginBottom: lastCodes ? 10 : 0 }}>
              <button onClick={readCodes} disabled={phase === "reading"}
                style={{ flex: 1, background: phase === "reading" ? t.border : t.accent, color: phase === "reading" ? t.textFaint : "#fff", border: "none", cursor: phase === "reading" ? "not-allowed" : "pointer", padding: "9px", fontSize: "0.78rem", fontFamily: "inherit", fontWeight: 700, borderRadius: 2, animation: phase === "reading" ? "pulse 1.5s ease infinite" : "none" }}>
                {phase === "reading" ? "Čtu kódy..." : "📥 Načíst kódy závad"}
              </button>
            </div>

            {/* Výsledek načtení */}
            {lastCodes && (
              <div>
                {lastCodes.stored.length === 0 && lastCodes.pending.length === 0 && (
                  <div style={{ fontSize: "0.76rem", color: t.doneStatusColor, padding: "6px 0" }}>
                    ✓ Žádné kódy závad uloženy v ECU
                  </div>
                )}
                {lastCodes.stored.length > 0 && (
                  <div style={{ marginBottom: 6 }}>
                    <div style={{ fontSize: "0.62rem", color: t.textFaint, letterSpacing: "0.08em", marginBottom: 4 }}>
                      ULOŽENÉ KÓDY ({lastCodes.stored.length}) — přidány do formuláře ↓
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {lastCodes.stored.map(c => (
                        <span key={c} style={{ padding: "2px 8px", background: t.doneStatusBg, border: `1px solid ${t.doneStatusBorder}`, color: t.doneStatusColor, fontSize: "0.78rem", fontFamily: "monospace", borderRadius: 2 }}>
                          {c}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {lastCodes.pending.length > 0 && (
                  <div>
                    <div style={{ fontSize: "0.62rem", color: t.textFaint, letterSpacing: "0.08em", marginBottom: 4 }}>
                      PENDING KÓDY ({lastCodes.pending.length}) — detekované, ale nepotvrzené
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {lastCodes.pending.map(c => (
                        <span key={c} style={{ padding: "2px 8px", background: t.openStatusBg, border: `1px solid ${t.openStatusBorder}`, color: t.openStatusColor, fontSize: "0.78rem", fontFamily: "monospace", borderRadius: 2 }}>
                          {c}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Error — možnost retry */}
        {phase === "error" && (
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button onClick={listPorts}
              style={{ background: t.bgMuted, border: `1px solid ${t.border}`, color: t.textMuted, padding: "7px 14px", fontSize: "0.75rem", cursor: "pointer", fontFamily: "inherit", borderRadius: 2 }}>
              ↺ Zkusit znovu
            </button>
            <button onClick={() => { setPhase("idle"); setErrorMsg(""); }}
              style={{ background: "none", border: `1px solid ${t.border}`, color: t.textFaint, padding: "7px 12px", fontSize: "0.75rem", cursor: "pointer", fontFamily: "inherit", borderRadius: 2 }}>
              Zrušit
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
