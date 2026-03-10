import { Component } from "react";
import { DARK } from "../theme.js";

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    const t = DARK;
    return (
      <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: t.bg, fontFamily: "'IBM Plex Mono',monospace", padding: 40 }}>
        <div style={{ maxWidth: 500, textAlign: "center" }}>
          <div style={{ fontSize: "2rem", marginBottom: 16, opacity: 0.15 }}>🔧</div>
          <div style={{ fontFamily: "'Barlow Condensed',sans-serif", fontSize: "1.4rem", fontWeight: 700, color: "#dc2626", marginBottom: 12 }}>
            NEOČEKÁVANÁ CHYBA
          </div>
          <div style={{ fontSize: "0.82rem", color: t.textMuted, lineHeight: 1.7, marginBottom: 20 }}>
            Aplikace narazila na neočekávaný problém. Zkuste ji restartovat.
          </div>
          <div style={{ fontSize: "0.72rem", color: t.textFaint, background: t.bgCard, border: `1px solid ${t.border}`, padding: "10px 14px", borderRadius: 2, marginBottom: 20, textAlign: "left", wordBreak: "break-all" }}>
            {this.state.error?.message || "Neznámá chyba"}
          </div>
          <button
            onClick={() => window.location.reload()}
            style={{ background: t.accent, color: "#fff", border: "none", padding: "10px 24px", fontSize: "0.82rem", fontWeight: 700, cursor: "pointer", fontFamily: "inherit", borderRadius: 2 }}>
            ↺ RESTARTOVAT
          </button>
        </div>
      </div>
    );
  }
}
