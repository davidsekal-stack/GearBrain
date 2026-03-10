import { useState, useCallback, useRef, useEffect } from "react";
import { uid } from "../lib/utils.js";
import { EMPTY_VEHICLE } from "../constants/index.js";
import * as storage from "../lib/storage.js";

/**
 * useCases hook — web verze (Supabase-backed)
 *
 * Všechny případy se ukládají do Supabase tabulky gearbrain_web_sessions.
 * Na rozdíl od Electron verze (electron-store) je zde async persistence.
 */
export default function useCases() {
  const [cases, setCases]     = useState([]);
  const [activeId, setActiveId] = useState(null);
  const casesRef = useRef(cases);
  useEffect(() => { casesRef.current = cases; }, [cases]);

  const activeCase = cases.find((c) => c.id === activeId) ?? null;

  // ── debounced save — ukládá případ do Supabase s 500ms debounce ────────────
  const saveTimers = useRef({});

  const debouncedSave = useCallback((caseData) => {
    const id = caseData.id;
    if (saveTimers.current[id]) clearTimeout(saveTimers.current[id]);
    saveTimers.current[id] = setTimeout(() => {
      const status = caseData.status === "uzavřený" ? "closed" : "open";
      storage.updateCase(id, caseData, status).catch(e => console.warn('[save]', e.message));
    }, 500);
  }, []);

  // ── CRUD ──────────────────────────────────────────────────────────────────────

  const updateCase = useCallback((id, fn) => {
    setCases((prev) => {
      const next = prev.map((c) => {
        if (c.id !== id) return c;
        const updated = { ...c, ...fn(c) };
        debouncedSave(updated);
        return updated;
      });
      return next;
    });
  }, [debouncedSave]);

  const updateCases = useCallback((updater) => {
    setCases((prev) => typeof updater === "function" ? updater(prev) : updater);
  }, []);

  const createCase = useCallback((vehicle) => {
    const id = uid();
    const name = vehicle.model
      ? vehicle.model.split(" ").slice(0, 3).join(" ")
        + (vehicle.enginePower ? ` · ${vehicle.enginePower.split(" ")[0]} kW` : "")
        + (vehicle.mileage ? ` · ${Number(vehicle.mileage).toLocaleString("cs-CZ")} km` : "")
      : "Nový případ";

    const newCase = {
      id, name, status: "rozpracovaný",
      createdAt: new Date().toISOString(), closedAt: null,
      vehicle, messages: [], resolution: null, tokenCount: 0,
    };

    setCases((prev) => [newCase, ...prev]);
    setActiveId(id);

    // Async save to Supabase
    storage.createCase(newCase).catch(e => console.warn('[create]', e.message));

    return id;
  }, []);

  const deleteCase = useCallback((id) => {
    setCases((prev) => prev.filter((c) => c.id !== id));
    if (activeId === id) setActiveId(null);
    storage.deleteCase(id).catch(e => console.warn('[delete]', e.message));
  }, [activeId]);

  // ── Load from Supabase ────────────────────────────────────────────────────────

  const loadCases = useCallback(async () => {
    try {
      const loaded = await storage.loadCases();
      setCases(loaded);
    } catch (e) {
      console.warn('[loadCases]', e.message);
    }
  }, []);

  return {
    cases, setCases, activeCase, activeId, setActiveId,
    casesRef, updateCase, updateCases, createCase, deleteCase, loadCases,
  };
}
