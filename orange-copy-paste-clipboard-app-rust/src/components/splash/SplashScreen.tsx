import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./splash.css";

type Phase = "idle" | "in" | "ready" | "out";
type Theme = "dark" | "light";

function getTheme(): Theme {
  return (localStorage.getItem("sc-theme") as Theme) ?? "dark";
}

// Public-folder SVGs: theme-matched logo variants
const LOGO_LIGHT_MODE = encodeURI("/Smart Clipboard Logo.svg");      // white logo — on light bg
const LOGO_DARK_MODE  = encodeURI("/Smart Clipboard Logo Dark.svg"); // dark logo  — on dark bg

const SplashScreen: React.FC = () => {
  const [phase, setPhase] = useState<Phase>("idle");
  const [theme] = useState<Theme>(getTheme);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setPhase("in"));

    const t1 = setTimeout(() => setPhase("ready"), 800);

    const t2 = setTimeout(() => {
      setPhase("out");
      // Pass clicks through immediately while the exit animation plays.
      // Rust closes the actual window at 2600 ms.
      getCurrentWindow().setIgnoreCursorEvents(true).catch(() => {});
    }, 2050);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t1);
      clearTimeout(t2);
    };
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
            <img
              className="splash-logo-img"
              src={logoSrc}
              alt=""
              draggable={false}
            />
          </div>

          <div className="splash-brand">
            <span className="splash-name">Orange Copy Paste</span>
            <span className="splash-tagline">Smart Clipboard</span>
          </div>
        </div>

        <div className="splash-divider" />

        <div className="splash-footer">
          <span className="splash-indicator" data-ready={String(isReady)} />
          <span className="splash-status-text" data-ready={String(isReady)}>
            {isReady ? (
              <>
                Running in background
                <span className="splash-check" data-visible="true"> ✓</span>
              </>
            ) : (
              <>
                Starting up
                <span className="splash-dots">
                  <span>.</span><span>.</span><span>.</span>
                </span>
              </>
            )}
          </span>
        </div>
      </div>

      <div className="splash-progress">
        <div className="splash-progress-bar" />
      </div>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById("root")!).render(<SplashScreen />);
