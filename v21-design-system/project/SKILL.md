---
name: v21-design
description: Use this skill to generate well-branded interfaces and assets for v21 — a personal note-taking app for technical material with a Figma-clean palette and a Telegram-like chronological view of notes. Contains tokens (color/type/spacing/shadow/radii), brand assets (logo, mark), and a UI kit with sidebar / topbar / chronological feed / composer / command palette / right pane. Suitable for production prototypes, throwaway mocks, or slides.
user-invocable: true
---

# v21 — design skill

You are designing for **v21**, a personal note-taking app for math/technical material. The v0 surface is a daily-note landing with a chronological feed of "blocks" (Question / Claim / Source / plain paragraphs) — Telegram-style chat-bubble rhythm on a Figma-clean neutral canvas.

## What to read first

1. `README.md` — full design intent: tone, voice, visual foundations, iconography, and the brief invariants (data model, three thought types, six edges, three tag fields).
2. `colors_and_type.css` — every token. Import this in any artifact.
3. `ui_kits/v21-app/` — React components for the main shell. `index.html` is a runnable example; the JSX files are small, reusable, and meant to be copied wholesale rather than imported.

## Rules of the system (non-negotiable)

- **Neutral palette + one accent.** Figma blue `#0D99FF` is the only branded hue. Status and thought-type colors are metadata, not decoration.
- **Type:** Geist (sans), Geist Mono (math/code), Newsreader italic (editorial — Questions, beginner-mind prompts, digest leads). Body = 14 px.
- **No emoji**, no exclamation marks, no streaks/gamification, no inline AI autocomplete, no push notifications. Voice is direct, lowercase, second-person, present tense.
- **Shapes:** sharp by default (`r-2`/`r-3`). The note bubble is the only soft shape (`r-5 = 14 px`).
- **Elevation is rare.** Real shadow only on the floating composer, the palette, and menus. Everything else separates via hairlines (`#E6E6E6`).
- **Capture cost is sacred.** No classification required at capture; Q/C/S promotion is opt-in, single-keystroke.
- **Daily-note landing**, not topic-first. No folder tree.

## How to use this skill

### For visual artifacts (slides, mocks, throwaway HTML)

- Copy `colors_and_type.css` and `assets/` into the artifact's folder; link the CSS from `<head>`.
- For UI mocks, copy components out of `ui_kits/v21-app/` and trim. The JSX is plain React 18 + inline styles — drop the `<script type="text/babel">` setup in your HTML and you're done.
- For icons, use **Lucide via CDN** (already pattern in the kit). Don't hand-roll SVGs. If Lucide is missing an icon you need, pick the closest neighbor and flag the substitution.
- Use the sample math content as a tonal reference for new copy — keep it lowercase, present tense, and free of marketing verbs.

### For production code

- The tokens are the source of truth. Map them into your styling system (CSS variables, design-tokens lib, or Tailwind theme extension) rather than re-deriving values.
- The components in `ui_kits/v21-app/` are cosmetic recreations, not production-ready — they hard-code sample data and skip a11y polish (no focus-trapping in the palette, no aria-live on toasts). Treat them as a visual reference.

### If invoked with no other guidance

Ask the user what they want to build:

1. A new screen in the product? (likely answers: open-questions inbox, trajectory timeline, weekly digest, canvas, tablet-ink reader, AI side-panel actions)
2. A slide deck or one-pager about v21?
3. A non-product artifact (changelog, release note, a how-it-works explainer) using v21 type/color?

Then ask follow-ups appropriate to that artifact (audience, length, surfaces in scope, must-include screens), and produce HTML.

## Things to flag back to the user

- Geist and Newsreader are loaded from Google Fonts at runtime. If they want a custom self-hosted version, ask for the woff2 files.
- The icon set is Lucide via CDN. If the user wants a proprietary set, ask for the SVG sprite.
- Anything outside the v0 chronological view (canvas, tablet ink, trajectory dashboards) doesn't yet have a component — these are designed-for in the README but not built.
