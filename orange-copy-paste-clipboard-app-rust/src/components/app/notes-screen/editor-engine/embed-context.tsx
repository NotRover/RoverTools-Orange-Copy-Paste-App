// ── Embed context — supplies clipboard entries to Tiptap NodeViews ────────

import React, { createContext, useContext } from "react";
import type { ClipboardEntry } from "../../../../types";

interface EmbedCtx {
  entries: ClipboardEntry[];
}

const Ctx = createContext<EmbedCtx>({ entries: [] });

export const EmbedContextProvider: React.FC<{
  entries: ClipboardEntry[];
  children: React.ReactNode;
}> = ({ entries, children }) => (
  <Ctx.Provider value={{ entries }}>{children}</Ctx.Provider>
);

export function useEmbedContext(): EmbedCtx {
  return useContext(Ctx);
}
