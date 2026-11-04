import React, { useEffect, useRef } from "react";
import "./ToastNotification.css";

// Types 
interface ToastAction {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
}

interface ToastNotificationProps {
  /** Main message text shown in the toast. */
  message: string;
  /** Optional icon rendered to the left of the message. */
  icon?: React.ReactNode;
  /** Optional action button (e.g. "Undo"). */
  action?: ToastAction;
  /**
   * How long (ms) before the toast auto-dismisses.
   * The progress bar depletes in sync with this value.
   * Pass 0 to show indefinitely (no bar).
   * @default 5000
   */
  duration?: number;
  /** Called once the timer expires. Use to hide the toast from the parent. */
  onDismiss?: () => void;
}

// Component 

const ToastNotification: React.FC<ToastNotificationProps> = ({
  message,
  icon,
  action,
  duration = 5000,
  onDismiss,
}) => {
  // Fire onDismiss after the timer, if one is set.
  //
  // The callback is read through a ref so the timer is armed once per mount.
  // Parents pass an inline closure, which is a new function on every render,
  // and a timer keyed on it restarted each time the app re-rendered - while
  // the bar, a CSS animation on an element that never remounts, kept draining.
  // The toast then outlived its own bar by however long the app stayed busy.
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  useEffect(() => {
    if (!duration) return;
    const id = setTimeout(() => onDismissRef.current?.(), duration);
    return () => clearTimeout(id);
  }, [duration]);

  return (
    <div className="toast" role="status" aria-live="polite">
      {/* Message row */}
      <span className="toast-msg">
        {icon && <span className="toast-icon">{icon}</span>}
        {message}
      </span>

      {/* Action button */}
      {action && (
        <button className="toast-action-btn" onClick={action.onClick}>
          {action.icon}
          {action.label}
        </button>
      )}

      {/* Timer bar — hidden when duration is 0 */}
      {duration > 0 && (
        <div
          className="toast-bar"
          style={{ animationDuration: `${duration}ms` }}
        />
      )}
    </div>
  );
};

export default ToastNotification;
