// ── Utility functions for notes processing and formatting ──────────────────

import { classifyFileEntry, filePaths, truncateText } from "../../../types";

export function stripHtml(html: string): string {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return tmp.textContent ?? tmp.innerText ?? "";
}

export function plainNoteText(html: string): string {
  return stripHtml(html)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function deriveNoteTitle(rawTitle: string, contentHtml: string): string {
  const fromTitle = rawTitle.trim();
  if (fromTitle) return fromTitle;

  const fromContent = plainNoteText(contentHtml);
  if (fromContent) return truncateText(fromContent, 54);

  return "New note";
}

export function hasMeaningfulContent(contentHtml: string): boolean {
  return plainNoteText(contentHtml).length > 0;
}

export function isNoteExpandable(note: { content: string }): boolean {
  return plainNoteText(note.content).length > 180;
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

// Sanitize note preview HTML for display in card grid
export function sanitizeNotePreviewHtml(
  html: string,
  entries: any[] = [],
): string {
  const template = document.createElement("template");
  template.innerHTML = html;

  // Keep card previews compact by rendering note embeds as small chips.
  template.content.querySelectorAll("[data-clip-embed]").forEach((el) => {
    const embedId = el.getAttribute("data-clip-embed") ?? "";
    const chip = document.createElement("span");
    chip.className = "ns-preview-embed-chip";

    const entry = entries.find((e) => e.id === embedId);
    if (entry) {
      const paths = entry.type === "file" ? filePaths(entry.content) : [];
      const fileKind =
        entry.type === "file" ? classifyFileEntry(entry.content) : "file";
      const label =
        entry.type === "image"
          ? (entry.label ?? "Image")
          : entry.type === "file"
            ? fileKind === "image"
              ? "Image file"
              : paths[0]
                ? fileName(paths[0])
                : "File"
            : truncateText(
                (entry.type === "html"
                  ? stripHtml(entry.content)
                  : entry.content
                )
                  .replace(/\s+/g, " ")
                  .trim(),
                28,
              ) || "Clip";
      chip.textContent = label;
    } else if (embedId) {
      chip.textContent = "Missing clip";
      chip.classList.add("ns-preview-embed-chip--missing");
    } else {
      chip.textContent = "Clip";
    }
    el.replaceWith(chip);
  });

  template.content.querySelectorAll("[data-group-ref]").forEach((el) => {
    const group = el.getAttribute("data-group-ref") ?? "Group";
    const chip = document.createElement("span");
    chip.className = "ns-preview-group-chip";
    chip.textContent = `#${group}`;
    el.replaceWith(chip);
  });

  template.content
    .querySelectorAll("script, style, iframe, object, embed, link, meta")
    .forEach((el) => el.remove());

  template.content.querySelectorAll("*").forEach((el) => {
    [...el.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();

      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
        return;
      }

      if (
        (name === "href" || name === "src") &&
        /^\s*javascript:/i.test(value)
      ) {
        el.removeAttribute(attr.name);
      }
    });
  });

  return template.innerHTML;
}
