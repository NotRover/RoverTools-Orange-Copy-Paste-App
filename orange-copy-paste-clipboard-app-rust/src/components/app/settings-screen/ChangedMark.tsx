import React from "react";

/** The yellow asterisk after a label whose setting is not at its default. */
export const ChangedMark: React.FC<{ show: boolean }> = ({ show }) =>
  show ? (
    <span
      className="set-mark"
      data-tooltip="Changed from the default"
      data-tooltip-pos="top"
      aria-label="Changed from the default"
    >
      *
    </span>
  ) : null;
