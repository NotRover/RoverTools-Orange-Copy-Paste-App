// ── Tiptap node — Callout ────────────────────────────────────────────────
// A block container with a tonal style (info/success/warning/danger/neutral).
// Renders as <div data-callout="<tone>"> and accepts arbitrary block content
// (paragraphs, lists, headings, etc.).

import { Node, mergeAttributes } from "@tiptap/core";

export type CalloutTone = "info" | "success" | "warning" | "danger" | "neutral";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    callout: {
      setCallout: (tone?: CalloutTone) => ReturnType;
      toggleCallout: (tone?: CalloutTone) => ReturnType;
      unsetCallout: () => ReturnType;
    };
  }
}

export interface CalloutOptions {
  HTMLAttributes: Record<string, string>;
}

export const Callout = Node.create<CalloutOptions>({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,

  addOptions() {
    return { HTMLAttributes: {} };
  },

  addAttributes() {
    return {
      tone: {
        default: "info",
        parseHTML: (el) => el.getAttribute("data-callout") ?? "info",
        renderHTML: (attrs) => ({ "data-callout": attrs.tone ?? "info" }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-callout]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        class: "ee-callout",
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setCallout:
        (tone) =>
        ({ commands }) =>
          commands.wrapIn(this.name, { tone: tone ?? "info" }),
      toggleCallout:
        (tone) =>
        ({ commands, editor }) => {
          if (editor.isActive(this.name)) return commands.lift(this.name);
          return commands.wrapIn(this.name, { tone: tone ?? "info" });
        },
      unsetCallout:
        () =>
        ({ commands }) =>
          commands.lift(this.name),
    };
  },
});
