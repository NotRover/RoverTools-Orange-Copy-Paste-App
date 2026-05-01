import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./splash.css";

// ── Timer config ──────────────────────────────────────────────────────────
const READY_AT_MS  = 1100;  // when status switches to "Running in background"
const FADE_AT_MS   = 2700;  // when exit fade starts  (keep ≥ READY_AT_MS + 200)
// Rust closes the window at 3200 ms (lib.rs) — keep that > FADE_AT_MS + 400
// ─────────────────────────────────────────────────────────────────────────

type Phase = "idle" | "in" | "ready" | "out";
type Theme = "dark" | "light";

function getTheme(): Theme {
  return (localStorage.getItem("sc-theme") as Theme) ?? "dark";
}

const LOGO_LIGHT_MODE = encodeURI("/Smart Clipboard Logo.svg");
const LOGO_DARK_MODE  = encodeURI("/Smart Clipboard Logo Dark.svg");

const SplashScreen: React.FC = () => {
  const [phase, setPhase] = useState<Phase>("idle");
  const [theme]           = useState<Theme>(getTheme);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setPhase("in"));
    const t1  = setTimeout(() => setPhase("ready"), READY_AT_MS);
    const t2  = setTimeout(() => {
      setPhase("out");
      getCurrentWindow().setIgnoreCursorEvents(true).catch(() => {});
    }, FADE_AT_MS);

    return () => { cancelAnimationFrame(raf); clearTimeout(t1); clearTimeout(t2); };
  }, []);

  const isReady = phase === "ready";
  const logoSrc = theme === "dark" ? LOGO_DARK_MODE : LOGO_LIGHT_MODE;

  return (
    <div className="splash" data-theme={theme} data-phase={phase}>
      <div className="splash-content">
        <div className="splash-header">
          <div className="splash-logo">
            <div className="splash-ring-outer" />
            <div className="splash-ring" />
            <img className="splash-logo-img" src={logoSrc} alt="" draggable={false} />
          </div>
          <div className="splash-brand">
            <span className="splash-name">Orange Copy Paste</span>
            <span className="splash-tagline">Smart Clipboard</span>
          </div>
        </div>

        <div className="splash-footer">
          <span className="splash-indicator" data-ready={String(isReady)} />
          <span className="splash-status-text" data-ready={String(isReady)}>
            {isReady ? "Running in background" : (
              <>Starting up<span className="splash-dots"><span>.</span><span>.</span><span>.</span></span></>
            )}
          </span>
        </div>
      </div>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById("root")!).render(<SplashScreen />);
