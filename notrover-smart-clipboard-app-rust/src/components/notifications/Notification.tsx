import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AppTheme } from "../../types";
import { readTheme } from "../../types";
import { ClipboardIcon, ClipboardPasteIcon } from "../icons";
import "./notification.css";

const DISMISS_MS = 2500;
const FADE_MS = 250;

const KIND_LABELS: Record<string, string> = {
  text: "Text",
  image: "Image",
  file: "File",
  html: "Rich Text",
};

const Notification: React.FC = () => {
  const [visible, setVisible] = useState(false);
  const [kind, setKind] = useState("text");
  const [action, setAction] = useState("Copied");
  const [theme, setTheme] = useState<AppTheme>(readTheme);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "sc-theme") setTheme((e.newValue as AppTheme) ?? "dark");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    listen<{ kind: string; action: string }>("notification:show", (event) => {
      if (cancelled) return;
      setKind(event.payload.kind);
      setAction(event.payload.action ?? "Copied");
      setTheme(readTheme());

      // Reset animation
      setVisible(false);
      requestAnimationFrame(() => setVisible(true));

      // Auto-dismiss
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setVisible(false);
        // Wait for fade-out transition before hiding the window
        setTimeout(() => {
          invoke("close_notification").catch(() => {});
        }, FADE_MS);
      }, DISMISS_MS);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
      unlisten?.();
    };
  }, []);

  return (
    <div
      className={`cn-container${visible ? " cn-visible" : ""}`}
      data-theme={theme}
    >
      {action === "Pasted" ? <ClipboardPasteIcon size={14} /> : <ClipboardIcon size={14} />}
      <span className="cn-label">{action}</span>
      <span className="cn-dot">&middot;</span>
      <span className="cn-kind">{KIND_LABELS[kind] ?? kind}</span>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <Notification />,
);
