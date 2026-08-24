type NoteSection = { title: string | null; items: string[] };
export type ParsedNotes = { lead: string | null; sections: NoteSection[] };

/** Notes arrive as a release's changelog body: an optional lead sentence, then
    `### New` / `### Improved` / `### Fixed` sections of `-` bullets. Parse that shape
    into a lead line plus titled sections.

    Older releases shipped a flat bulleted list with no headings - those parse to a
    single title-less section and render as a plain list, so an old install updating
    past this change still reads cleanly.

    Shared by the update banner and the Settings updates card so both render the same
    way instead of one dumping raw markdown. */
export const parseNotes = (raw: string): ParsedNotes => {
  const lead: string[] = [];
  const sections: NoteSection[] = [];
  let current: NoteSection | null = null;

  for (const line of raw.split("\n").map((l) => l.trim())) {
    if (!line) continue;
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      current = { title: heading[1].trim(), items: [] };
      sections.push(current);
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      if (!current) {
        current = { title: null, items: [] };
        sections.push(current);
      }
      current.items.push(bullet[1].trim());
      continue;
    }
    // Plain text: a lead sentence before any section, otherwise a stray line folded
    // into the section it sits under.
    if (current) current.items.push(line);
    else lead.push(line);
  }

  return {
    lead: lead.length ? lead.join(" ") : null,
    sections: sections.filter((s) => s.items.length > 0),
  };
};

/** Whether parsed notes have anything worth showing. */
export const hasParsedNotes = (n: ParsedNotes): boolean =>
  n.lead !== null || n.sections.length > 0;
