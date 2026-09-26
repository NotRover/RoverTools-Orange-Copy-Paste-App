# Writing Docs

**Owns:** how we write and structure documentation in every RoverTools repo: the app
(this repo), the backend, and the website. It covers READMEs, the website docs, the
Developers section, in-app help text, error messages, the kinds of page, page shape,
style, and upkeep. The backend and website repos follow this file rather than keeping
their own copy.
**Not here:** where each fact lives, which is the "Docs & Source Priority" table in
`CLAUDE.md`. The banned-words and ASCII rules for copy are the "User-Facing Copy: No AI
Slop" section of `CLAUDE.md`. This guide adds to both and repeats neither.

Product details used as examples below (the 100-entry history, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd>
for quick paste) are real as of writing. Check them against the code before copying one
into a page.

---

## 1. How readers use docs

Write for how people actually read, not for how we wish they read.

- **They arrive from search, on any page.** Nobody reads docs front to back. Every page
  has to make sense to someone who landed on it cold: say what it covers in the first
  line, and link to anything it assumes.
- **They scan before they read.** Headings and pictures first, then examples, then prose
  only if the example was not enough. If they cannot find their answer in a minute or two,
  they leave.
- **They copy examples and expect them to work.** An example that fails costs trust in
  the whole product, not just the page.
- **Beginners and experienced users need different things.** Advanced material
  overwhelms a beginner. An experienced user still wants to find it.
- **They skip "What's new".** A new feature has to appear on the pages where people
  already look, not only in the release notes.

What readers come to docs for, used as a coverage check for any feature:

1. Is this the right tool for me?
2. How do I get started?
3. Which feature do I need, and does it apply to me?
4. What exactly does it do, and what are its limits?
5. Something went wrong. What does this error mean, and how do I fix it?
6. What changed, and do I need to do anything?

---

## 2. Every page is one of four kinds

Documentation serves four different needs. A page that tries to meet two of them does
both badly. Decide the kind before writing the first line.

| Kind | Reader's question | Reader is... | What it does | The page is... | Analogy |
|---|---|---|---|---|---|
| **Tutorial** | "Can you teach me to...?" | studying, by doing | introduce, lead | a lesson with a guaranteed result | teaching a child to cook |
| **How-to guide** | "How do I...?" | working, with a goal | guide | steps toward that goal | a recipe |
| **Reference** | "What is...?" | working, needs a fact | state, describe | dry, complete description | the label on a food packet |
| **Explanation** | "Why...?" | stepping back to understand | explain, discuss | a discussion with context | a book on the history of food |

There are exactly four because readers have exactly two needs, each in two modes. They
either need to **do** something or to **know** something, and they are either
**studying** (acquiring skill) or **working** (applying it).

### The compass: which kind is this?

When unsure, and especially when the answer seems obvious but the page feels wrong, ask
two questions:

1. Does it tell the reader what to **do** (action), or what to **know** (cognition)?
2. Does it serve someone **studying** (acquisition), or someone **working** (application)?

| | Studying | Working |
|---|---|---|
| **Doing** | Tutorial | How-to guide |
| **Knowing** | Explanation | Reference |

Apply the questions at every scale: a whole page, a section, a paragraph, a sentence.
Ask them several ways: "Am I writing for study or for work?", "Is this paragraph doing or
knowing?", "What does the reader need right now?"

### The three borders where kinds bleed

Neighbours in the grid share a trait, and that shared trait is how one kind leaks into
another. When a page reads awkwardly, check these first.

- **Tutorial and how-to** both give steps. This is the most common and most harmful
  mix-up. See "Tutorial or how-to?" below.
- **How-to and reference** both serve someone at work. A how-to that lists every option
  has turned into reference. Link to the list instead.
- **Reference and explanation** both hold knowledge. It usually goes wrong when a
  reference example grows into a "why" or a "what if". Keep the example short and move the
  discussion to an explanation page.

### Tutorial or how-to?

The difference is not basic versus advanced. A tutorial can teach something advanced, and
a how-to can cover something routine. The difference is whether the reader is studying or
working.

| Tutorial | How-to guide |
|---|---|
| The reader is learning, and may not yet know what to ask | The reader is working, and already knows what they want |
| A contrived, prepared setting | The real world, with whatever it throws at you |
| Removes the unexpected | Warns about the unexpected and says what to do |
| One line, no choices | Forks: "If this, then that" |
| Always safe, and you can start again | May be irreversible, so say so before the step |
| The writer is responsible if it goes wrong | The reader is responsible for their own setup |
| Explicit about basics: where to click, how long to wait | Assumes the basics |
| Specific, known tools and data | General, because each reader's case differs |

### Tutorials

A tutorial is a lesson. The reader's only job is to follow along. Everything else,
including whether they succeed, is the writer's job.

The exercise has to be:
- **meaningful**, so the reader feels they achieved something;
- **successful**, so the reader can actually finish it;
- **logical**, so the path makes sense;
- **usefully complete**, so the reader meets every action, concept and tool they will
  need.

The rules:

- **Don't teach. Let them do.** People learn by doing, not by being told. What the
  reader does is not the same as what they learn, and the learning takes care of itself
  if the doing is right.
- **Show the destination first.** "In this tutorial we will sync your clipboard between
  two computers." Never write "You will learn...". That promises what the reader takes
  away, which the writer does not control.
- **A visible result at every step,** however small, so the reader connects each action
  to what it caused.
- **Say what to expect.** "The popup opens at your cursor." "After a few seconds, the
  entry appears on the second computer." Show the actual output where there is one. Warn
  before surprises: "This takes about a minute the first time."
- **Name the signs of going wrong.** "If the entry does not appear, check that both
  computers are signed in to the same account."
- **Point at what to notice.** "Notice that the popup opened at your cursor, not in the
  middle of the screen." Readers busy following steps miss what the steps are showing
  them.
- **Make steps repeatable.** Readers repeat a step that worked just to see it work
  again, and that builds confidence. Prefer steps that can be undone, and make it
  possible to start over.
- **Keep a rhythm.** Tie each step's purpose to its action, so doing the tutorial feels
  like one continuous motion rather than a list of chores.
- **Explain almost nothing.** At most one sentence, then a link: "We sign in first
  because spaces belong to an account (see About spaces)." Explanation breaks the
  reader's focus at the moment they need it most.
- **Stay concrete.** This action, this result, then the next one. Readers pick out the
  general pattern from concrete examples on their own.
- **One path, no options.** Leave out alternatives and "you could also". They belong in
  how-to guides.
- **Aim for perfect reliability.** Every promised result has to appear, for every
  reader, every time. The writer is not there to rescue anyone. Test on a fresh machine
  and a fresh account, and watch someone else follow it, because you will not find every
  flaw yourself.
- **Re-walk the whole tutorial when the product changes.** A change to one step often
  breaks the steps after it.
- **Language:** "we"; "In this tutorial, we will..."; "First do x. Now do y. Now that
  you have done y, do z."; "The result should look like..."; "Notice that...", "Let's
  check..."; and at the end, "You have set up...", acknowledging what the reader built.

### How-to guides

A how-to is a recipe for a reader who knows what they want. Good how-tos are usually the
most-read pages, and the list of them tells people what the product can do.

- **Start from a goal the reader has, not from a screen we built.** "How to share
  clips with a teammate" answers a need. "Using the Spaces screen" walks the machinery
  through its motions and answers nothing. A how-to may cross several screens if the goal
  does.
- **Skip what any competent reader knows.** "To save, click Save" is not guidance. Say
  what they cannot guess: which option fits which situation, and what to watch for.
- **Title it as the task.**
  - Good: "How to share a clip with another person"
  - Weak: "Sharing clips"
  - Bad: "Spaces", which could be about how, whether, or what
  Precise titles are also what people type into search.
- **Keep the scope to one task.** "How to use sync" is a sphere of skill, not a task.
  "How to stop one device from syncing" is a task. Troubleshooting a specific problem is a
  task too.
- **Only the task.** No teaching, no history, no full option lists. Link out for those:
  "See the Settings reference for every option."
- **Handle real-world forks.** "If you use Wayland, do y instead." Real tasks branch,
  and some need the reader's judgement. Say what to weigh, not just what to press.
- **Warn before irreversible steps.** Say it before the step, not after.
- **Order for flow.** Put first whatever sets up the next step, even when either order
  works. Avoid sending the reader back and forth between screens, and don't make them
  hold a thought open for long before it pays off.
- **Start and stop where the task does.** Completeness is not the goal. Being usable in
  the reader's real situation is.
- **Language:** "This guide shows you how to..."; "If you want x, do y. To get w, do
  z."; "Refer to x for the full list."

### Reference

Reference describes the product. People consult it in the middle of work and need it to
be exact. It is organized by the product, not by what the reader is trying to do.

- **Describe, and only describe.** Neutral, austere facts. No instructions, no opinions,
  no marketing, no speculation. Link out for everything else. Describing *how something
  works* or *the correct way to use it* is fine. Walking through a task is not.
- **Complete, precise, authoritative.** List every option, default, limit, format and
  error message. No hedging and no ambiguity. Tutorials tell readers roughly what they
  can do, and reference tells them *exactly* what happens. Both are needed.
- **Mirror the product's structure.** Settings reference follows the Settings screen in
  the same order. The shortcuts page follows the hotkey list. Readers should be able to
  move through the docs and the product side by side. Mirroring also exposes gaps: a
  setting with no entry stands out.
- **Use one pattern for every entry,** so readers learn where to look. Reference is not
  the place to show off vocabulary or vary the style.
- **Examples illustrate, not instruct.** A short example of a value, a command or an
  output. Once an example starts explaining why, it has turned into explanation.
- **Every named concept gets an entry.** If a page says "space key" or "tombstone",
  there has to be a findable reference entry that defines it, with a title that says it
  is reference. A concept used everywhere but defined only inside a page titled like a
  guide is effectively undefined.
- **Generate it from the code where possible.** Generated reference stays true to the
  code and shows up in the editor too. Our Developers reference pages are generated from
  their homes for this reason.
- **Rules of thumb:** if it is boring and unmemorable, it is probably reference. Lists and
  tables of things are almost always reference.
- **Language:** "History keeps the last 100 entries."; "The options are: a, b, c.";
  "You must do a. Never do b. Do not use c unless d."

### Explanation

Explanation answers "why". It is read away from the product. It is the least urgent kind
and just as important as the others. Without it, readers' knowledge stays in fragments.

- **Bound it with a real "why" question.** "Why can't the server read my clips?" gives
  the page a start and an end. Without a question, explanation sprawls.
- **Title it so "About" fits in front:** "About end-to-end encryption", "About
  tombstones".
- **Give context.** Design decisions, history, constraints, and the alternatives we
  turned down. Our design decision records are explanation.
- **Opinions are allowed here.** "W is better than z, because...", "Some prefer w. That
  can work, but...". Weigh the alternatives honestly.
- **Circle the subject.** Come at it from several angles, and make connections, even to
  things outside the immediate topic.
- **Gather it.** Explanation tends to be scattered in small asides across other pages.
  Collect it into its own page and link to it from those places.
- **Keep instructions and specs out.** They creep in when the writer tries to cover the
  topic fully. Link to the how-to and the reference instead.
- **Tests:** could you read it away from the computer? Is it the answer a colleague gives
  when asked "Can you tell me about...?" If yes, it is explanation.
- **Language:** "The reason for x is that, historically, y..."; "x is like w, except...";
  "An x interacts with a y as follows:...".

---

## 3. Page craft

- **Guide first.** A reader's first contact with a feature is a short, beginner-friendly
  example of its most common use. Reading only the guides should be enough to start.
- **One page template per kind of page,** applied everywhere. For a feature page:
  1. a one-sentence summary
  2. a screenshot or short clip
  3. the common use, shown
  4. the options
  5. one example per option
  6. advanced use and how-tos
  7. related pages
- **Feature pages hold typed sections.** Organizing docs purely around product features,
  with no idea of what each section is for, produces inconsistent pages. A feature page is
  fine as a container, but every section in it is one of the four kinds. A guide section
  and a reference section can share a page as long as each is distinct and labeled. A
  single section never mixes kinds.
- **Show, don't tell.** Put screenshots and short screencasts early. They are the most
  expensive thing to produce and the most valuable thing to read. Retake them when the
  UI changes, because a stale screenshot is a wrong fact. Never capture real user data.
  Use invented content, or the website's `oc-*` mockups.
- **More example than prose.** Many readers skip the paragraphs. For developer docs,
  code carries the page. For user docs, the equivalent is the exact button label, the
  exact shortcut, and exactly what appears on screen.
- **Plausible data, never placeholders.** No `foo`, no lorem ipsum, no "Test entry 1".
  Use realistic clipboard contents, note titles and space names. The reader should not
  have to translate the example into their own world.
- **Examples must work as written.** Test every command and code block. Where possible,
  build the example from something that runs, so the example and its screenshot come from
  the same source. Start with the simple example; add complex ones after.
- **Scannable.** No section of prose longer than about half a screen. Break it with
  headings, lists, tables, code and callouts.
- **Overview pages for groups of features.** Before a group of related pages, give one
  page that names the concepts, defines the terms and helps the reader choose between
  them.
- **A path forward.** End pages with what to read next.
- **A beginner path.** Keep the advanced material out of the way of a first read. Put it
  in its own sidebar group, or under a clear "Advanced" heading at the bottom of a page.
- **Never create empty structure.** No placeholder pages, no empty "Tutorials" section
  waiting for content. Structure comes from real pages.

### Findability

- **Say the words people search for.** Where a feature has a common other name, say it
  once in prose ("Spaces, sometimes called shared clipboards"). The product itself uses
  **one canonical name** in the UI, in headings and in reference, and synonyms appear only
  as "also called" hints. Two names in the UI makes people wonder whether they are two
  things.
- **Mention a feature wherever a reader might need it, then link.** People find
  features by coming across them on other pages. Mention it with a sentence and a link,
  never by restating the details.
- **Link generously.** Concept names link to their reference entry. Reference links to
  the how-to. How-to links back to reference. A tutorial's one-line explanations link to
  the explanation page. Every page has a way onward.

---

## 4. Special surfaces

### READMEs

A README is a front door (see `CLAUDE.md`). Beyond that:

- Answer, in this order: **what it is and why it exists, how to install it, how to do
  the first real thing.** People leave at whichever of these is missing.
- Show it: one screenshot or GIF near the top.
- Keep it short. Anything longer than orientation goes to a link on the website.
- Link to `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` and `SECURITY.md` rather than restating
  them.

### Error messages and in-app text

These are documentation too, and often the only docs a user reads.

- An error says what happened and what to do next, in the interface's voice. It never
  apologizes and is never vague.
- An empty state says what the screen is for and how to put something in it.
- An action keeps one name through the whole flow: a `Share` button produces a "Shared"
  confirmation, not "Sent".
- Every error a user can see has an entry in a troubleshooting page, with the fix.

### Changes that affect users

- When behavior changes, the docs say **what the user has to do about it**, not just
  what changed. An upgrade that breaks someone's setup with no guidance is the worst
  docs failure there is.
- A new feature gets mentioned on the existing pages where people will look for it, not
  only in the release notes.

---

## 5. Style for every page

The No AI Slop rules in `CLAUDE.md` still apply. These rules add to them:

- **Write from the reader's side.** Name what the reader sees and controls, not how the
  system is built. Say "the Spaces screen", not "the spaces router".
- **Use the exact UI string.** When a page refers to a button or setting, use its label
  as it appears on screen, set in code style. If the UI changes, the docs change with it.
- **Respect the reader.** Explain simple things without talking down. A reader should
  never feel stupid, and never feel lectured.
- **Be specific.** Give the number, the path, the shortcut. "Keeps the last 100
  entries" beats "keeps a lot of history".
- **Use active voice and the imperative in steps.** "Open Settings." "Press
  <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd>."
- **One job per element.** A heading labels. An example demonstrates. A callout warns.
  Nothing does double duty.
- **Too long beats nothing.** An accurate page that is imperfect is better than no page.
  Ship it, then improve it.

---

## 6. Keeping docs true

- **Docs change in the same PR as the behavior.** A change to a feature, setting,
  shortcut, route, payload or error updates its doc home in the same commit.
- **Every support question is a docs bug.** When someone asks something the docs should
  have answered, fix the page. Then answer with a link to it.
- **Read with fresh eyes.** You cannot see what you know without knowing it. Ask a new
  user what confused them, and ask an experienced one what they wish they had known on
  day one.
- **Use our own docs.** Follow a tutorial on a clean machine and a clean account, and
  follow a how-to exactly as written. Fix what trips you up.
- **Re-read whole sections on a schedule.** Fixes made one page at a time let a section
  drift. Re-read each section start to finish now and then.
- **Improve in small steps.** Don't plan a top-down restructure, and don't tear it all
  down to start over. Loop instead:
  1. **Choose** whatever is in front of you: the page you are on, or the last one you
     read. There is no need to hunt for the worst problem. Smaller is better: a page, a
     paragraph, a sentence.
  2. **Assess** it. What reader need does it serve? How well? Do its language and logic
     fit its kind? What should be added, moved, removed or changed?
  3. **Decide** the single next change that would improve it.
  4. **Do** it, commit it, and start again.

  Commit each improvement on its own rather than saving up a big batch. Structure then
  forms from the inside: at some point the improved pages will make it obvious that
  material belongs under a new heading, and that is when the heading gets created. Docs
  are never finished, but they should be complete at every step: useful, accurate, and
  right for the product as it is today.
- **Expect cleanup to expose gaps.** Moving explanation out of a tutorial often reveals
  a step the reader was left to work out alone. Mirroring reference to the product
  reveals missing entries. Fix what shows up.

### Two bars for quality

- **Functional quality** is objective and can be checked against the product:
  accurate, complete, consistent, precise, useful. Each is independent: a page can be
  accurate and incomplete, or complete and useless. Readers notice every lapse.
- **Deep quality** can only be judged: it feels good to use, it flows, it fits what the
  reader needs, and it anticipates the next question, like a helper handing you the
  tool you were about to reach for.
- Deep quality depends on functional quality. Nobody enjoys a page that is wrong. Sorting
  pages into the four kinds sets up deep quality but does not produce it. Good design,
  judgement and care still have to do that.

---

## 7. Which kind each doc surface holds

Doc pages live in the website repo under `src/content/docs/docs/`.

| Surface | Where | Kinds it should hold |
|---|---|---|
| READMEs | root of each repo | Front door only (section 4) |
| Start here | `index.mdx`, `getting-started.mdx` | Overview, plus **the tutorial**: install, then the first capture and paste |
| Using the app | `clipboard-history`, `quick-paste`, `notes`, `settings`, `shortcuts` | Feature pages that combine guide and reference sections (section 3). Shortcuts and Settings are pure reference that mirrors the UI |
| Sync and sharing | `cloud-sync`, `spaces`, `security` | How-to guides for the tasks, reference for the limits, and an "About" explanation for security |
| More | `linux`, `updates`, `faq` | How-to guides, and a FAQ that links to its answers rather than holding them |
| Developers | `developers/` (Concepts, Guides, Reference, design records) | Concepts are explanation. Self-hosting and Contributing are how-to. Reference is the generated mirrors. Design records are explanation |
| In-app help text, empty states, errors | app repo, `src/` | Section 4 and section 5, plus the `CLAUDE.md` copy rules |
| Release notes | app repo, `changelog/` | Reference, written as user-facing copy, including what users must do |
| Web pages and emails | backend repo, `src/web/templates/`, `src/email.py` | Section 4 and section 5, plus the `CLAUDE.md` copy rules |

Questions to ask when reviewing a section:

- Do the feature pages keep their guide and reference sections distinct, or do they
  blend?
- Are the how-tos written around reader goals, with task-shaped titles?
- Is there a findable reference definition for every concept a page leans on, such as
  space, space key, device, sync mode, pinned, and tombstone?
- Does every step list give the exact UI label and show the expected result?
- Does every error a user can see have a documented fix?
- Are the screenshots current, and do they sit near the top of the page?
- Do the examples use plausible data?
- Does "Install and first run" work, step by step, on a fresh machine?

---

## 8. Checklist before merging a doc change

- [ ] Every page and section is one kind and does only that kind's job.
- [ ] The first line says what the page covers, so it works for a reader who lands from
      search.
- [ ] Tutorial: one path, a visible result at each step, the signs of going wrong named,
      and tested on a fresh machine.
- [ ] How-to: built around a reader's goal, titled as the task, contains only steps,
      warns before irreversible steps, and links out for options.
- [ ] Reference: complete, neutral and consistent, and follows the product's structure.
- [ ] Explanation: answers a real "why", gives context and alternatives, has no steps.
- [ ] UI labels are exact, and every number, path and shortcut was checked against the
      code.
- [ ] Examples use plausible data and were run.
- [ ] Screenshots, if any, match the current UI, sit near the top, and show no real
      user data.
- [ ] No prose section runs longer than about half a screen.
- [ ] New concepts link to their reference entry, and the page ends with where to go
      next.
- [ ] A behavior change says what users have to do.
- [ ] Nothing restates a fact that has a home elsewhere; it links there instead.
- [ ] The copy rules in `CLAUDE.md` pass: ASCII only, no stock words, no section sign.
