# v21 UI Kit — chronological feed

The product surface for v0 of v21: a daily-note landing with a Telegram-style chronological feed of blocks.

## What's in here

| File | What it is |
| --- | --- |
| `index.html` | Entrypoint — wires everything together. Open this. |
| `primitives.jsx` | `<Icon>`, `<Btn>`, `<IconBtn>`, `<KBD>`, `<StatusChip>`, `<TopicTag>`, `<EdgePill>`, `<TypeRail>` — the smallest reusable pieces. |
| `sidebar.jsx` | Left nav: today, pinned, saved searches, supertag explorer. Not a folder tree. |
| `topbar.jsx` | Top bar: breadcrumb, ⌘K affordance, right-pane toggle. |
| `feed.jsx` | The chronological feed: day separators, `<NoteBubble>`, `<ProseBlock>`. |
| `composer.jsx` | Sticky-bottom composer with Q/C/S keystroke promotion. |
| `right-pane.jsx` | Backlinks / edges / AI side panel — hidden by default in real use. |
| `command-palette.jsx` | ⌘K palette — capture, jump, run query, run AI. |
| `app.jsx` | Sample data + state + keyboard handling. |

## Interactions to try

- **⌘K** — open the palette
- **Q / C / S** — press while the composer is focused and empty to promote the next entry to Question / Claim / Source
- **↵** — capture (Enter)
- **Esc** — close palette / drop back to paragraph mode
- Hover any bubble — action bar floats above it
- Each block tagged with `status`, `topics`, and optional `edges` — visible inline as small chips

## Things this kit deliberately doesn't ship yet

These are designed-for in the brief but out of scope for the v0 chronological view:

- Canvas / spatial synthesis surface
- Tablet-ink-first PDF reader
- Trajectory timeline per topic
- Open-questions inbox as a full view (the sidebar entry exists; the screen is not implemented)
- Tension surface
- Weekly digest screen
- AI side-panel actions actually wired to LLM calls

Each of these is a separate screen the kit should grow into.

## Design width

Designed for **1440 px** desktop. The shell will compress reasonably down to ~1100 px (right pane hides naturally below ~1024 px in a real build). At narrower widths things will look tight — the kit is not responsive-mobile.
