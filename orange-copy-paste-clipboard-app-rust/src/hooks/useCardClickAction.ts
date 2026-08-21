import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * What a plain click on a clipboard card does.
 *
 * `"copy"` is the default and the historical behaviour: click copies, double
 * click opens the full view. `"view"` swaps the two, for people who browse
 * their history more than they re-copy from it.
 *
 * Clipboard only. A click on a note opens its editor, which is not the same
 * choice and does not get folded into this one.
 */
export type CardClickAction = "copy" | "view";

/** Fired on the document when Settings flips the preference, so open cards
 *  change behaviour without a remount. */
export const CARD_CLICK_SETTING_EVENT = "settings:card-click-changed";

export const CARD_CLICK_SETTING_KEY = "card_click_action";

export function useCardClickAction(): CardClickAction {
  const [action, setAction] = useState<CardClickAction>("copy");

  useEffect(() => {
    invoke<string | null>("get_setting", { key: CARD_CLICK_SETTING_KEY })
      .then((v) => setAction(v === "view" ? "view" : "copy"))
      .catch(() => setAction("copy"));
    const onChange = (e: Event) => {
      const next = (e as CustomEvent<CardClickAction>).detail;
      if (next === "copy" || next === "view") setAction(next);
    };
    document.addEventListener(CARD_CLICK_SETTING_EVENT, onChange);
    return () =>
      document.removeEventListener(CARD_CLICK_SETTING_EVENT, onChange);
  }, []);

  return action;
}
