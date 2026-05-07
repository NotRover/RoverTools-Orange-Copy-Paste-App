import React from "react";
import { Cloud, CloudCheck, CloudWarning } from "@phosphor-icons/react";
import type { AppScreen, AppTheme } from "../../../types";
import {
  ClipboardIcon,
  NotesIcon,
  KeyboardIcon,
  SunIcon,
  MoonIcon,
  GearIcon,
} from "../../icons";
import "./Sidebar.css";

interface SidebarProps {
  screen: AppScreen;
  theme: AppTheme;
  syncConnected: boolean | null;
  onNavigate: (screen: AppScreen) => void;
  onToggleTheme: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  screen,
  theme,
  syncConnected,
  onNavigate,
  onToggleTheme,
}) => {
  const syncActive = screen === "sync";

  const syncIcon =
    syncConnected === true  ? <CloudCheck   size={20} weight="duotone" /> :
    syncConnected === false ? <CloudWarning size={20} weight="duotone" /> :
                              <Cloud        size={20} weight="regular"  />;

  const syncColor =
    syncActive               ? undefined :
    syncConnected === true   ? "#22c55e" :
    syncConnected === false  ? "#f59e0b" :
    undefined;

  const syncTooltip =
    syncConnected === true  ? "Sync & Groups · Connected" :
    syncConnected === false ? "Sync & Groups · Offline" :
                              "Sync & Groups";

  return (
  <aside className="sidebar">
    {/* Logo */}
    <div className="sidebar-logo">
      <img
        src={
          theme === "dark"
            ? "/Smart Clipboard Logo Dark.svg"
            : "/Smart Clipboard Logo.svg"
        }
        width="30"
        height="30"
        alt="Orange Copy Paste"
      />
    </div>

    <hr className="sidebar-divider" />

    {/* Top nav */}
    <nav className="sidebar-nav">
      <button
        className={`nav-btn ${screen === "clipboard" ? "active" : ""}`}
        onClick={() => onNavigate("clipboard")}
        data-tooltip="Clipboard"
        data-tooltip-pos="right"
      >
        <ClipboardIcon />
      </button>
      <button
        className={`nav-btn ${screen === "notes" ? "active" : ""}`}
        onClick={() => onNavigate("notes")}
        data-tooltip="Notes"
        data-tooltip-pos="right"
      >
        <NotesIcon />
      </button>
      <button
        className={`nav-btn ${syncActive ? "active" : ""}`}
        onClick={() => onNavigate("sync")}
        data-tooltip={syncTooltip}
        data-tooltip-pos="right"
        style={syncColor ? { color: syncColor } : undefined}
      >
        {syncIcon}
      </button>
      <button
        className={`nav-btn ${screen === "shortcuts" ? "active" : ""}`}
        onClick={() => onNavigate("shortcuts")}
        data-tooltip="Shortcuts"
        data-tooltip-pos="right"
      >
        <KeyboardIcon />
      </button>
    </nav>

    {/* Bottom actions */}
    <div className="sidebar-bottom">
      <button
        className="nav-btn"
        onClick={onToggleTheme}
        data-tooltip={theme === "dark" ? "Light mode" : "Dark mode"}
        data-tooltip-pos="right"
      >
        {theme === "dark" ? <SunIcon /> : <MoonIcon />}
      </button>

      <button
        className={`nav-btn ${screen === "settings" ? "active" : ""}`}
        onClick={() => onNavigate("settings")}
        data-tooltip="Settings"
        data-tooltip-pos="right"
      >
        <GearIcon />
      </button>
    </div>
  </aside>
  );
};

export default Sidebar;
