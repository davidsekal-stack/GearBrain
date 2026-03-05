# TransitDiag – Instalační příručka

## Požadavky

- [Node.js](https://nodejs.org) verze 18 nebo novější
- Připojení k internetu (pro AI diagnostiku)
- Anthropic API klíč (viz níže)

---

## Jak získat API klíč

1. Jděte na [console.anthropic.com](https://console.anthropic.com)
2. Zaregistrujte se nebo přihlaste
3. Vlevo klikněte na **API Keys**
4. Klikněte **Create Key**, pojmenujte ho např. "TransitDiag"
5. Klíč zkopírujte – zobrazí se jen jednou!

> Klíč je uložen **pouze lokálně** na vašem počítači v šifrovaném úložišti. Nikam se neodesílá.

---

## Instalace a spuštění (vývojový režim)

```bash
# 1. Rozbalte nebo naklonujte projekt
cd transitdiag

# 2. Nainstalujte závislosti
npm install

# 3. Spusťte v dev režimu (otevře se okno aplikace)
npm run dev
```

Při prvním spuštění vás aplikace vyzve k zadání API klíče.

---

## Sestavení instalačního balíčku

### Windows (.exe instalátor)
```bash
npm run build:win
```
Výsledek: `release/TransitDiag Setup 1.0.0.exe`

### macOS (.dmg)
```bash
npm run build:mac
```
Výsledek: `release/TransitDiag-1.0.0.dmg`

### Linux (.AppImage)
```bash
npm run build:linux
```
Výsledek: `release/TransitDiag-1.0.0.AppImage`

---

## Struktura projektu

```
transitdiag/
├── electron/
│   ├── main/index.js      ← Hlavní proces (API volání, storage)
│   └── preload/index.js   ← Bezpečný most renderer ↔ main
├── src/
│   ├── main.jsx           ← React vstupní bod
│   └── App.jsx            ← Celá aplikace
├── index.html
├── vite.config.js
└── package.json
```

---

## Náklady na API

Přibližná cena jedné diagnostiky (Claude Sonnet): **0,50–2 Kč**  
Při 10 diagnostikách denně: cca **300–600 Kč/měsíc**

Aktuální ceník: [anthropic.com/pricing](https://www.anthropic.com/pricing)

---

## Nastavení

V aplikaci klikněte na **⚙️ Nastavení** (vpravo nahoře) pro:
- Zobrazení/změnu API klíče
- Smazání API klíče

---

## Data aplikace

Případy a diagnostiky jsou uloženy lokálně na počítači:
- **Windows:** `%APPDATA%\transitdiag-data\`
- **macOS:** `~/Library/Application Support/transitdiag-data/`
- **Linux:** `~/.config/transitdiag-data/`
