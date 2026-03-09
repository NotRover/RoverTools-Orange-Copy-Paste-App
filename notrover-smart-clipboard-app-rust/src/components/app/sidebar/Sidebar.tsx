import React from "react";
import type { AppScreen, AppTheme } from "../../../types";
import {
  ClipboardIcon,
  SearchIcon,
  KeyboardIcon,
  SunIcon,
  MoonIcon,
  GearIcon,
} from "../../icons";
import "./Sidebar.css";

interface SidebarProps {
  screen: AppScreen;
  theme: AppTheme;
  onNavigate: (screen: AppScreen) => void;
  onToggleTheme: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  screen,
  theme,
  onNavigate,
  onToggleTheme,
}) => (
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
        className={`nav-btn ${screen === "search" ? "active" : ""}`}
        onClick={() => onNavigate("search")}
        data-tooltip="Search"
        data-tooltip-pos="right"
      >
        <SearchIcon size={18} />
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

export default Sidebar;
