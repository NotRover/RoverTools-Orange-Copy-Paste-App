import React from "react";
import {
  CloudCheck,
  CloudWarning,
  CloudArrowUp,
  CloudSlash,
  UserCircle,
} from "@phosphor-icons/react";
import type { AppScreen, AppTheme, SyncIndicator } from "../../../types";
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
  syncState: SyncIndicator;
  /** Received shared-space invites awaiting a response. */
  pendingInvites?: number;
  onNavigate: (screen: AppScreen) => void;
  onToggleTheme: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  screen,
  theme,
  syncState,
  pendingInvites = 0,
  onNavigate,
  onToggleTheme,
}) => {
  const spacesActive = screen === "spaces";

  // The icon carries the sync status, so each state has to be readable on its
  // own - a signed-out cloud that looks like every other inactive nav icon says
  // nothing, and reading "connected" with no account behind it is worse.
  const syncIcon =
    syncState === "connected" ? <CloudCheck   size={20} weight="duotone" /> :
    syncState === "syncing"   ? <CloudArrowUp size={20} weight="duotone" /> :
    syncState === "offline"   ? <CloudWarning size={20} weight="duotone" /> :
                                <CloudSlash   size={20} weight="regular"  />;

  // Status colour — suppressed while the Spaces screen is active, which has its
  // own active style. Signed out is deliberately muted rather than uncoloured:
  // no colour reads as "no status", and this is a status.
  const syncColor =
    spacesActive              ? undefined :
    syncState === "connected" ? "#22c55e" :
    syncState === "syncing"   ? "#3b82f6" :
    syncState === "offline"   ? "#f59e0b" :
                                "#6b7280";

  const syncTooltip =
    syncState === "connected" ? "Spaces - Synced" :
    syncState === "syncing"   ? "Spaces - Syncing..." :
    syncState === "offline"   ? "Spaces - Signed in, cannot reach the server" :
                                "Spaces - Not signed in";

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
        className={`nav-btn ${spacesActive ? "active" : ""} ${syncState === "syncing" ? "nav-btn--syncing" : ""}`}
        onClick={() => onNavigate("spaces")}
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
        className={`nav-btn ${screen === "account" ? "active" : ""}`}
        onClick={() => onNavigate("account")}
        data-tooltip="Account & Sync"
        data-tooltip-pos="right"
      >
        <UserCircle size={22} weight={screen === "account" ? "fill" : "regular"} />
        {pendingInvites > 0 && (
          <span className="nav-badge">
            {pendingInvites > 9 ? "9+" : pendingInvites}
          </span>
        )}
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
