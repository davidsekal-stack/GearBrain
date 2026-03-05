/** Generuje unikátní 8-znakové ID */
export const uid = () => Math.random().toString(36).slice(2, 10);

/** Formátuje ISO timestamp do cs-CZ: "DD.MM. HH:MM" */
export const fmtDate = (iso) => {
  const d = new Date(iso);
  return (
    d.toLocaleDateString("cs-CZ", { day: "2-digit", month: "2-digit" }) +
    " " +
    d.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" })
  );
};

/** Barva levého pruhu / progress baru závady podle naléhavosti */
export const urgColor = (u) =>
  ({ kritická: "#dc2626", vysoká: "#1a3c6e", střední: "#d97706" }[u] ?? "#16a34a");

/** Formátuje nájezd jako lokalizované číslo s jednotkou */
export const fmtMileage = (km) =>
  km ? `${Number(km).toLocaleString("cs-CZ")} km` : "";
