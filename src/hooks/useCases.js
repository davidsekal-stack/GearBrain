import { useState, useCallback, useRef, useEffect } from "react";
import { uid } from "../lib/utils.js";
import { EMPTY_VEHICLE } from "../constants/index.js";

const store = {
  get: (key) => window.electronAPI.storage.get(key),
  set: (key, value) => window.electronAPI.storage.set(key, value),
};
const SESSIONS_KEY = "gearbrain_sessions";

export default function useCases() {
  const [cases, setCases] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const casesRef = useRef(cases);
  useEffect(() => { casesRef.current = cases; }, [cases]);

  const activeCase = cases.find((c) => c.id === activeId) ?? null;

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

  // ── CRUD ────────────────────────────────────────────────────────────────────
  const createCase = useCallback((vehicle) => {
    const id = uid();
    const name = vehicle.model
      ? vehicle.model.split(" ").slice(0, 3).join(" ") + (vehicle.mileage ? ` · ${Number(vehicle.mileage).toLocaleString("cs-CZ")} km` : "")
      : "Nový případ";
    updateCases((prev) => [{ id, name, status: "rozpracovaný", createdAt: new Date().toISOString(), closedAt: null, vehicle, messages: [], resolution: null, tokenCount: 0 }, ...prev]);
    setActiveId(id);
    return id;
  }, [updateCases]);

  const deleteCase = useCallback((id) => {
    updateCases((prev) => prev.filter((c) => c.id !== id));
    if (activeId === id) setActiveId(null);
  }, [activeId, updateCases]);

  // ── Init ────────────────────────────────────────────────────────────────────
  const loadCases = useCallback(async () => {
    const saved = await store.get(SESSIONS_KEY);
    if (saved) { try { setCases(JSON.parse(saved)); } catch (_) {} }
  }, []);

  return {
    cases, setCases, activeCase, activeId, setActiveId,
    casesRef, updateCase, updateCases, createCase, deleteCase, loadCases,
  };
}
