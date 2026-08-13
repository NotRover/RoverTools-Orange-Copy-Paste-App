import React from "react";
import { WarningIcon } from "./icons";
import { useHealthWarning } from "../hooks/useHealthWarning";
import "./DegradedPill.css";

/**
 * Compact "not saving" marker for the popup windows.
 *
 * The main window gets a full banner with a restart button; a popup is a
 * half-second surface where that would be both too loud and the wrong place to
 * offer a restart. What a popup owes the user is the honest fact that what they
 * are copying is not being written down — the detail sits in the tooltip.
 *
 * Renders nothing while the process is healthy.
 */
export const DegradedPill: React.FC<{ className?: string }> = ({ className }) => {
  const health = useHealthWarning();
  if (!health) return null;

  const detail =
    health.kind === "degraded"
      ? "History and notes are not being saved — restart the app from the main window."
      : "History and notes may not be saving. If it does not pick up again on its own, restart from the main window.";

  return (
    <span
      className={`degraded-pill${className ? ` ${className}` : ""}`}
      role="status"
      title={`${health.reason}. ${detail}`}
    >
      <WarningIcon size={10} />
      Not saving
    </span>
  );
};

export default DegradedPill;
