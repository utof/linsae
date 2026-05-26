# v21 — Design System

> **v21** is a personal note-taking app for technical material — math lectures, papers, PDFs, ink. This design system covers v0 of the product, which lands the user inside a **linear, chronological timeline of notes** (a Telegram-style feed of one's own thinking) on top of a clean, Figma-influenced neutral palette.

## What this system is for

- High-fidelity mocks and prototypes of v21 surfaces — the chronological feed, the daily inbox, the open-questions inbox, the editor, the command palette.
- Brand-faithful slides, marketing one-pagers, and screenshots.
- A floor of components other designers / coding agents can lean on without re-deriving the type scale, spacing rhythm, or color semantics.

## Source materials

This system was designed **from a single written design brief** (no Figma, no codebase, no prior product). The brief is the multi-page positions doc shared in chat — a defended specification covering:

- The data model (block + supertag, three thought types, three tag fields, six typed edges)
- The shell architecture (daily-note landing, three-column shell, command palette)
- The capture/revisit philosophy (Marshall–Shipman incremental formalisation; collector's-fallacy countermeasures)
- The cognitive-science backing (retrieval practice, desirable difficulties, self-explanation, open learner models)

The brief is reproduced verbatim at the bottom of this file under **APPENDIX: design brief**, in case the reader of this system needs to revisit primary intent.

**The v0 scope this system targets:** the *linear chronological view* — daily notes as the landing page, with blocks captured into a temporally-ordered feed. Trajectory dashboards, canvas, ink, and AI side-panels are designed-for but not laid out in this first pass.

---

## Index

| File | What lives here |
| --- | --- |
| `colors_and_type.css` | All design tokens: colors, type scale, spacing, radii, shadows, motion. Import this first. |
| `assets/` | Logo, mark, icons-sample sheet, brand glyphs. |
| `preview/` | Cards for the Design System tab — one concept per card. |
| `ui_kits/v21-app/` | The product UI kit: chronological feed, daily-note timeline, composer, command palette, sidebar, open-questions inbox. |
| `SKILL.md` | Cross-compatible skill manifest. |

---

## Brand fundamentals

### Name & tone

The product name is **v21** — version 21, lowercase, no period. It's named after a tradition of personal note systems that keep getting rebuilt: this is the twenty-first attempt. The name implies *durable, opinionated, allergic to fluff* — it has been around long enough to know what it isn't.

The product surface uses lowercase liberally: **v21**, *daily note*, *open questions*, *trajectory*. Title Case appears only on proper nouns (a user's note title) and on legal/marketing chrome. Sentence case is the default for buttons, menu items, section headers.

### Voice

| Trait | What we mean | Example |
| --- | --- | --- |
| **Direct, low-affect** | We say what a thing is. No hype, no marketing verbs ("unlock," "supercharge"). | "Add a question" — not "✨ Capture a new thought!" |
| **Second-person, never first-person plural** | The system is *yours*. We don't say "we" — there is no "we." | "you have 3 open questions" — not "we found 3 questions for you" |
| **Quiet, present tense, no exclamation** | Status lines are flat statements. | "no questions older than a week. nice." (no "!") |
| **Math-literate, not math-cute** | We use LaTeX where math belongs and avoid math emoji or 🧠 / 💡 / 🚀. | A theorem block is `#theorem`, not `📜 Theorem`. |
| **Honest about uncertainty** | Status words name epistemic state without softening: `wtf`, `gap`, `seedling`, `confident`, `settled`, `parked`. | The placeholder for an unresolved tension is "you haven't sorted this out yet." |

### Copy patterns (specific examples)

- **Empty state**, daily note: *"nothing yet today. start anywhere."*
- **Empty state**, open questions: *"no open questions. either you've answered them all, or you haven't asked any."*
- **Confirmation toast**: *"marked confident."* (no exclamation, no checkmark icon — the toast itself confirms)
- **Beginner-mind question flag**: *"first-pass question — don't lose this."*
- **Weekly digest subject line**: *"the week of jan 8 — 12 questions opened, 4 answered."*
- **404-equivalent**: *"this block was deleted. its references still point here."*

### Emoji & decoration

- **No product emoji.** The product never adds 🧠 / 📝 / ✨ / 🔥 on its own surface.
- **User content is yours** — if a user writes an emoji in their own note, it renders.
- **Unicode symbols are fair game for system glyphs**: → ← · ↑ ↓ ⌘ ⌥ ⇧ ⌫ ≈ ∴ ∎ ∞. These are typographic primitives, not decoration.

---

## Visual foundations

### Color philosophy

The palette is **two-tier**:

1. **A near-monochrome neutral scale** doing 90 % of the work — pure white canvas, hairline borders at `#E6E6E6`, body text at `#1E1E1E` (Figma's signature near-black, never `#000`). Backgrounds are flat. There are no gradients on the product surface.
2. **One accent — Figma blue `#0D99FF`** — used for selection, focus rings, the sole "active link" treatment, and the unread-bubble dot. Nothing else is blue.

On top of that, a **semantic scale** of small color chips:

- **status colors** (wtf / gap / seedling / working / confident / settled / parked) — applied only as a 6-px chip or pill, never as a background fill of a whole block.
- **thought-type colors** — Question = amber `#F5A623`, Claim = neutral, Source = violet `#8E4EC6`, Beginner-mind = pink `#EC4899`. Same rule: chips and edge accents only.

**Color is metadata, not decoration.** A red note is not stylistically red — it is `status=wtf`. If you find yourself reaching for a color for "visual variety," delete it.

### Type

- **Sans**: Geist (300 / 400 / 500 / 600 / 700) — primary UI, body, headings.
- **Mono**: Geist Mono (400 / 500 / 600) — math, code, file paths, IDs, key caps.
- **Serif**: Newsreader (italic + roman) — used *only* for editorial moments: a Question prompt (`.t-prompt`), a beginner-mind question, a block quote, the weekly digest's lead sentence.

Body sits at **14 px** — compact app density (Figma, Linear, Tana). Reading-heavy surfaces (the editor, the digest) bump up to 16 px. The display scale tops out at 48 px and is reserved for empty-state hero copy and the weekly digest header.

**Substitution flag:** Geist and Newsreader are loaded from Google Fonts at runtime. If the user prefers a different sans, swap `--font-sans` in `colors_and_type.css`; the rest of the system follows.

### Spacing & rhythm

A **4-pt grid** all the way through. The note feed lives on an **8-pt vertical rhythm** between blocks within a day and **24-pt** between day-group separators. Sidebar items are 28-px tall; topbar is 44-px. Cards have 16-px internal padding; modals 24-px.

### Borders, dividers, hairlines

- **Hairlines** (`#E6E6E6`) at 1 px do the work that elevation does in other systems. Every panel boundary, every row separator, every input border starts as a hairline.
- **Borders** (`#D9D9D9`) for inputs and buttons.
- **No double-borders, no inner shadows.** If a thing needs to feel deeper, indent it with whitespace, not with bevels.

### Shadows & elevation

- The product surface is **almost flat**. Sidebars, panels, and the topbar separate via hairline only.
- **Real elevation** appears in exactly three places: the **floating quick-capture window** (`--shadow-2`), the **command palette** (`--shadow-3`), and **menus / tooltips** (`--shadow-2`). Nowhere else.
- Shadows are **soft and short** — no large blurry drop shadows.

### Corner radii

| Element | Radius |
| --- | --- |
| Tags, key caps, status chips | 2 px |
| Inputs, buttons | 4 px |
| Cards, list rows on hover | 6 px |
| Modals, large surfaces | 10 px |
| **Note bubble** (the chronological-feed unit) | 14 px |
| Avatars, pills | full |

The 14-px note bubble is the only "soft" shape in the system — a deliberate nod to Telegram's chat aesthetic. Everything else is sharp by Figma convention.

### Imagery

There is essentially **no imagery** on the product surface. v21 is a writing tool — the brand vibe is paper, not photography. The marketing surface (separate from this kit) may use:

- Crisp, slightly-warm screenshots of the product itself (the canvas is a slight off-white `#FAFAFA` rather than pure white — this is on purpose).
- One brand glyph (`assets/logo-mark.svg`) — a black tile with a Geist "v" and a single blue dot.

If you must use a photograph in a slide, **desaturate to ~30 %** and crop tight. No gradients, no glow overlays.

### Backgrounds

Pure flat color. No textures, no patterns, no noise, no gradients. The single exception: the **app-level canvas** uses `#FAFAFA` against pure-white panels to create a calmer reading background; the cumulative contrast remains low.

### Animation & motion

- **Default duration:** 140 ms (`--dur-2`), `ease-out` curve.
- **What animates:** hover transitions on rows and buttons (opacity / background); panel slides; toast in/out; status-chip color shift.
- **What does not animate:** content (note text doesn't fade in), the typing cursor (it just blinks), the timeline scroll (no smooth-scroll on jump).
- **No bounce, no spring, no parallax.** The system is calm. The single playful moment is the focus-ring "ping" on `cmd-K` opening — a 220-ms scale from 0.96 → 1.0 with opacity 0 → 1.

### Hover / press / focus / selected

| State | Treatment |
| --- | --- |
| Hover (row) | `background: var(--bg-2)` (no border change) |
| Hover (button-primary) | `background: var(--accent-hover)` |
| Press | `background: var(--accent-press)`, **no scale change** |
| Focus | `box-shadow: var(--shadow-focus)` (2-px halo in accent tint + 1-px accent ring) — never `outline` |
| Selected (row) | `background: var(--bg-3)`, plus a 2-px accent rail on the left edge |
| Disabled | text/icon → `var(--fg-4)`, no hover, `cursor: not-allowed` |

### Transparency & blur

Used **once**: when the command palette is open, the rest of the app dims to 60 % opacity behind a 4-px backdrop blur. Tooltips are opaque. Sidebars are opaque. There is no "frosted glass" anywhere else.

### Layout rules

- **Fixed:** topbar (44 px, always pinned), left sidebar (248 px collapsible to 56 px), right pane (320 px toggleable, hidden by default).
- **Fluid:** the center column — fills available space, with a comfortable **max-width of 720 px** for the daily-note feed (reading column) and **full-width** in canvas/synthesis surfaces.
- **Density:** the feed is compact but never cramped. Bubble vertical padding is 10 px; gap between bubbles within a day is 6 px; gap between day-groups is 24 px.

### Cards

A v21 "card" is **a hairline-bordered rectangle**, 6-px radius, white fill, 16-px padding, no shadow. It elevates only on hover (a 1-px shadow appears). The **note bubble** is *not* a card — it's a 14-px rounded surface with no border in the feed (it lives directly on the canvas background).

---

## Iconography

- **Icon library:** **Lucide** (CDN: `https://unpkg.com/lucide@latest/dist/umd/lucide.js`). Lucide's geometric, 1.5-px-stroked, 24-px-base icons match Geist's drafting feel and Figma's icon vocabulary.
- **Stroke weight:** 1.5 px at 16/20 px; 1.75 px at 14 px sizes.
- **Color:** icons inherit `currentColor` and default to `--fg-2` (secondary) — they are quiet. Status-bearing icons (the unread dot, the focus ring) get accent.
- **Sizes:** 14, 16, 20 px. Never larger than 20 in product chrome — large icons feel like marketing.
- **No icon-only buttons without a tooltip.** Every icon-only control has a `title=` and a labeled aria attribute.

There is no built-in icon font; the UI kit links Lucide directly. If you need an icon Lucide doesn't have, **do not freehand an SVG** — pick the closest Lucide neighbor or note the gap. A handful of essential icons (logo mark, the v21 wordmark) are vendored into `assets/`.

**Unicode glyphs** are used as system marks (key caps `⌘ ⌥ ⇧`, math `≈ ∴ ∎`, arrows `→ ←`). They are typeset in Geist Mono inside a key-cap shape; the keycap rectangle is `--r-1` (2 px) with a `--bg-2` fill.

---

## How to use

1. Link `colors_and_type.css` from the `<head>` of any artifact.
2. Wrap your design in a root with the `v21` class for clarity (optional — globals apply already).
3. Pull from the components in `ui_kits/v21-app/` rather than hand-rolling buttons.
4. If you can't find a token for a need, **stop**. It probably doesn't belong in the system yet — flag it and ask.

---

## APPENDIX: design brief

The full design brief (a position document defending the data model, UI/UX choices, and shipping plan) lives in the chat that produced this system. Key invariants extracted from it that shape this design:

- **Blocks are primitive**, pages are aggregators, **supertags are opt-in types**.
- **Three thought types only**: Question, Claim, Source.
- **Three tag fields**: Topic (multi, hierarchical), Status (single, enumerated, mutable), Action (multi, with lifecycle).
- **Six typed edges**: supports, contradicts, prerequisite-of, generalizes/specializes, analogous-to, addresses.
- **Capture cost ≤ 1.5 seconds**, no classification required at capture time.
- **Daily-note landing**, not topic-first.
- **No push notifications, no streaks, no gamification.**
- **AI is on-demand and side-panel**, never inline autocomplete.

These rules are the design's bones. Tokens above were chosen to *make those rules feel right* — not to add visual richness for its own sake.
